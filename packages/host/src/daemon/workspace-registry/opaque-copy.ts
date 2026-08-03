import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { RelocationError } from './relocation-error.js';

/**
 * #task:1805 workspace-layout-relocation-v1 (§5) — the from-scratch cross-
 * filesystem opaque-copy layer the relocation facet is built on. NONE of the
 * shipped machinery fits: the L2 source lives inside an arbitrary user checkout
 * that may sit on a different filesystem than the app root, so `renameSync`
 * raises `EXDEV`; and the facet must retain the source forever, so it copies
 * (never moves) and classifies every destination purely by filesystem state.
 *
 * The unit is deliberately domain-free: it knows nothing of registries,
 * agents, or session runtimes. It offers exactly the primitives §5 mandates —
 * a stable-snapshot manifest (streaming content hash + POSIX mode; symlink
 * target recorded, never followed; special files fail closed), an opaque
 * target-filesystem staging copy, and an atomic same-filesystem publish — plus
 * one composed 1→1 stable copy. The relocation facet composes these into the
 * 1→N session fan-out with its own batch-level snapshot invariant.
 *
 * Every filesystem failure is wrapped as a typed {@link RelocationError}; no
 * raw errno escapes this boundary.
 */

export type FsNodeKind =
  | 'absent'
  | 'dir'
  | 'file'
  | 'symlink'
  | 'special'
  | 'unreadable';

/** Classify a single path WITHOUT following symlinks. Only ENOENT is `absent`;
 *  any other lstat failure is `unreadable` and must never read as "nothing
 *  here". */
export function probe(path: string): FsNodeKind {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'special';
}

function assertRealDirIfPresent(path: string, target: string): void {
  const kind = probe(path);
  if (kind === 'absent' || kind === 'dir') return; // absent → mkdir creates a real dir
  if (kind === 'symlink') {
    throw new RelocationError(
      'relocation_conflict',
      `ancestor ${path} of destination ${target} is a symlink; refusing to follow it out of the trusted root`,
    );
  }
  if (kind === 'unreadable') {
    throw new RelocationError(
      'relocation_unreadable',
      `ancestor ${path} of destination ${target} is unreadable`,
    );
  }
  throw new RelocationError(
    kind === 'special' ? 'relocation_special_file' : 'relocation_conflict',
    `ancestor ${path} of destination ${target} is a ${kind}, not a directory`,
  );
}

/**
 * Assert that every EXISTING ancestor of `target` from the trusted `root` down
 * to and including `dirname(target)` is a REAL directory — never a symlink,
 * special file, or unreadable node. Absent ancestors are fine (a later
 * `mkdirSync(recursive)` materializes real dirs). This closes the managed
 * path-authority escape where an intermediate symlink would make the recursive
 * mkdir / publish land OUTSIDE the trusted root: `app-data-layout-v2.md`
 * ("traversing [a symlink] can escape the app root"). The target LEAF itself is
 * NOT inspected here — its occupancy is the caller's own publish classifier.
 * `target` must lie under `root`.
 */
export function assertTrustedDirAncestors(root: string, target: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (
    targetResolved !== rootResolved &&
    !targetResolved.startsWith(rootResolved + sep)
  ) {
    throw new RelocationError(
      'relocation_unverifiable',
      `destination ${target} is not under the trusted root ${root}`,
    );
  }
  const rel = relative(rootResolved, targetResolved);
  const segments = rel === '' ? [] : rel.split(sep);
  // The trusted root itself, then each intermediate ancestor up to
  // dirname(target); the last segment (the target leaf) is left to the caller.
  let current = rootResolved;
  assertRealDirIfPresent(current, target);
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i]!);
    assertRealDirIfPresent(current, target);
  }
}

export type ManifestEntry =
  | { readonly type: 'dir'; readonly mode: number }
  | { readonly type: 'file'; readonly mode: number; readonly hash: string }
  | { readonly type: 'symlink'; readonly target: string };

/** A tree's content keyed by POSIX-relative path (`''` is the tree root).
 *  mtime / xattr / ownership are deliberately out of scope (§5). */
export type Manifest = Map<string, ManifestEntry>;

const HASH_CHUNK = 1 << 16;

/** Streaming sha256 so a large vendor `.jsonl` is never buffered whole. Every
 *  descriptor operation is wrapped so an EACCES/EIO on an unreadable source file
 *  surfaces as a typed `relocation_unreadable`, never a raw errno escaping the
 *  opaque-copy boundary. */
