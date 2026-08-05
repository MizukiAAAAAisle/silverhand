import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import type {
  AgentL2SeedErrorCode,
  AgentL2SeedParams,
  AgentL2SeedResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import {
  bundleL2Present,
  getAgentL2Template,
  resolveAgentWorkspaceBundleDir,
} from '../agent-materialize/index.js';
import { WorkspaceIdSegmentError } from '../workspace-path-authority.js';

/**
 * D4.e-3 daemon handler for `agent_l2_seed` — materializes a member agent's L2
 * (per-workspace) memory bundle on THIS agent's own computer. The backend
 * forwards only `{ agent_id, workspace_id, template_choice }`; the daemon
 * writes the deterministic agent-centric bundle root
 * `<agent home>/workspaces/<workspace_id>/{MEMORY.md, notes/…}`
 * (relocation-v1 §3.2/§3.3) — no `<workspace>/.silverhand/...` sub-path.
 *
 * relocation-v1 §7 task 4 — there is no registry establishment gate any more:
 * seeding IS what makes the deterministic coordinate available, so it fails
 * closed only on the fs, never on a registry binding. It is the write half of
 * the coordinate-vs-availability split — its success is reported as
 * `l2_present` via the shared {@link bundleL2Present} predicate, the SAME fact
 * the read-side resolvers (list index / runtime memory index) check.
 *
 * Regular-only: an agent-home id has L2 == L1 and is already materialized by
 * `agent_materialize`, so it is never seeded here. The handler rejects an
 * agent-home id structurally (the backend never sends one) rather than
 * creating a spurious `workspaces/<agent-home-id>` bundle.
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
  /**
   * The EXACT agents root the agent-centric bundle root joins onto, from
   * the composition root. Required — no implicit default (#task:1813).
   */
  agentHomeRootDir: string;
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

  // Agent-home ids never carry an L2 bundle here (L2 == L1, materialized by
  // agent_materialize). The backend never sends one; refuse rather than seed a
  // spurious `workspaces/<agent-home-id>` dir.
  if (isAgentHomeWorkspaceId(params.workspace_id, params.agent_id)) {
    throw new AgentL2SeedError(
      'internal_error',
      `agent_l2_seed received an agent-home workspace id ${params.workspace_id}; ` +
        'agent-home L2 is the L1 home and is materialized by agent_materialize',
    );
  }

  let l2Dir: string;
  try {
    l2Dir = resolveAgentWorkspaceBundleDir(
      params.agent_id,
      params.workspace_id,
      deps,
    );
  } catch (err) {
    // An unsafe id segment can never become a path segment under the agent
    // home — fail closed before touching disk.
    if (err instanceof WorkspaceIdSegmentError) {
      throw new AgentL2SeedError('registry_unavailable', err.message);
    }
    throw new AgentL2SeedError(
      'internal_error',
      err instanceof Error ? err.message : String(err),
    );
  }
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
    // Report the completion fact via the shared predicate — the SAME one the
    // read-side resolvers use for availability, so ack and availability agree
    // by construction (a half-seed with no MEMORY.md is never `l2_present`).
    const l2_present = await bundleL2Present(l2Dir);
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
