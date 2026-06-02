import { promises as fs } from 'node:fs';
import type {
  AgentWorkspaceFileReadParams,
  AgentWorkspaceFileReadResult,
} from '../../protocol.js';
import { resolveAgentDir } from '../agent-materialize/index.js';
import { AgentWorkspaceFsError } from './error.js';
import { parseAndResolveVirtualPath } from './parse-virtual-path.js';

/**
 * Daemon handler for `agent_workspace_file_read` (#task:811).
 *
 * Reads a single file under the agent home dir by virtual path. The
 * helper does the security work (segment-shape parse, per-segment
 * lstat-walk to refuse symlinks intermediate or leaf, realpath
 * boundary check, root-symlink rejection); this function only adds the
 * "is it a file?" check and a hard 64KiB read cap.
 *
 * Resource bound: the read is bounded at the syscall layer — `open` +
 * a loop of `read(buf, offset, MAX+1-offset, offset)` calls that fills
 * the buffer up to MAX_PREVIEW_BYTES + 1 bytes or hits EOF. Truncation
 * (`truncated:true`) is decided by `lstat.size > MAX`, NOT by how many
 * bytes a single syscall returned; POSIX `read(2)` is allowed to
 * return short even on a regular file, so a single-shot `bytesRead >
 * MAX` check would mis-flag and risk slicing uninitialized
 * `allocUnsafe` memory into the preview (Cindy round-1 P1 #1 + round-2
 * P2). `size`/`mtime` come from the helper's leaf `lstat`, not a
 * re-stat.
 *
 * Surface contract:
 *  - `forbidden_path` — bad shape OR symlink in chain OR realpath
 *    escape. The route projects 400/403; the daemon never reveals
 *    which one it was on the wire.
 *  - `not_found` — graceful ENOENT/ENOTDIR along the walk OR the
 *    final entry is a directory (you can't read a dir as a file).
 *  - `fs_unavailable` — hard fs failure (perm/IO/EROFS); 503.
 *  - `internal_error` — anything else; 500.
 */
export interface ReadAgentWorkspaceFileDeps {
  /** Parent dir for agent-home resolution. Default: daemon's homedir. */
  homeDir?: string;
  /** Exact root for agent-home resolution. Takes precedence over homeDir. */
  agentHomeRootDir?: string;
}

const MAX_PREVIEW_BYTES = 64 * 1024;
const TRUNCATED_SUFFIX = '\n\n… (truncated; open in Finder for full content)';

export async function readAgentWorkspaceFile(
  params: AgentWorkspaceFileReadParams,
  deps: ReadAgentWorkspaceFileDeps = {},
): Promise<AgentWorkspaceFileReadResult> {
  const baseDir = resolveAgentDir(params.agent_id, deps);
  let resolved;
  try {
    resolved = await parseAndResolveVirtualPath(params.path, baseDir);
  } catch (err) {
    throw toFsError(err);
  }
  if (!resolved.ok) {
    throw new AgentWorkspaceFsError(
      resolved.code,
      resolved.code === 'forbidden_path'
        ? 'path is not a readable file under the agent home dir'
        : 'path not found',
    );
  }
  // The helper guarantees `resolved.lstat` is the lstat of the leaf
  // (and that it is NOT a symlink — symlinks short-circuit to
  // forbidden_path). Refuse directories here: a `not_found` is the
  // honest answer for "no readable file at this path".
  if (!resolved.lstat.isFile()) {
    throw new AgentWorkspaceFsError(
      'not_found',
      'path is not a regular file',
    );
  }
  // Bounded read: open + a loop of `read(buf, offset, …, offset)` calls
  // that fills the buffer up to MAX_PREVIEW_BYTES + 1 bytes (or hits
  // EOF), with `lstat.size` driving the truncation flag.
  // - The "+1" lets us still distinguish "exactly MAX bytes" from
  //   "more than MAX" without a follow-up read.
  // - We never call `fs.readFile` here: that would slurp the entire
  //   file into memory regardless of size, defeating the cap as a
  //   resource bound (the old implementation only truncated AFTER
  //   reading; Cindy round-1 P1 #1).
  // - POSIX `read(2)` is allowed to return SHORT — fewer bytes than
  //   requested even on a regular file (signal interrupt, partial
  //   page-cache, FUSE pacing). A single-shot `read` with a
  //   `bytesRead > MAX` check would mis-flag a multi-GB file as
  //   `truncated:false` and slice an under-filled buffer (whose tail
  //   is `Buffer.allocUnsafe` uninitialized memory). The loop +
  //   lstat-size truncation flag fixes both concerns (Cindy round-2
  //   P2): truncation is authoritative from on-disk size; the slice
  //   is bounded by the bytes we actually read.
  // - `size`/`mtime` come from the helper's lstat — re-stat'ing here
  //   would be another syscall for no benefit since the lstat already
  //   raced any concurrent writer.
  const buf = Buffer.allocUnsafe(MAX_PREVIEW_BYTES + 1);
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fs.open(resolved.real, 'r');
  } catch (err) {
    throw toFsError(err);
  }
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_PREVIEW_BYTES + 1) {
      const remaining = MAX_PREVIEW_BYTES + 1 - bytesRead;
      const r = await handle.read(buf, bytesRead, remaining, bytesRead);
      if (r.bytesRead === 0) break; // EOF
      bytesRead += r.bytesRead;
    }
  } catch (err) {
    await handle.close().catch(() => {});
    throw toFsError(err);
  }
  await handle.close().catch(() => {});
  // Truncation is determined by ON-DISK size, not how many bytes we
  // managed to read. A short-read run that returned fewer than MAX
  // bytes on a >MAX file must still flag `truncated:true` and only
  // slice the bytes we actually read (preventing uninitialized
  // `allocUnsafe` memory from leaking into the preview).
  const truncated = resolved.lstat.size > MAX_PREVIEW_BYTES;
  const previewLen = Math.min(bytesRead, MAX_PREVIEW_BYTES);
  const content = truncated
    ? buf.subarray(0, previewLen).toString('utf8') + TRUNCATED_SUFFIX
    : buf.subarray(0, bytesRead).toString('utf8');
  return {
    ok: true,
    file: {
      path: params.path,
      content,
      size: resolved.lstat.size,
      mtime: resolved.lstat.mtimeMs,
      truncated,
    },
  };
}

function toFsError(err: unknown): AgentWorkspaceFsError {
  if (err instanceof AgentWorkspaceFsError) return err;
  const code = (err as { code?: unknown })?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new AgentWorkspaceFsError('not_found', 'path not found');
  }
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
