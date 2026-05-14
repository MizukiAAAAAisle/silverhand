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
 * missing or malformed — renderers should chain into
 * `readTaskSystemMetadataPartial` for legacy rows inserted before
 * PR-2 added the enrichment, and only drop to raw `message.content`
 * narration when even the partial schema fails.
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

// ── session_cleared metadata ─────────────────────────────────────────

/**
 * Metadata shape for `session_cleared` system messages — emitted when
 * a user clears a (conversation, agent)'s CLI session via the
 * `/clear-session` route. Renderers draw a compact audit row off
 * these fields without re-parsing `message.content`.
 *
 *  - `agent_id` / `agent_name`: which agent's session was reset.
 *  - `actor_user_id`: who triggered it; `null` for legacy v1 rows
 *    where principal info wasn't stored.
 *  - `previous_cli_session_id_prefix`: short id (~8 chars) of the
 *    session that was cleared, surfaced as a `prev <id>` chip;
 *    `null` if the agent had no prior session (cold path).
 *  - `was_running`: true if the agent process was live at clear time.
 *    Renderer surfaces "was running" / "was idle" so the audit row
 *    captures whether this clear interrupted active work.
 */
export const SessionClearedMetadataSchema = z.object({
  subtype: z.literal('session_cleared'),
  agent_id: z.string(),
  agent_name: z.string(),
  actor_user_id: z.string().nullable(),
  previous_cli_session_id_prefix: z.string().nullable(),
  was_running: z.boolean(),
});
export type SessionClearedMetadata = z.infer<typeof SessionClearedMetadataSchema>;

/** Defensive parse for session_cleared metadata. Returns `null` for
 *  legacy rows whose metadata predates this schema; renderer falls
 *  back to a generic audit row reading `message.content`. */
