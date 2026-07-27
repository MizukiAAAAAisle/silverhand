import { z } from 'zod';

/**
 * #task:1664 — the layout-v2 migration FAILURE diagnostics contract.
 *
 * A failed layout-v2 migration blocks startup by design, and the daemon that
 * would carry the outcome handshake never starts — so the failure is invisible
 * to the server (`LayoutMigrationOutcome` in `@silverhand/host/protocol` can
 * only ever carry `migrated | already_current`). This module is the ONE wire
 * contract that closes that hole: the failing process drops a local breadcrumb,
 * and the next authenticated desktop start reports it once.
 *
 * HARD INVARIANT (shiki 2026-07-27, #task:1664): the breadcrumb file's schema
 * IS this wire schema — not a superset. There is no field that exists only on
 * disk, so "what we would send" and "what we stored" cannot drift, and no one
 * has to maintain a mental list of local-only fields. Adding a local-only field
 * (a timestamp, a path, a workspace name) is a contract violation, not a
 * convenience.
 *
 * PRIVACY BOUNDARY IS STRUCTURAL, NOT A SCRUBBER. Every field is a closed enum,
 * a release version, or a bounded count. There is deliberately NO free-text
 * field: no error message, no filesystem path, no workspace/user/host id, no
 * timestamp. A scrubber would have to be right every time a new throw site
 * appears; a schema with no string-shaped hole cannot leak. In particular the
 * `code` mappers below are the only legal way to produce a `code`: raw
 * `err.code` from an arbitrary throw (`NodeJS.ErrnoException`, a third-party
 * error, an object that happens to carry `code: <long string>`) must never
 * reach the payload — anything not in the closed table becomes `'unknown'`,
 * which is an enum MEMBER, not a passthrough.
 */

/**
 * Saturating upper bound for `count`. A crash loop that re-runs the same
 * failing migration on every launch must neither grow the file nor produce an
 * out-of-range value, so the writer clamps here. Readers MUST treat the ceiling
 * as "at least this many", never as an exact count.
 */
export const LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT = 999;

/**
 * Upper bound on distinct aggregation keys held (and reported) at once. The key
 * space is `component × stage × code × version`, so a real machine produces one
 * or two entries; the cap only bounds a pathological file. A new distinct key
 * arriving at the cap is dropped by the writer (the existing entries already
 * describe this machine's failure shape).
 */
export const LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES = 12;

/**
 * Hard cap on the serialized report, measured BEFORE any parse — both for the
 * breadcrumb file (untrusted local bytes: a user may have edited it, or a
 * partial write may have landed) and for the request body at the server
 * boundary. Twelve fully-populated entries are well under 2 KiB.
 */
export const LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES = 4096;

/**
 * Release-version shape shared by both arms (`app.getVersion()` on the desktop,
 * `DAEMON_VERSION` in the daemon). Bounded and semver-shaped so a pseudo-version
 * lands in `invalid` instead of polluting version attribution. Same contract as
 * `ClientInfoSchema.app_version` — deliberately not imported from there: that is
 * the desktop↔server RELEASE-IDENTITY context, this is migration diagnostics.
 */
const VersionSchema = z
  .string()
  .max(40)
  .regex(
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/,
  );

/** Where in the desktop's pre-connection preparation the failure happened. */
export const DesktopLayoutMigrationStageSchema = z.enum(['quiesce', 'engine']);
export type DesktopLayoutMigrationStage = z.infer<
  typeof DesktopLayoutMigrationStageSchema
>;

/**
 * Closed set of desktop failure codes = every `LayoutMigrationError` code, plus
 * `'unknown'` for a throw that carries no code we recognize (e.g. an unexpected
 * error out of quiesce). Keep in sync with `LayoutMigrationError` in
 * `apps/desktop/src/main/layout-migration/engine.ts`; the sync is enforced by
 * `packages/shared/src/__tests__` + the desktop engine tests, never by a cast.
 */
export const DesktopLayoutMigrationCodeSchema = z.enum([
  'layout_conflict',
  'layout_unreadable',
  'layout_special_file',
  'layout_move_failed',
  'layout_registry_rewrite_blocked',
  'layout_marker_corrupt',
  'unknown',
]);
export type DesktopLayoutMigrationCode = z.infer<
  typeof DesktopLayoutMigrationCodeSchema
>;

/**
 * The daemon has exactly one migration stage today (the workspace-data
 * convergence pass in `silverhand-daemon connect`). It is a schema literal
 * rather than "whatever string the call site passes" so a second stage has to
 * be added here deliberately.
 */
export const DaemonLayoutMigrationStageSchema = z.literal(
  'workspace_data_convergence',
);
export type DaemonLayoutMigrationStage = z.infer<
  typeof DaemonLayoutMigrationStageSchema
>;

/**
 * Closed set of daemon failure codes = `FlattenLayoutError` ∪
 * `SessionMigrationError` codes (disjoint prefixes, so no collision), plus
 * `'unknown'`.
 */
export const DaemonLayoutMigrationCodeSchema = z.enum([
  'flatten_conflict',
  'flatten_unreadable',
  'flatten_invalid_id',
  'flatten_move_failed',
  'layout_conflict',
  'layout_unreadable',
  'layout_special_file',
  'layout_move_failed',
  'unknown',
]);
export type DaemonLayoutMigrationCode = z.infer<
  typeof DaemonLayoutMigrationCodeSchema
>;

const CountSchema = z
  .number()
  .int()
  .min(1)
  .max(LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT);

