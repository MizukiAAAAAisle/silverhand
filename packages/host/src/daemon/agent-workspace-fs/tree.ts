import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentWorkspaceTreeNode,
} from '@silverhand/shared';
import type {
  AgentWorkspaceTreeParams,
  AgentWorkspaceTreeResult,
} from '../../protocol.js';
import { AgentWorkspaceFsError } from './error.js';
import {
  isAllowedSegmentName,
  resolveAgentHomeBase,
} from './parse-virtual-path.js';
import {
  resolveAgentWorkspaceBaseDir,
  type ResolveAgentWorkspaceBaseDeps,
} from './source.js';

/**
 * Daemon handler for `agent_workspace_tree` (#task:811).
 *
 * Walks the agent home directory recursively and returns a flat list of
 * every visible entry, **emitted in tree preorder** — each directory is
 * immediately followed by its descendants, then the next sibling. Within
 * a single parent dir, directories sort before files and entries sort
 * alphabetically by name within each kind. The renderer reconstructs
 * indentation purely from `path` segment count, but it consumes `nodes`
 * in iteration order — so a global flat sort would put deep descendants
 * after every same-level sibling and break the visual layout
 * (Cindy round-1 P2). Hidden entries (anything starting with `.`),
 * dirent names that fail `isAllowedSegmentName` (NUL or `\\`), and
 * symlinks (intermediate or leaf) are filtered server-side; the
 * segment-name gate is shared with the read endpoint's path parser
 * so any tree node `path` can be fed back to `agent_workspace_file_read`
 * without being refused (Cindy round-2 P1). The agent home dir itself
 * is also lstat-checked: a symlink there is `forbidden_path`, never
 * silently followed (Cindy round-1 P1 #2; shared with
 * `parseAndResolveVirtualPath`). A brand-new agent with no L1 files
 * yet returns `{ nodes: [] }` — graceful, not an error.
 *
 * Hard fs failures (perm/IO/EROFS) propagate as `fs_unavailable`. The
 * daemon never falls back to a server-side path: the caller (backend
 * route) projects `fs_unavailable` as HTTP 503 so the renderer surfaces
 * a transient banner instead of a misleading "no files found" empty
 * state.
 */
export interface ListAgentWorkspaceTreeDeps
  extends ResolveAgentWorkspaceBaseDeps {}

const MAX_NODES = 5000;

export async function listAgentWorkspaceTree(
  params: AgentWorkspaceTreeParams,
  deps: ListAgentWorkspaceTreeDeps = {},
): Promise<AgentWorkspaceTreeResult> {
  const baseDir = resolveAgentWorkspaceBaseDir(params, deps);
  const nodes: AgentWorkspaceTreeNode[] = [];
  try {
    const base = await resolveAgentHomeBase(baseDir);
    if (!base.ok) {
      if (base.code === 'not_found') {
        // The agent home dir might not exist yet (brand-new agent before
        // L3a/L3b run). Treat that as an empty tree — a misleading 200
        // with no nodes is still better than a 503 the renderer can't
        // act on.
        return { ok: true, tree: { nodes: [] } };
      }
      // base.code === 'forbidden_path' — root is a symlink. Refuse with
      // the same code/projection the read endpoint uses for any other
      // symlink in the chain.
      throw new AgentWorkspaceFsError(
        'forbidden_path',
        'agent home dir is not a readable directory',
      );
    }
    await walkDir(base.realBase, base.realBase, nodes);
    return { ok: true, tree: { nodes } };
  } catch (err) {
    throw toFsError(err);
  }
}

async function walkDir(
  baseDir: string,
  current: string,
  out: AgentWorkspaceTreeNode[],
): Promise<void> {
  if (out.length >= MAX_NODES) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (err) {
    // A graceful missing dir at the root was caught above; a graceful
    // missing dir mid-walk is a delete-during-walk race — skip it.
    if (isGracefulMissing(err)) return;
    throw err;
  }
  // Local sort within this directory: dirs before files, alpha within
  // each kind. The recursive push below produces tree preorder.
  const sorted = entries.slice().sort(compareEntries);
  for (const e of sorted) {
    if (out.length >= MAX_NODES) return;
    // Single-segment validator shared with the read endpoint's path
    // shape parser. Subsumes the dotfile filter and additionally
    // refuses NUL/backslash in `Dirent.name` — without this gate, a
    // POSIX file literally named `foo\bar.md` would be emitted as
    // virtual path `foo/bar.md` (after the `\` → `/` normalize below),
    // which (a) doesn't round-trip through the read endpoint (parser
    // rejects `\\`), and (b) collides with a real `foo/bar.md`
    // sibling. Skipping here preserves the wire contract that any
    // tree node `path` is feedable to `agent_workspace_file_read`
    // (Cindy round-2 P1).
    if (!isAllowedSegmentName(e.name)) continue;
    // We rely on `withFileTypes: true` returning a dirent that is
    // already lstat-equivalent: `isSymbolicLink()` here reflects the
    // entry on disk (no follow). Refuse symlinks unconditionally.
    if (e.isSymbolicLink()) continue;
    const fullPath = join(current, e.name);
    const relPath = relativeFromBase(baseDir, fullPath);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(fullPath);
    } catch (err) {
      // delete-during-walk race
      if (isGracefulMissing(err)) continue;
      throw err;
    }
    if (stat.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      out.push({
        path: relPath,
        kind: 'directory',
        size: 0,
        mtime: stat.mtimeMs,
      });
      // Push descendants immediately after the dir entry (preorder).
      await walkDir(baseDir, fullPath, out);
    } else if (e.isFile()) {
      out.push({
        path: relPath,
        kind: 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
    // Anything else (block/char/fifo/socket): skip silently.
  }
}

/** Per-parent sort: directories before files, alphabetic within each
 *  kind. The result, combined with the recursive descendant push in
 *  `walkDir`, produces tree preorder. */
function compareEntries(
  a: import('node:fs').Dirent,
  b: import('node:fs').Dirent,
): number {
  const aDir = a.isDirectory();
  const bDir = b.isDirectory();
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Convert an absolute path under `baseDir` into the `/`-joined virtual
 * path the wire protocol uses. Built by stripping the base prefix +
 * leading separator, then converting native separators to `/`. The
 * caller passes in the prefix already realpath'd at the outer scope
 * for symlink-free comparison; we do the cheap string slice here
 * because everything mid-walk is already known to be inside the base.
 */
function relativeFromBase(baseDir: string, abs: string): string {
  const stripped = abs.startsWith(baseDir) ? abs.slice(baseDir.length) : abs;
  // Drop leading separator(s) and convert native sep to forward slash
  // for the wire format. `path.sep` is platform-specific but the
  // virtual path namespace is always `/`-joined.
  return stripped.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function isGracefulMissing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function toFsError(err: unknown): AgentWorkspaceFsError {
  if (err instanceof AgentWorkspaceFsError) return err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return new AgentWorkspaceFsError(
      'fs_unavailable',
      err instanceof Error ? err.message : String(err),
    );
  }
  return new AgentWorkspaceFsError(
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}
