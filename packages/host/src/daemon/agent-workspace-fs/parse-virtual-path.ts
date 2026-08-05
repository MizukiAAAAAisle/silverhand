import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Parse + resolve a renderer-supplied virtual path under an agent home
 * dir to a canonical real path (or a typed rejection). Used by both the
 * `agent_workspace_tree` (for the optional sub-tree case in future
 * slices) and `agent_workspace_file_read` daemon handlers.
 *
 * Defense in depth — six independent layers, every one sufficient on
 * its own to refuse a malicious traversal:
 *
 *   1. **Segment-shape validation.** `path.split('/')` and require every
 *      segment to be non-empty, not `.`, not `..`, not start with `.`,
 *      and not contain `\0` or `\\`. Catches the obvious `../etc/passwd`
 *      / leading-slash / `notes/.git/config` shapes before any I/O.
 *   2. **Per-segment lstat walk.** Step through each segment from base,
 *      `lstat` the partial path, and fail closed on ANY symlink — leaf
 *      OR intermediate. Prevents `notes/linkdir/file.md` from escaping
 *      via a symlink an earlier slice trusted only at the leaf.
 *   3. **Realpath boundary check.** The final `path.relative(realBase,
 *      realTarget)` must not start with `..` and must not be absolute.
 *      Catches anything the lstat walk missed (e.g. exotic mount-point
 *      mappings on case-insensitive filesystems).
 *   4. **Trailing-separator rejection** at the segment-shape stage —
 *      a path like `notes/foo.md/` would otherwise produce a stray
 *      empty segment.
 *   5. **Untyped error coalescing.** Any underlying fs error not in the
 *      "graceful missing" set (ENOENT/ENOTDIR) propagates to the caller,
 *      which projects it as `internal_error` — the helper itself never
 *      collapses a permission failure to `not_found`.
 *   6. **Root-symlink rejection.** The agent home dir itself must NOT
 *      be a symlink — `lstat(baseDir)` precedes `realpath(baseDir)` so
 *      a symlink replacement of the agent's L1 dir cannot
 *      become a trusted base. Same `forbidden_path` projection as a
 *      symlink anywhere else in the chain (Cindy round-1 P1 #2).
 *
 * The empty path `""` is reserved for "the base dir itself" and is
 * accepted only when the caller explicitly opts in via `allowRoot`.
 * The tree handler uses `allowRoot: true` (it walks from the base);
 * the read handler refuses (you can't read a directory as a file).
 */

export type ParseAndResolveVirtualPathResult =
  | { ok: true; real: string; lstat: Stats }
  | { ok: false; code: 'forbidden_path' | 'not_found' };

/**
 * The result of `resolveAgentHomeBase` — the agent-home-dir base after
 * lstat (root-symlink rejection) + realpath. Both `parseAndResolveVirtualPath`
 * (for the read endpoint) and `listAgentWorkspaceTree` (for the tree
 * endpoint) consume this so they share one root-resolution path; a
 * symlink at the agent home dir itself is refused IDENTICALLY by both
 * (Cindy round-1 P1 #2).
 */
export type ResolveAgentHomeBaseResult =
  | { ok: true; realBase: string; lstat: Stats }
  | { ok: false; code: 'forbidden_path' | 'not_found' };

/**
 * Resolve the agent home dir to a canonical realpath base. Refuses if
 * the dir itself is a symlink (forbidden_path) and gracefully reports
 * "not yet materialized" via not_found. Hard fs errors propagate.
 *
 * Two callers:
 *  - `parseAndResolveVirtualPath` (read endpoint): forbidden_path /
 *    not_found are both fatal for the read.
 *  - `listAgentWorkspaceTree`: forbidden_path is fatal; not_found is
 *    converted to an empty tree at the call site (brand-new agent
 *    before L3a/L3b graceful path).
 */
export async function resolveAgentHomeBase(
  baseDir: string,
): Promise<ResolveAgentHomeBaseResult> {
  let lst: Stats;
  try {
    lst = await fs.lstat(baseDir);
  } catch (err) {
    if (isGracefulMissing(err)) return { ok: false, code: 'not_found' };
    throw err;
  }
  if (lst.isSymbolicLink()) {
    // The agent home dir itself was replaced by a symlink. Refuse —
    // following it would let an attacker (with write access to the
    // agents root) silently re-base every subsequent virtual-path lookup
    // onto an arbitrary directory. Same `forbidden_path` projection as
    // a symlink anywhere else in the chain.
    return { ok: false, code: 'forbidden_path' };
  }
  let realBase: string;
  try {
    realBase = await fs.realpath(baseDir);
  } catch (err) {
    if (isGracefulMissing(err)) return { ok: false, code: 'not_found' };
    throw err;
  }
  return { ok: true, realBase, lstat: lst };
}

const FORBIDDEN_SEGMENT_CHARS = /[\0\\]/;

/**
 * Single-segment validator extracted from `validateVirtualPathShape`.
 * Tree-walk callers (`listAgentWorkspaceTree`) consume this on each
 * `Dirent.name` so the tree never emits a node whose path the read
 * endpoint would refuse — preserves the wire contract that any tree
 * node `path` can be fed back to `agent_workspace_file_read` (Cindy
 * round-2 P1).
 *
 * Refuses:
 *  - non-string / empty / `.` / `..`
 *  - dotfiles (anything starting with `.`)
 *  - segments containing `\0` or `\\` (NUL bytes never legal; backslash
 *    is a legal POSIX filename character but would collide with the
 *    `/`-joined virtual-path namespace once `tree.ts` normalizes
 *    `\` → `/` for the wire format)
 *
 * Note: `/` is not rejected here because `Dirent.name` from `readdir`
 * never contains `/` (it's a single path segment by construction). The
 * full-path validator (`validateVirtualPathShape`) splits on `/` first,
 * then runs each segment through this same gauntlet.
 */
export function isAllowedSegmentName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (FORBIDDEN_SEGMENT_CHARS.test(name)) return false;
  return true;
}

export function validateVirtualPathShape(
  virtualPath: string,
  opts: { allowRoot?: boolean } = {},
): { ok: true; segments: string[] } | { ok: false; code: 'forbidden_path' } {
  if (typeof virtualPath !== 'string') {
    return { ok: false, code: 'forbidden_path' };
  }
  // Empty / pure-root path. Tree handler accepts (the base dir itself);
  // read handler refuses (you can't read a directory as a file).
  if (virtualPath === '') {
    return opts.allowRoot
      ? { ok: true, segments: [] }
      : { ok: false, code: 'forbidden_path' };
  }
  // Reject leading or trailing `/` outright. A leading `/` would split
  // into a leading empty segment (treated as absolute); a trailing `/`
  // implies "this is a directory" which the read endpoint can't honor
  // and the tree endpoint never asks for explicitly. Both are noise.
  if (virtualPath.startsWith('/') || virtualPath.endsWith('/')) {
    return { ok: false, code: 'forbidden_path' };
  }
  if (FORBIDDEN_SEGMENT_CHARS.test(virtualPath)) {
    return { ok: false, code: 'forbidden_path' };
  }
  const segments = virtualPath.split('/');
  for (const seg of segments) {
    if (!isAllowedSegmentName(seg)) {
      return { ok: false, code: 'forbidden_path' };
    }
  }
  return { ok: true, segments };
}

/**
 * Resolve a previously shape-validated path under a real-pathed base.
 * The caller must `fs.realpath` the base ONCE (cached at handler entry)
 * and pass it here; this avoids per-call realpath churn for the tree
 * walk while still enforcing the boundary on the read path. Returns
 * the final `lstat` so the caller doesn't have to re-stat.
 */
export async function resolveValidatedSegments(
  segments: string[],
  realBase: string,
): Promise<ParseAndResolveVirtualPathResult> {
  // Per-segment lstat walk: if ANY segment is a symlink (or any other
  // not-a-real-dir-or-file), refuse. This catches symlink-via-
  // intermediate-dir attacks like `notes/linkdir/file.md`, which a
  // single `lstat` on the leaf would miss.
  let current = realBase;
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i]!);
    let lst: Stats;
    try {
      lst = await fs.lstat(current);
    } catch (err) {
      if (isGracefulMissing(err)) return { ok: false, code: 'not_found' };
      throw err;
    }
    if (lst.isSymbolicLink()) {
      // Treat symlinks as forbidden, not as not_found — surfacing
      // "this path doesn't exist" for a real symlink would lie, and
      // the daemon refuses to follow them in either direction. We
      // deliberately do not log the target (`readlink`) to avoid
      // surfacing the attacker's intended path back through error
      // messages.
      return { ok: false, code: 'forbidden_path' };
    }
    // Intermediate must be a directory; only the final entry is allowed
    // to be a file.
    if (i < segments.length - 1 && !lst.isDirectory()) {
      return { ok: false, code: 'not_found' };
    }
    if (i === segments.length - 1) {
      // Final realpath boundary check (defense in depth — the per-step
      // lstat walk already rejects symlinks, but realpath also catches
      // exotic FS-layer surprises like case-insensitive mounts).
      const realTarget = await fs.realpath(current);
      const rel = relative(realBase, realTarget);
      if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`)
                          && !isAbsolute(rel))) {
        return { ok: true, real: realTarget, lstat: lst };
      }
      return { ok: false, code: 'forbidden_path' };
    }
  }
  // segments.length === 0 → "root itself". Caller opted in via
  // allowRoot; return the base.
  const lst = await fs.lstat(realBase);
  if (lst.isSymbolicLink()) return { ok: false, code: 'forbidden_path' };
  return { ok: true, real: realBase, lstat: lst };
}

/**
 * One-shot helper: realpath the base, validate shape, walk segments.
 * Returns:
 *  - `{ ok: true, real, lstat }` — caller can read the file via `real`.
 *  - `{ ok: false, code: 'forbidden_path' }` — bad shape OR symlink in
 *    the chain OR realpath escaped the base. Surfaces fail-closed; the
 *    caller MUST NOT distinguish "shape was bad" from "you tried to
 *    escape" on the wire (every both look like "you can't read this").
 *  - `{ ok: false, code: 'not_found' }` — graceful missing (ENOENT /
 *    ENOTDIR) along the walk OR an intermediate that exists but isn't
 *    a directory.
 *
 * Any other error (EACCES / EIO / EPERM / EROFS / …) propagates to the
 * caller, which projects it as `internal_error`. The helper itself
 * never coalesces a hard fs failure to `not_found` — that would lie
 * about why the path is unavailable.
 */
export async function parseAndResolveVirtualPath(
  virtualPath: string,
  baseDir: string,
  opts: { allowRoot?: boolean } = {},
): Promise<ParseAndResolveVirtualPathResult> {
  const shape = validateVirtualPathShape(virtualPath, opts);
  if (!shape.ok) return shape;
  const base = await resolveAgentHomeBase(baseDir);
  if (!base.ok) return base;
  return resolveValidatedSegments(shape.segments, base.realBase);
}

function isGracefulMissing(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