/**
 * One aggregated failure fact, discriminated by the component that hit it.
 *
 * The two arms do NOT carry each other's fields: the desktop knows its app
 * version and never a daemon version, the daemon the reverse. Both version
 * sources always exist, so neither field is nullable — and a reader never has
 * to decide what a `null` version means.
 */
export const LayoutMigrationFailureSchema = z.discriminatedUnion('component', [
  z
    .object({
      component: z.literal('desktop'),
      app_version: VersionSchema,
      stage: DesktopLayoutMigrationStageSchema,
      code: DesktopLayoutMigrationCodeSchema,
      layout_version: z.literal(2),
      count: CountSchema,
    })
    .strict(),
  z
    .object({
      component: z.literal('daemon'),
      daemon_version: VersionSchema,
      stage: DaemonLayoutMigrationStageSchema,
      code: DaemonLayoutMigrationCodeSchema,
      layout_version: z.literal(2),
      count: CountSchema,
    })
    .strict(),
]);
export type LayoutMigrationFailure = z.infer<
  typeof LayoutMigrationFailureSchema
>;

/**
 * The report body — and, per the hard invariant above, the breadcrumb file's
 * entire content. `.strict()` on both levels so an extra key anywhere makes the
 * payload `invalid` rather than silently riding along.
 */
export const LayoutMigrationDiagnosticsReportSchema = z
  .object({
    reports: z
      .array(LayoutMigrationFailureSchema)
      .min(1)
      .max(LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES),
  })
  .strict();
export type LayoutMigrationDiagnosticsReport = z.infer<
  typeof LayoutMigrationDiagnosticsReportSchema
>;

/** A failure fact before aggregation — same shape without the count. */
export type LayoutMigrationFailureFact =
  | Omit<Extract<LayoutMigrationFailure, { component: 'desktop' }>, 'count'>
  | Omit<Extract<LayoutMigrationFailure, { component: 'daemon' }>, 'count'>;

/**
 * The aggregation key: the ENTIRE identity of the fact except `count`. Versions
 * are part of the key on purpose — merging two versions' failures would destroy
 * the only attribution that makes this data actionable ("which release started
 * failing this way").
 */
export function layoutMigrationFailureKey(
  fact: LayoutMigrationFailureFact,
): string {
  return fact.component === 'desktop'
    ? `desktop|${fact.app_version}|${fact.stage}|${fact.code}|${fact.layout_version}`
    : `daemon|${fact.daemon_version}|${fact.stage}|${fact.code}|${fact.layout_version}`;
}

/**
 * Pure aggregation step: fold one new fact into the existing entries.
 *
 * - same key → `count + 1`, saturating at `LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT`
 * - new key, room left → appended with `count: 1`
 * - new key at `LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES` → dropped
 *
 * Returns a new array; never mutates the input.
 */
export function aggregateLayoutMigrationFailure(
  existing: readonly LayoutMigrationFailure[],
  fact: LayoutMigrationFailureFact,
): LayoutMigrationFailure[] {
  const key = layoutMigrationFailureKey(fact);
  const index = existing.findIndex(
    entry => layoutMigrationFailureKey(entry) === key,
  );
  if (index >= 0) {
    const next = [...existing];
    const hit = next[index]!;
    next[index] = {
      ...hit,
      count: Math.min(hit.count + 1, LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT),
    };
    return next;
  }
  if (existing.length >= LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES) {
    return [...existing];
  }
  return [...existing, { ...fact, count: 1 } as LayoutMigrationFailure];
}

/**
 * Map an arbitrary thrown value's `code` into the closed desktop table. This is
 * the ONLY legal producer of a desktop `code`; call it at the throw site so no
 * raw string can reach the payload.
 */
export function desktopLayoutMigrationCode(
  raw: unknown,
): DesktopLayoutMigrationCode {
  const parsed = DesktopLayoutMigrationCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'unknown';
}

/** Same closed mapping for the daemon table. */
export function daemonLayoutMigrationCode(
  raw: unknown,
): DaemonLayoutMigrationCode {
  const parsed = DaemonLayoutMigrationCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'unknown';
}

export type LayoutMigrationDiagnosticsParseResult =
  | { status: 'valid'; value: LayoutMigrationDiagnosticsReport }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Bounded parse of a serialized report, used for BOTH untrusted inputs: the
 * local breadcrumb file and the request body. Never throws.
 *
 * - `undefined` / blank → `missing`
 * - over-size, non-JSON, or schema mismatch (including an unknown key) →
 *   `invalid`, with no detail retained: the caller must never log or forward
 *   the raw bytes it just rejected.
 *
 * Size is measured with `TextEncoder`, not Node `Buffer`, to keep this module
 * inside the `@silverhand/shared` cross-environment boundary.
 */
export function parseLayoutMigrationDiagnosticsReport(
  raw: string | undefined,
): LayoutMigrationDiagnosticsParseResult {
  if (raw === undefined) return { status: 'missing' };
  const trimmed = raw.trim();
  if (trimmed === '') return { status: 'missing' };
  if (
    new TextEncoder().encode(trimmed).length >
    LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES
  ) {
    return { status: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: 'invalid' };
  }
  const result = LayoutMigrationDiagnosticsReportSchema.safeParse(parsed);
  return result.success
    ? { status: 'valid', value: result.data }
    : { status: 'invalid' };
}

/** Serialize a report, validating first so a writer can never emit bytes its
 *  own reader would classify `invalid`. */
export function serializeLayoutMigrationDiagnosticsReport(
  report: LayoutMigrationDiagnosticsReport,
): string {
  return JSON.stringify(LayoutMigrationDiagnosticsReportSchema.parse(report));
}