export function readSessionClearedMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SessionClearedMetadata | null {
  if (!metadata) return null;
  const parsed = SessionClearedMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

// ── schedule_fire metadata ───────────────────────────────────────────

/**
 * Metadata shape for `schedule_fire` system messages — emitted by
 * the scheduler when a wake fires for an agent. Renderers read the
 * structured fields to draw a flat banner with header + status pills
 * + the original wake body, without re-parsing `message.content`.
 *
 *  - `schedule_id`: stable id of the underlying schedule row.
 *  - `spec_kind`: `'once' | 'interval' | 'cron'` — drives the header
 *    spec pill grouping.
 *  - `spec_summary`: pre-rendered human label
 *    (e.g. `"cron *\/5 9-18 * * 1-5 (Asia/Shanghai)"`, `"interval 60s"`,
 *    `"once"`). Cron summaries embed the timezone because the same
 *    expression resolves to different wall-clock times across zones.
 *    Optional — legacy rows without it fall back to `spec_kind` alone.
 *  - `body`: the user's reminder text (`schedule.message`) without
 *    the producer's "Schedule fired (kind: …)" / "Next fire at …" /
 *    "If nothing to do, reply 'noted, no action'" scaffolding. The
 *    scaffolding is for the agent's stdin; humans reading the banner
 *    only need the reminder. Optional — legacy rows fall back to
 *    rendering full `message.content`.
 *  - `actual_fire_at`: epoch ms when the wake actually fired.
 *  - `planned_fire_at`: epoch ms the wake was originally scheduled
 *    for. Difference vs. actual surfaces as the "planned <Δ ago/late>"
 *    pill. Set on every fire, including one-shot — the producer always
 *    writes `dto.next_fire_at` here. Schema keeps it nullable to absorb
 *    pre-PR-4 rows that lacked the field; renderers should suppress
 *    the pill only when the value is `null`.
 *  - `missed_count`: how many planned fires were skipped before this
 *    one (catch-up semantic). `0` is common; non-zero highlights as
 *    a warning pill.
 *  - `next_fire_at`: epoch ms of the next scheduled fire. `null` for
 *    one-shot or expired repeating schedules — pill is suppressed.
 */
export const ScheduleFireMetadataSchema = z.object({
  subtype: z.literal('schedule_fire'),
  schedule_id: z.string(),
  spec_kind: z.enum(['once', 'interval', 'cron']),
  spec_summary: z.string().optional(),
  body: z.string().optional(),
  actual_fire_at: z.number(),
  planned_fire_at: z.number().nullable(),
  missed_count: z.number(),
  next_fire_at: z.number().nullable(),
});
export type ScheduleFireMetadata = z.infer<typeof ScheduleFireMetadataSchema>;

/** Defensive parse for schedule_fire metadata. Returns `null` for
 *  legacy rows or malformed metadata; renderer falls back to a
 *  muted banner that reads `message.content` as a single-line body. */
export function readScheduleFireMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ScheduleFireMetadata | null {
  if (!metadata) return null;
  const parsed = ScheduleFireMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

// ── context-card series (PR-5) ───────────────────────────────────────
//
// `thread_anchor`, `child_context`, and `channel_context` form a
// unified context-card series. Their producer-visible difference is
// the relationship to a parent conversation:
//
//  - `thread_anchor` ("Quoted"):     the new thread quotes a single
//    message from the parent channel — body = the quoted text.
//  - `child_context` ("Inherited"):  a sub-thread inherits a free-form
//    summary the spawner wrote about the parent's prior context.
//  - `channel_context` ("Spawned-from"): a new top-level channel
//    inherits a seed body authored by the spawning agent in another
//    conversation.
//
// All three share the same render shape (left accent line, kind tag,
// source chip, collapsible body) but with different accent colors and
// tag labels. Each carries enough metadata that the renderer never
// has to re-parse `message.content` to identify the source — the
// content remains intact for agent stdin (which reads imperative
// prose), while metadata feeds the human banner.

/** Allowed `from_kind` values for the message a `thread_anchor`
 *  quotes. `system` is included because edge cases — a thread spawned
 *  off a system message — are technically reachable. */
export const QuotedFromKindSchema = z.enum(['user', 'agent', 'system']);
export type QuotedFromKind = z.infer<typeof QuotedFromKindSchema>;

/**
 * Metadata shape for `thread_anchor` system messages — emitted as the
 * first seed when a thread is created off a specific parent message
 * (right-click "Reply as thread" / "Discuss in thread").
 *
 *  - `quoted_message_id` / `quoted_conversation_id`: pointer at the
 *    original message + parent conversation; lets the renderer offer
 *    "jump to original" without re-querying.
 *  - `quoted_channel_name`: pre-rendered parent label (workspace name
 *    or channel title) for the source chip.
 *  - `quoted_content`: full text of the original message, preserved
 *    inline so the body stays visible after the parent is archived
 *    or the original message is later edited.
 *  - `quoted_from_kind` / `quoted_from_agent_id` / `quoted_from_user_id`
 *    / `quoted_agent_name`: identity of the original author. Agent
 *    rows carry both id+name; user rows carry id (legacy rows may
 *    have null id).
 *  - `quoted_created_at`: epoch ms of the original message — surfaced
 *    as the "<X ago>" right-aligned timestamp.
 */
export const ThreadAnchorMetadataSchema = z.object({
  subtype: z.literal('thread_anchor'),
  quoted_message_id: z.string(),
  quoted_conversation_id: z.string(),
  quoted_channel_name: z.string(),
  quoted_content: z.string(),
  quoted_from_kind: QuotedFromKindSchema,
  quoted_from_agent_id: z.string().nullable(),
  quoted_from_user_id: z.string().nullable(),
  quoted_agent_name: z.string().nullable(),
  quoted_created_at: z.number(),
});
export type ThreadAnchorMetadata = z.infer<typeof ThreadAnchorMetadataSchema>;

/** Defensive parse for thread_anchor metadata. Returns `null` for
 *  legacy rows whose metadata predates this schema; renderer falls
 *  back to muted narration over `message.content`. */
export function readThreadAnchorMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ThreadAnchorMetadata | null {
  if (!metadata) return null;
  const parsed = ThreadAnchorMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * Metadata shape for `child_context` system messages — emitted as the
 * first seed when an agent spawns a sub-thread with a free-form
 * `contextSummary`. `message.content` keeps the imperative prose
 * (`Inherited context from parent channel '<title>': <summary>`)
 * because the spawner agent's stdin reads it; renderers consume the
 * structured triple instead.
 *
 *  - `parent_conversation_id`: pointer at the parent channel for
 *    "jump to original" affordances.
 *  - `parent_title`: pre-rendered parent label for the source chip.
 *  - `summary`: the agent-authored context blurb, without the
 *    `Inherited context from parent channel '...': ` scaffolding.
 */
export const ChildContextMetadataSchema = z.object({
  subtype: z.literal('child_context'),
  parent_conversation_id: z.string(),
  parent_title: z.string(),
  summary: z.string(),
});
export type ChildContextMetadata = z.infer<typeof ChildContextMetadataSchema>;

/** Defensive parse for child_context metadata. */
export function readChildContextMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ChildContextMetadata | null {
  if (!metadata) return null;
  const parsed = ChildContextMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * Metadata shape for `channel_context` system messages — emitted as the
 * first seed when an agent calls `silverhand channel create` and the
 * service inserts the agent-authored `systemMessageBody` as the new
 * channel's initial context. Renderer surfaces it as a Spawned-from
 * card with a chip pointing back at the source conversation.
 *
 *  - `source_conversation_id`: pointer at the conversation the agent
 *    spawned this channel from.
 *  - `source_conversation_title`: pre-rendered source label for the
 *    chip; legacy rows may omit it (renderer falls back to "another
 *    conversation").
 *  - `created_by_agent_id` / `created_by_agent_name`: identity of the
 *    spawning agent. `created_by_agent_name` is new in PR-5 — legacy
 *    rows fall back to "an agent" in the source chip.
 *
 * Note: the seed body lives in `message.content`. We do NOT mirror it
 * into metadata — there's no producer-side scaffolding to strip (the
 * agent wrote the body to stdout-cleanly), and duplicating it would
 * just bloat the row.
 */
export const ChannelContextMetadataSchema = z.object({
  subtype: z.literal('channel_context'),
  source_conversation_id: z.string(),
  source_conversation_title: z.string().optional(),
  created_by_agent_id: z.string(),
  created_by_agent_name: z.string().optional(),
});
export type ChannelContextMetadata = z.infer<typeof ChannelContextMetadataSchema>;

/** Defensive parse for channel_context metadata. */
export function readChannelContextMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ChannelContextMetadata | null {
  if (!metadata) return null;
  const parsed = ChannelContextMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}
