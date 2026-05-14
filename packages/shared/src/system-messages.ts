/**
 * System message subtype registry — single source of truth.
 *
 * Rows in the `messages` table with `from_kind = 'system'` carry an
 * optional `metadata.subtype` tag that identifies what kind of system
 * event they represent. Both producers (every `MessageRepo.insertForConversation`
 * call with `fromKind: 'system'`) and renderers (the `systemMessageRenderers`
 * registry in apps/desktop) read from the constants below.
 *
 * # Adding a new subtype
 *
 * 1. Add the literal to `SYSTEM_SUBTYPES` (or extend `TASK_MUTATION_KINDS`
 *    if it's a new task-mutation kind).
 * 2. Producer call sites pass it through `systemSubtype('your_new_name')`
 *    or `taskSystemSubtype(kind)` — both helpers narrow the argument to
 *    the literal union, so the drift test can grep call sites and
 *    statically derive the producer set.
 * 3. The renderer registry is typed `Record<SystemSubtype, …>` — `tsc`
 *    rejects missing keys, so the new subtype must be wired up before
 *    the build passes.
 * 4. The drift test cross-checks producer call sites against
 *    `SYSTEM_SUBTYPES`; a literal in producer code with no constant entry
 *    (or vice versa) fails CI.
 *
 * # Three-state resolution
 *
 * `resolveSubtype()` returns one of three states:
 *  - `current`: live subtype; the renderer registry is authoritative.
 *  - `legacy`: subtype was used in past producer code, removed since.
 *    DB rows still exist and the renderer falls back to generic narration.
 *    Do NOT pretend to parse content prefixes for these — the inferSubtype
 *    helper that did so was removed in PR-1.
 *  - `unknown`: missing metadata (null/undefined) or string in neither set.
 *    Renderer falls back to generic narration.
 *
 * Both `legacy` and `unknown` are first-class fallback states, NOT errors.
 */

/** Live subtypes — every entry must have a renderer in the registry. */
export const SYSTEM_SUBTYPES = [
  'onboarding',
  'channel_context',
  'child_context',
  'thread_anchor',
  'thread_summary',
  'mention_cc',
  'schedule_fire',
  'session_cleared',
  'rename',
  'task_create',
  'task_claim',
  'task_unclaim',
  'task_status',
] as const;
export type SystemSubtype = typeof SYSTEM_SUBTYPES[number];

/** Task mutation kinds — drives `taskSystemSubtype(kind)` → `task_${kind}`. */
export const TASK_MUTATION_KINDS = ['create', 'claim', 'unclaim', 'status'] as const;
export type TaskMutationKind = typeof TASK_MUTATION_KINDS[number];

/** Task subtypes — must match `\`task_${TaskMutationKind}\`` exactly
 *  (compile-time exhaustive check below). Listed explicitly to preserve
 *  tuple precision; `.map()` over `TASK_MUTATION_KINDS` would degrade to
 *  `readonly string[]`. */
export const TASK_SUBTYPES = [
  'task_create',
  'task_claim',
  'task_unclaim',
  'task_status',
] as const;
export type TaskSubtype = typeof TASK_SUBTYPES[number];

/** Compile-time exhaustiveness: TaskSubtype must equal
 *  `\`task_${TaskMutationKind}\`` in both directions. Adding a kind without
 *  the matching subtype literal — or a subtype literal without the kind —
 *  breaks typecheck via this assertion. Pure type-level (no runtime
 *  emit, no `noUnusedLocals` warning). */
type Assert<T extends true> = T;
type _IsExactTaskSubtype =
  Exclude<`task_${TaskMutationKind}`, TaskSubtype> extends never
    ? Exclude<TaskSubtype, `task_${TaskMutationKind}`> extends never
      ? true
      : false
    : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _TaskSubtypeExhaustive = Assert<_IsExactTaskSubtype>;

/** DB-resident subtypes that no current producer writes. Renderer treats
 *  them as `legacy` — falls through to generic narration without a
 *  dedicated component. `null` / missing metadata is NOT a legacy
 *  member; `resolveSubtype()` returns it as `unknown`. */
export const LEGACY_SUBTYPES = [
  'join',
  'session_context',
  'child_summary',
] as const;
export type LegacySystemSubtype = typeof LEGACY_SUBTYPES[number];

/**
 * Identity helper for non-task subtypes. Forces TypeScript to narrow the
 * argument to `SystemSubtype` at the call site, giving the drift test a
 * single grep pattern (`systemSubtype('name')`) to enumerate producers.
 *
 * Producers should write `systemSubtype('mention_cc')` instead of bare
 * string literals so the drift test can find them.
 */
export function systemSubtype(name: SystemSubtype): SystemSubtype {
  return name;
}

/**
 * Maps a `TaskMutationKind` to its `TaskSubtype` literal. Used by
 * task-service.ts when inserting task lifecycle system messages —
 * the helper is the single source of the `task_${kind}` template,
 * so the drift test can scan `taskSystemSubtype(...)` arguments and
 * statically derive the four task subtype names.
 */
export function taskSystemSubtype(kind: TaskMutationKind): TaskSubtype {
  return `task_${kind}` as TaskSubtype;
}

/** Three-state resolution result. `current` rows are renderer registry's
 *  responsibility; `legacy` and `unknown` both fall through to generic
 *  narration but are reported separately so observability/telemetry can
 *  distinguish historic data from drift bugs. */
export type SubtypeResolution =
  | { kind: 'current'; subtype: SystemSubtype }
  | { kind: 'legacy'; subtype: LegacySystemSubtype }
  | { kind: 'unknown' };

/**
 * Resolve a raw subtype string (or null/undefined) to one of three states.
 * Renderers consume this — they switch on `resolution.kind` first, then
 * dispatch on `resolution.subtype` only in the `current` branch.
 */
export function resolveSubtype(
  raw: string | null | undefined,
): SubtypeResolution {
  if (raw == null) return { kind: 'unknown' };
  if ((SYSTEM_SUBTYPES as readonly string[]).includes(raw)) {
    return { kind: 'current', subtype: raw as SystemSubtype };
  }
  if ((LEGACY_SUBTYPES as readonly string[]).includes(raw)) {
    return { kind: 'legacy', subtype: raw as LegacySystemSubtype };
  }
  return { kind: 'unknown' };
}

/**
 * Pull `metadata.subtype` from a message metadata object and resolve it.
 * Convenience for renderer call sites that have the raw metadata dict.
 */
export function readSubtype(
  metadata: Record<string, unknown> | null | undefined,
): SubtypeResolution {
  if (!metadata) return { kind: 'unknown' };
  const v = metadata['subtype'];
  return resolveSubtype(typeof v === 'string' ? v : null);
}