function hashFile(path: string): string {
  const hash = createHash('sha256');
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    throw new RelocationError(
      'relocation_unreadable',
      `cannot open ${path} for hashing (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    let read: number;
    while ((read = readSync(fd, buf, 0, HASH_CHUNK, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } catch (err) {
    throw new RelocationError(
      'relocation_unreadable',
      `cannot read ${path} while hashing (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The digest is already computed or an error is already in flight; a
      // failed close of a spent descriptor must not mask either.
    }
  }
  return hash.digest('hex');
}

function permBits(mode: number): number {
  return mode & 0o777;
}

/**
 * Build a stable-snapshot manifest of a directory tree. PRECONDITION: `root`
 * is a directory (callers gate on {@link probe}). A non-copyable type anywhere
 * in the tree fails closed; any read error other than a clean absence is
 * `unreadable`. Directory entries are visited in sorted order so a manifest is
 * a deterministic function of the tree's content.
 */
export function buildManifest(root: string): Manifest {
  const manifest: Manifest = new Map();
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (err) {
    throw new RelocationError(
      'relocation_unreadable',
      `cannot inspect ${root} (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new RelocationError(
      'relocation_conflict',
      `manifest root ${root} is not a directory`,
    );
  }
  manifest.set('', { type: 'dir', mode: permBits(rootStat.mode) });
  walkManifest(root, '', manifest);
  return manifest;
}

function walkManifest(dir: string, prefix: string, manifest: Manifest): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    throw new RelocationError(
      'relocation_unreadable',
      `cannot list ${dir} (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      throw new RelocationError(
        'relocation_unreadable',
        `cannot inspect ${abs} (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
      );
    }
    if (stat.isDirectory()) {
      manifest.set(rel, { type: 'dir', mode: permBits(stat.mode) });
      walkManifest(abs, rel, manifest);
    } else if (stat.isFile()) {
      manifest.set(rel, { type: 'file', mode: permBits(stat.mode), hash: hashFile(abs) });
    } else if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch (err) {
        throw new RelocationError(
          'relocation_unreadable',
          `cannot read symlink ${abs} (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
        );
      }
      manifest.set(rel, { type: 'symlink', target });
    } else {
      throw new RelocationError(
        'relocation_special_file',
        `${abs} is a FIFO, socket, or device — a non-copyable type`,
      );
    }
  }
}

function entriesEqual(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'dir' && b.type === 'dir') return a.mode === b.mode;
  if (a.type === 'file' && b.type === 'file') {
    return a.mode === b.mode && a.hash === b.hash;
  }
  if (a.type === 'symlink' && b.type === 'symlink') return a.target === b.target;
  return false;
}

/** Two trees are equivalent iff every relative path matches on type, and on
 *  content hash + mode (files), mode (dirs), or link target (symlinks). */
export function manifestsEqual(a: Manifest, b: Manifest): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, entry] of a) {
    const other = b.get(rel);
    if (other === undefined || !entriesEqual(entry, other)) return false;
  }
  return true;
}

let stagingCounter = 0;

/** A fresh staging directory beside `dest`, hence on the SAME filesystem — so
 *  the publish is a same-fs rename even when the SOURCE is on another volume.
 *  The pid+counter name is unique WITHIN a daemon start. Across starts a PID is
 *  reused, so a crash CAN leave an inert orphan at a path a later run selects
 *  again — the name is NOT a forever-unique token. Two invariants make that
 *  safe rather than a wedge: `stageTree` reclaims a pre-existing orphan in this
 *  reserved single-writer namespace instead of failing on `EEXIST`, and
 *  `removeStaging` can always delete a staged tree even after its dirs were
 *  clamped read-only. The name is never enumerated or adopted as data. */
export function freshStagingPath(dest: string): string {
  return join(dirname(dest), `.relocation-staging.${process.pid}.${stagingCounter++}`);
}

/** Restore owner traversal+write on every REAL directory in a tree so a
 *  subsequent recursive delete can unlink children, WITHOUT following symlinks
 *  (a symlinked entry is left for its parent's unlink to remove). A staged tree
 *  may have had its dirs clamped to a read-only source mode (e.g. 0555), which
 *  would otherwise make `rmSync` fail to empty them. */
function makeTreeRemovable(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return; // absent or already gone — nothing to unlock
  }
  if (stat.isSymbolicLink()) return; // never follow; the parent unlink removes the link
  if (stat.isDirectory()) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // best effort; rmSync below will still try
    }
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) makeTreeRemovable(join(path, name));
  }
}

