/**
 * #task:1805 workspace-layout-relocation-v1 (§5) — the ONE typed failure for
 * the L2-relocation migration facet, mirroring the `FlattenLayoutError` /
 * `SessionMigrationError` discipline: no raw errno ever escapes the facet's
 * boundary, and every code is a member of a closed set that the daemon
 * diagnostics table (`DaemonLayoutMigrationCodeSchema`) enumerates 1:1.
 *
 * The prefix is deliberately disjoint from `flatten_` and `layout_` so the
 * daemon breadcrumb's closed code union stays collision-free and the connect
 * command can map any of the three migration errors through the single
 * `daemonLayoutMigrationCode` producer.
 *
 * This module lives in the deletable migration unit: it retires together with
 * the rest of the relocation facet once the required-upgrade floor allows.
 */
export type RelocationErrorCode =
  /** A destination is present but its manifest differs from the source, a
   *  destination is present with NO source (source is retained forever, so a
   *  lone destination is unverifiable), or a live session bucket has zero
   *  census — every "old and new disagree" state that is not a safe replay. */
  | 'relocation_conflict'
  /** An `lstat`/`readdir`/`readlink` failed for a reason other than ENOENT, or
   *  the retained registry inventory cannot be read/parsed. */
  | 'relocation_unreadable'
  /** A FIFO, socket, or block/char device was found inside a copied subtree —
   *  a non-copyable type, fail closed (never dereferenced or skipped). */
  | 'relocation_special_file'
  /** The source changed under the copy (source-before ≠ source-after) or a
   *  staged copy diverged from the source-before snapshot — never publish a
   *  half/torn copy. Retry reads the next stable snapshot. */
  | 'relocation_unstable'
  /** A `mkdir`/copy/`rename` filesystem mutation failed. */
  | 'relocation_move_failed'
  /** A cwd is outside the verified session-slug charset, a config-dir override
   *  is non-absolute, or a census id is not a safe path segment — the location
   *  cannot be proven, so nothing is moved or guessed. */
  | 'relocation_unverifiable'
  /** The completion marker's `schema_version` is one this binary has no right
   *  to interpret (a strictly higher future/downgrade artifact, or a value
   *  below the first shipped version) — fail closed, never reinterpret as v1. */
  | 'relocation_marker_unsupported';

export class RelocationError extends Error {
  constructor(
    readonly code: RelocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelocationError';
  }
}
