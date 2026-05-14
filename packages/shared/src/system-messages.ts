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
import { z } from 'zod';
import { TaskAssigneeDtoSchema } from './api/dto.js';
import { TaskStatusSchema } from './db/schema.js';

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

// ── Per-subtype metadata schemas ─────────────────────────────────────
//
// Producers and renderers stay loose at the message-row boundary
// (`metadata: Record<string, unknown>` in the message DTO), but each
// subtype with structured fields owns a zod schema below so producers
// can lock the shape on insert and renderers can defensively parse on
// read. Renderers do NOT throw on missing fields — they fall back to a
// degraded display (typically: drop the structured pieces and render
// `message.content` as narration). This is the "legacy task row" path
// from the PR-2 design discussion.

/** Actor on a task system event — derived from the `TaskActor` that
 *  triggered the mutation. `id` is `null` only for legacy user actors
 *  whose `userId` was unknown at insert time; new producers set
 *  `id = 'local'` (or whatever the principal carries). */
export const TaskSystemActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string().nullable(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('agent'),
    id: z.string(),
    name: z.string(),
  }),
]);
export type TaskSystemActor = z.infer<typeof TaskSystemActorSchema>;

/**
 * Metadata shape for `task_create` / `task_claim` / `task_unclaim` /
 * `task_status` system messages. The `task_status` field is the status
 * snapshot AFTER this mutation — the event TYPE is `subtype`. Examples:
 *
 *  - `subtype = task_create`: genesis event; `task_status = 'todo'`.
 *  - `subtype = task_claim`: prior state was `todo` (claim's domain);
 *    `task_status = 'in_progress'` (the post-state).
 *  - `subtype = task_unclaim`: prior state was `in_progress`;
 *    `task_status = 'todo'` (the post-state).
 *  - `subtype = task_status`: arbitrary transition; the prior state is
 *    NOT in metadata — needs back-reference to the previous task system
 *    message if a future view wants to render a `before → after` diff.
 *
 * `task_message_id` points at the canonical task body row (the
 * `task_create` system message; same id for every later mutation event
 * on this task), enabling per-task event lookup without relying on
 * workspace-scoped `task_number` ambiguity.
 */
export const TaskSystemMetadataSchema = z.object({
  subtype: z.enum(TASK_SUBTYPES),
  task_number: z.number(),
  /** Status snapshot AFTER this mutation. The event type is `subtype`,
   *  not this field — see schema docstring for prior-state semantics. */
  task_status: TaskStatusSchema,
  task_message_id: z.string(),
  task_title: z.string(),
  task_assignee: TaskAssigneeDtoSchema.nullable(),
  actor: TaskSystemActorSchema,
});
export type TaskSystemMetadata = z.infer<typeof TaskSystemMetadataSchema>;

/** TS alias to flag the `task_status` field as the after-state snapshot.
 *  Read sites can write `const status: TaskStatusAfterMutation = m.task_status`
 *  to make the semantic explicit at the call site. */
export type TaskStatusAfterMutation = TaskSystemMetadata['task_status'];

/**
 * Defensive parse of a system-message metadata object into a fully
 * enriched `TaskSystemMetadata`. Returns `null` if any required field is
 * missing or malformed — renderers should fall back to a degraded
 * display (chip + status pill + raw `message.content`) for legacy rows
 * inserted before PR-2 added the enrichment.
 */
export function readTaskSystemMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TaskSystemMetadata | null {
  if (!metadata) return null;
  const parsed = TaskSystemMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * Partial schema for legacy task system metadata. Pre-PR-2 producers
 * only wrote `subtype` + `task_number` + `task_status`, with no actor /
 * task_title / task_assignee / task_message_id enrichment. Renderers
 * use this as a midway fallback: if the full schema fails but the
 * partial one passes, draw a degraded row (chip + status pill, no
 * actor pill / verb / title) instead of dropping all the way to
 * narration. There are ~1646 such rows in production DBs as of PR-2.
 */
export const TaskSystemMetadataPartialSchema = z.object({
  subtype: z.enum(TASK_SUBTYPES),
  task_number: z.number(),
  task_status: TaskStatusSchema,
});
export type TaskSystemMetadataPartial = z.infer<typeof TaskSystemMetadataPartialSchema>;

/** Defensive partial parse — returns `null` if even the minimal
 *  `(subtype, task_number, task_status)` triple is unparseable. */
export function readTaskSystemMetadataPartial(
  metadata: Record<string, unknown> | null | undefined,
): TaskSystemMetadataPartial | null {
  if (!metadata) return null;
  const parsed = TaskSystemMetadataPartialSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}
