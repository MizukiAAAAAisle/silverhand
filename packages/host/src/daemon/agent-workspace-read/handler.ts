import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentWorkspaceDto,
  AgentWorkspaceFilePreview,
  AgentWorkspaceNote,
} from '@silverhand/shared';
import type {
  AgentWorkspaceReadErrorCode,
  AgentWorkspaceReadParams,
  AgentWorkspaceReadResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import { computeAgentDir } from '../agent-materialize/index.js';

/**
 * D4.e-2 daemon handler for `agent_workspace_read` — the host-local read
 * counterpart of the D4.e-1 data-plane intents.
 *
 * `GET /api/agents/:id/workspace` used to read the agent's L1 dir off the
 * BACKEND disk (and 503'd in standalone, where that dir lives on another
 * machine). This handler moves the read to the daemon: it resolves the
 * agent-home L1 dir from the daemon's OWN homedir (`computeAgentDir`) — the
 * backend never sends a path — and assembles the same `AgentWorkspaceDto`
 * the route used to build locally. That keeps the daemon the sole authority
 * for host-local paths (I1) and removes this fs touch-point from backend
 * src (I6).
 *
 * Scope is narrow (Cindy D4.e-2): L1/agent-home read only. A missing
 * per-file (brand-new agent) is a graceful `null` preview / empty notes —
 * NOT an error — matching the pre-D4.e behavior. A HARD fs failure
 * (perm/IO) fails closed as `fs_unavailable`; the daemon never falls back
 * to a server-side path.
 */

const MAX_PREVIEW_BYTES = 64 * 1024;

export class AgentWorkspaceReadError extends DaemonTypedError {
  constructor(
    readonly code: AgentWorkspaceReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWorkspaceReadError';
  }
}

export interface ReadAgentWorkspaceDeps {
  /** Parent dir for agent-home resolution. Default: daemon's homedir(). */
  homeDir?: string;
}

/**
 * The ONLY fs errnos that mean "this path legitimately isn't here yet" —
 * a brand-new agent has no L1 files, and an agent with no notes has no
 * `notes/` dir. Every OTHER errno (EACCES/EPERM/EIO/EROFS/ENOSPC/…) is a
 * HARD host-local failure that MUST fail closed as `fs_unavailable`, not
 * silently degrade to a `null` preview / empty notes (which would surface
 * as a misleading 200). Cindy D4.e-2 P1.
 */
function isGracefulMissing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Read a UTF-8 text file with a hard size cap. Returns null only when the
 *  file is genuinely absent (ENOENT/ENOTDIR — the agent's L1 dir is seeded
 *  lazily, so a brand-new agent may not have these files yet). Any HARD fs
 *  error (perm/IO) at either the stat or read stage propagates to the
 *  caller, which maps it to a typed `fs_unavailable`. */
async function readFilePreview(
  path: string,
): Promise<AgentWorkspaceFilePreview | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if (isGracefulMissing(err)) return null;
    throw err;
  }
  if (!stat.isFile()) return null;
  const buf = await fs.readFile(path);
  const truncated = buf.byteLength > MAX_PREVIEW_BYTES;
  const content = truncated
    ? buf.subarray(0, MAX_PREVIEW_BYTES).toString('utf8') +
      '\n\n… (truncated; open in Finder for full content)'
    : buf.toString('utf8');
  return {
    path,
    size: stat.size,
    mtime: stat.mtimeMs,
    content,
    truncated,
  };
}

async function listNotes(notesDir: string): Promise<AgentWorkspaceNote[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(notesDir, { withFileTypes: true });
  } catch (err) {
    // No notes dir yet (ENOENT/ENOTDIR) → empty. A hard readdir failure
    // (e.g. EACCES on the dir) fails closed, NOT empty notes.
    if (isGracefulMissing(err)) return [];
    throw err;
  }
  const out: AgentWorkspaceNote[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    const full = join(notesDir, e.name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch (err) {
      // A file readdir saw but stat can't find = a delete race: skip it.
      // A HARD stat error (perm/IO) on a listed file fails closed.
      if (isGracefulMissing(err)) continue;
      throw err;
    }
    out.push({ name: e.name, size: stat.size, mtime: stat.mtimeMs });
  }
  // Newest first — matches how a user actually scans notes ("what did I
  // jot down recently"). Same-ms files get a stable name-based tiebreak.
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out;
}

export async function readAgentWorkspace(
  params: AgentWorkspaceReadParams,
  deps: ReadAgentWorkspaceDeps = {},
): Promise<AgentWorkspaceReadResult> {
  // Daemon owns the path: resolve the agent-home L1 dir from the daemon's
  // own homedir. The backend supplied only `agent_id`.
  const dir = computeAgentDir(params.agent_id, deps.homeDir);
  try {
    const [system_prompt, memory, notes] = await Promise.all([
      readFilePreview(join(dir, 'system_prompt.md')),
      readFilePreview(join(dir, 'MEMORY.md')),
      listNotes(join(dir, 'notes')),
    ]);
    const workspace: AgentWorkspaceDto = {
      l1_path: dir,
      system_prompt,
      memory,
      notes,
    };
    return { ok: true, workspace };
  } catch (err) {
    throw toReadError(err);
  }
}

/**
 * Project a read failure to a typed code. A Node fs error carries a string
 * `code` (EACCES/EPERM/EROFS/EIO/ENOSPC/…) → `fs_unavailable` (a
 * recoverable host-local condition the route surfaces as 503).
 * ENOENT/ENOTDIR do not reach here (genuinely-missing paths are handled
 * gracefully above as `null` preview / skipped note / empty notes).
 * Anything else is a logic bug → `internal_error`.
 */
function toReadError(err: unknown): AgentWorkspaceReadError {
  if (err instanceof AgentWorkspaceReadError) return err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return new AgentWorkspaceReadError(
      'fs_unavailable',
      err instanceof Error ? err.message : String(err),
    );
  }
  return new AgentWorkspaceReadError(
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}
