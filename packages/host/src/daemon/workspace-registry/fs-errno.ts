/**
 * Shared fs-errno → typed-code classifier for the workspace-registry
 * handlers. `workspace_provision` persists the registry file (mkdir/
 * write/rename) and creates the workspace skeleton, so both stages can
 * throw raw syscall errno that must map to the SAME recoverable typed
 * codes rather than being black-holed into `internal_error` (Cindy
 * D4.e-1 P1-1). One table.
 *
 *   - ENOSPC / EDQUOT                            → fs_quota_exceeded
 *   - EACCES / EPERM / EROFS / ENOENT / ENOTDIR / EEXIST → fs_unavailable
 *   - anything else                              → null (caller maps to internal_error)
 *
 * `ENOENT` is folded into `fs_unavailable` because the only way it
 * surfaces here is a parent-dir race (the managed root is created
 * `recursive` immediately before the write) — a transient fs condition
 * the route layer can retry, not a logic bug. `ENOTDIR` / `EEXIST` (Cindy
 * D4.e-1 P2) are how a caller-PROPOSED `requested_path` shows up as
 * unusable on disk — a parent component is a regular file, or the path
 * already exists as a file. That is a property of the user's path choice,
 * NOT an internal bug, so it classifies as `fs_unavailable` rather than
 * being black-holed into `internal_error`.
 */
export type FsErrnoCode = 'fs_quota_exceeded' | 'fs_unavailable';

export function mapFsErrno(err: unknown): FsErrnoCode | null {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'fs_quota_exceeded';
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EEXIST'
  ) {
    return 'fs_unavailable';
  }
  return null;
}
