import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentL2SeedErrorCode,
  AgentL2SeedParams,
  AgentL2SeedResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { getAgentL2Template, resolveAgentWorkspaceBundleDir } from '../agent-materialize/index.js';
import { WorkspaceRegistry, WorkspaceRegistryError } from './registry.js';

/**
 * D4.e-3 daemon handler for `agent_l2_seed` — seeds a member agent's L2
 * (per-workspace) memory dir on the OWNING host. Replaces backend
 * `seedAgentL2` (gap G1): the backend forwards only `{ agent_id,
 * workspace_id, template_choice }`, the daemon uses its registry only as the
 * establishment gate (fail-closed when the workspace was never realized here)
 * and writes the agent-centric bundle root
 * `<agent home>/workspaces/<workspace_id>/{MEMORY.md, notes/…}`
 * (relocation-v1 §3.2/§7 task 1) — no `<workspace>/.silverhand/...` sub-path.
 *
 * Regular-only: agent-home L2 == L1 and is already materialized by
 * `agent_materialize`, so it is never seeded here. The handler does NOT
 * take a `kind` — it relies on `registry.resolve` as the establishment gate,
 * which only knows regular bindings; an agent-home id has no binding →
 * fail-closed `workspace_not_provisioned` (the backend never sends a path
 * or kind).
 *
 * `system_prompt.md` is L1-only and is NEVER written to L2
 * ({@link getAgentL2Template} drops it). Idempotent: existing files are
 * preserved (agent edits survive a re-seed), never overwritten.
 */

export class AgentL2SeedError extends DaemonTypedError {
  constructor(
    readonly code: AgentL2SeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentL2SeedError';
  }
}

export interface SeedAgentL2Deps {
  registry: WorkspaceRegistry;
  /** Parent dir for the agent-centric bundle root. Default: daemon's homedir. */
  homeDir?: string;
  /** Exact agent-home root. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

export async function seedAgentL2(
  params: AgentL2SeedParams,
  deps: SeedAgentL2Deps,
): Promise<AgentL2SeedResult> {
  const template = getAgentL2Template(params.template_choice);
  if (template == null) {
    throw new AgentL2SeedError(
      'unsupported_template',
      `template '${params.template_choice}' has no host-side L2 entry`,
    );
  }

  // Establishment gate (relocation-v1 §7 task 1): the registry must still
  // throw fail-closed when this workspace was never realized on this computer
  // (regular-only — an agent-home id has no binding → `not_provisioned`). Its
  // returned old-shared path is no longer used; the L2 dir is now the
  // deterministic agent-centric bundle root. Registry demotion is §7 task 4.
  try {
    deps.registry.resolve(params.workspace_id);
  } catch (err) {
    if (err instanceof WorkspaceRegistryError) {
      if (err.code === 'not_provisioned') {
        throw new AgentL2SeedError(
          'workspace_not_provisioned',
          `workspace ${params.workspace_id} is not provisioned; cannot seed L2`,
        );
      }
      if (err.code === 'registry_foreign' ||
        err.code === 'registry_corrupt' ||
        // relocation-v1 §7 task 1 — an unsafe id segment is a corrupt/unusable
        // registry entry; fail closed before it reaches the L2 path resolver.
        err.code === 'invalid_path') {
        throw new AgentL2SeedError('registry_unavailable', err.message);
      }
    }
    throw new AgentL2SeedError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
  const l2Dir = resolveAgentWorkspaceBundleDir(
    params.agent_id,
    params.workspace_id,
    deps,
  );
  try {
    let seeded = false;
    await fs.mkdir(l2Dir, { recursive: true });
    for (const dir of template.dirs) {
      await fs.mkdir(join(l2Dir, dir), { recursive: true });
    }
    for (const file of template.files) {
      const wrote = await writeIfMissing(
        join(l2Dir, file.relPath),
        file.content,
      );
      seeded = seeded || wrote;
    }
    // Sanity: MEMORY.md must be present after a successful seed.
    const l2_present = await exists(join(l2Dir, 'MEMORY.md'));
    return { ok: true, seeded, l2_present };
  } catch (err) {
    throw toSeedError(err);
  }
}

/** Write `content` to `path` only when the file does not already exist —
 *  preserving any prior content (agent edits). Returns true when a new
 *  file was written, false when the path already existed. */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await fs.access(path);
    return false;
  } catch {
    // Not present (or unreadable) → attempt the write; a hard write error
    // propagates to the caller as fs_unavailable.
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content);
    return true;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Project an fs failure to a typed code. A Node fs error carries a string
 * `code` (EACCES/EPERM/EROFS/EIO/ENOSPC/…) → `fs_unavailable`; anything
 * else is a logic bug → `internal_error`.
 */
function toSeedError(err: unknown): AgentL2SeedError {
  if (err instanceof AgentL2SeedError) return err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return new AgentL2SeedError(
      'fs_unavailable',
      err instanceof Error ? err.message : String(err),
    );
  }
  return new AgentL2SeedError(
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}