/** Best-effort removal of a staged tree after a failed copy; a leftover is
 *  inert (source untouched, destination unpublished). Read-only staged dirs are
 *  made writable first so the delete actually empties them. */
export function removeStaging(staging: string): void {
  makeTreeRemovable(staging);
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // inert orphan; the source is intact and the destination unpublished
  }
}

/**
 * Opaquely copy a directory tree into a FRESH staging dir on the destination's
 * filesystem: directories recreated with their mode, regular files copied and
 * chmod'd to the source mode, symlinks recreated by target (never followed). A
 * special file fails closed. The staging dir must not already exist.
 */
export function stageTree(source: string, staging: string): void {
  try {
    const rootStat = lstatSync(source);
    if (!rootStat.isDirectory()) {
      throw new RelocationError(
        'relocation_conflict',
        `stage source ${source} is not a directory`,
      );
    }
    // A pre-existing staging path can only be an inert orphan from a crashed
    // prior run (this is a reserved single-writer namespace), so reclaim it
    // rather than wedging on EEXIST when a reused PID reproduces the name.
    if (probe(staging) !== 'absent') removeStaging(staging);
    mkdirSync(staging);
    mirrorTree(source, staging);
    // Clamp the staging root to the source mode LAST. A read-only source dir
    // (e.g. 0555) must not become the copy's mode before its own children are
    // written, or writing them would EACCES.
    chmodSync(staging, permBits(rootStat.mode));
  } catch (err) {
    if (err instanceof RelocationError) throw err;
    throw new RelocationError(
      'relocation_move_failed',
      `staging ${source} failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
}

function mirrorTree(srcDir: string, dstDir: string): void {
  for (const name of readdirSync(srcDir).sort()) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const stat = lstatSync(src);
    if (stat.isDirectory()) {
      mkdirSync(dst);
      mirrorTree(src, dst);
      // Bottom-up: clamp each dir to its source mode only after its children
      // are written, so a read-only source dir never blocks its own copy.
      chmodSync(dst, permBits(stat.mode));
    } else if (stat.isFile()) {
      copyFileSync(src, dst);
      chmodSync(dst, permBits(stat.mode));
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(src), dst);
    } else {
      throw new RelocationError(
        'relocation_special_file',
        `${src} is a FIFO, socket, or device — a non-copyable type`,
      );
    }
  }
}

/** Atomically publish a staged tree by a single same-filesystem rename. The
 *  caller must have verified the destination is absent. */
export function publishStaged(staging: string, dest: string): void {
  try {
    renameSync(staging, dest);
  } catch (err) {
    throw new RelocationError(
      'relocation_move_failed',
      `publishing to ${dest} failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
}

/**
 * The composed 1→1 stable copy (§5 steps 1–4): source-before manifest → stage
 * on the destination fs → require staged == source-before AND source-after ==
 * source-before → atomic publish. Any divergence (a mid-copy edit, a torn
 * copy) throws `relocation_unstable` with the staging discarded and the source
 * untouched. PRECONDITION: `dest` is absent (the caller's classifier decided a
 * fresh copy is due). The 1→N session fan-out does NOT use this — it shares one
 * source-before across N destinations — but reuses the same primitives.
 *
 * `opts.onStaged` is a TEST-ONLY seam (mirroring the materialize handler's
 * `afterEmptyDirCheck`): it fires after staging completes and BEFORE the
 * staged/source re-manifest, the only synchronous pause point at which a test
 * can simulate a torn staged copy or a source rewritten under the copy.
 * Production callers never pass it.
 */
export function copyTreeStable(
  source: string,
  dest: string,
  opts?: { onStaged?: () => void },
): void {
  const before = buildManifest(source);
  try {
    mkdirSync(dirname(dest), { recursive: true });
  } catch (err) {
    throw new RelocationError(
      'relocation_move_failed',
      `preparing ${dirname(dest)} failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  const staging = freshStagingPath(dest);
  try {
    stageTree(source, staging);
    opts?.onStaged?.();
    if (!manifestsEqual(buildManifest(staging), before)) {
      throw new RelocationError(
        'relocation_unstable',
        `staged copy of ${source} diverged from its source snapshot`,
      );
    }
    if (!manifestsEqual(buildManifest(source), before)) {
      throw new RelocationError(
        'relocation_unstable',
        `${source} changed under the copy; refusing to publish a torn snapshot`,
      );
    }
    publishStaged(staging, dest);
  } catch (err) {
    removeStaging(staging);
    throw err;
  }
}
