// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: schedule. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';

//
// Agent-owned cron-like scheduler. A schedule is a self-driven
// reminder for ONE agent — it has zero coupling to channels, tasks,
// or other agents. The agent picks a time policy (`spec`) and the
// service wakes the agent at the next due time by inserting a
// `from_kind='system'` message into the agent's agent_home primary
// dm_channel and delivering it only to the owner.
//
// Specs are a discriminated union:
//   - `once`     : single fire at `fire_at` (or now+`delay_seconds`)
//   - `interval` : fire every `every_seconds` (>=60); `start_at`
//                  optional (defaults to now+every_seconds)
//   - `cron`     : 5-field UNIX cron expression evaluated in the
//                  given IANA timezone
//
// `until_at` and `max_occurrences` are independent caps; either ends
// a repeating schedule. Repeats with neither cap MUST set
// `allow_unbounded: true` on the input — otherwise the request is
// rejected to prevent accidental forever-runs.
//
// Quotas (server-enforced):
//   - per agent: at most 50 active (`pending`+`firing`)
//   - one-shot delay window: [30s, 90d]
//   - interval `every_seconds` >= 60 (aligned to scheduler tick)
//
// All times are epoch-ms UTC.

export const SCHEDULE_MIN_DELAY_SECONDS = 30;
export const SCHEDULE_MAX_DELAY_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const SCHEDULE_MIN_INTERVAL_SECONDS = 60;
export const SCHEDULE_MAX_ACTIVE_PER_AGENT = 50;
export const SCHEDULE_TITLE_MAX_LEN = 120;
export const SCHEDULE_MESSAGE_MAX_LEN = 500;

export const ScheduleStatusSchema = z.enum([
  'pending',
  'firing',
  'done',
  'cancelled',
  'failed',
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleSpecOnceSchema = z.object({
  kind: z.literal('once'),
  fire_at: z.number().int().positive(),
});
export type ScheduleSpecOnce = z.infer<typeof ScheduleSpecOnceSchema>;

export const ScheduleSpecIntervalSchema = z.object({
  kind: z.literal('interval'),
  every_seconds: z.number().int().min(SCHEDULE_MIN_INTERVAL_SECONDS),
  start_at: z.number().int().positive().optional(),
});
export type ScheduleSpecInterval = z.infer<typeof ScheduleSpecIntervalSchema>;

export const ScheduleSpecCronSchema = z.object({
  kind: z.literal('cron'),
  // 5-field UNIX cron expression. Validated at schedule time via
  // cron-parser; minute granularity, no seconds field.
  expression: z.string().min(1).max(200),
  // IANA timezone name (e.g., 'Asia/Shanghai', 'America/New_York').
  // Required so DST behavior is explicit and stable across hosts.
  timezone: z.string().min(1).max(64),
});
export type ScheduleSpecCron = z.infer<typeof ScheduleSpecCronSchema>;

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  ScheduleSpecOnceSchema,
  ScheduleSpecIntervalSchema,
  ScheduleSpecCronSchema,
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export const ScheduleDtoSchema = z.object({
  id: z.string(),
  owner_agent_id: z.string(),
  /** The conversation whose `(conversation, owner_agent)` runtime is woken
   *  up when this schedule fires. The wake message — and the agent's
   *  response/report — both happen in this conversation. Set at create
   *  time and validated against owner agent's membership; v28 backfilled
   *  existing rows from owner's agent_home DM. Never null after v28. */
  target_conversation_id: z.string(),
  /** Server-side derived label for `target_conversation_id`, projected
   *  by the agent-facing schedule list/create response. Format:
   *    - `#<title>`           for a regular channel
   *    - `@<title>`           for a DM channel (workspace_kind agent_home)
   *    - `#<parent>:<title>`  for a thread under a known parent
   *    - `<title>`            for a thread whose parent is missing
   *    - `'Unavailable conversation'` when the target id no longer
   *      resolves (deleted/orphaned).
   *  ACL boundary: this label follows the **schedule's** visibility, not
   *  the target conversation's — once the caller is allowed to see the
   *  schedule, the label is part of the schedule's own semantics
   *  (the schedule describes WHERE it fires) rather than a leaked
   *  metadata projection of the target. The label is intentionally
   *  minimal (title + kind) and never carries workspace path, member
   *  list, parent ids, or any other target-private metadata. */
  target_label: z.string(),
  title: z.string(),
  message: z.string(),
  spec: ScheduleSpecSchema,
  next_fire_at: z.number(),
  status: ScheduleStatusSchema,
  fired_count: z.number(),
  last_fired_at: z.number().nullable(),
  max_occurrences: z.number().nullable(),
  until_at: z.number().nullable(),
  failure_reason: z.string().nullable(),
  cancelled_at: z.number().nullable(),
  /** v39 fire-failure metrics. `cron|interval` schedules whose
   *  individual fire fails do NOT enter terminal `status='failed'`
   *  (only `kind:'once'` does — its plan has no future fire to retry).
   *  Instead these three fields record the most-recent fire failure;
   *  the row stays `pending` with `next_fire_at` advanced to the next
   *  natural cadence tick. `consecutive_failure_count` resets to 0
   *  on the next successful fire. UI/observability layers read these
   *  to surface stuck schedules without auto-terminating them. */
  last_failure_reason: z.string().nullable(),
  last_failure_at: z.number().nullable(),
  consecutive_failure_count: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

// MCP `schedule` input. `delay_seconds` is a convenience for one-shot
// callers — server canonicalizes to `fire_at = now + delay_seconds*1000`
// before persisting; only one of `fire_at`/`delay_seconds` may be set on
// a `once` spec.
export const ScheduleCreateOnceInputSchema = z.object({
  kind: z.literal('once'),
  fire_at: z.number().int().positive().optional(),
  delay_seconds: z.number().int().positive().optional(),
});
export type ScheduleCreateOnceInput = z.infer<
  typeof ScheduleCreateOnceInputSchema
>;

export const ScheduleCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX_LEN),
    message: z.string().min(1).max(SCHEDULE_MESSAGE_MAX_LEN),
    /** Optional. The conversation whose `(conversation, owner_agent)`
     *  runtime should be woken up on each fire — that runtime owns the
     *  full lifecycle: receive wake → produce work → post result, all
     *  in its own context. If omitted, the server defaults to the
     *  conversation the create call was made from (so creating in DM
     *  fires in DM, in a channel fires in that channel, etc.). The
     *  caller must be a member of the target conversation. */
    target_conversation_id: z.string().optional(),
    spec: z.discriminatedUnion('kind', [
      ScheduleCreateOnceInputSchema,
      ScheduleSpecIntervalSchema,
      ScheduleSpecCronSchema,
    ]),
    /** Optional epoch-ms termination for repeat specs. REJECTED on `once`. */
    until_at: z.number().int().positive().optional(),
    /** Optional max-fire-count cap for repeat specs. REJECTED on `once`. */
    max_occurrences: z.number().int().positive().optional(),
    /** Required `true` for repeat specs without `until_at`/`max_occurrences`.
     *  REJECTED on `once` (one-shots fire exactly once and don't need
     *  a "no upper bound" opt-in). */
    allow_unbounded: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.spec.kind === 'once') {
      // Strict-reject (vs silent-ignore) for repeat-only knobs on a one-shot.
      // Silent-ignore would let the agent see a non-canonical DTO that
      // claims `max_occurrences=N` for a row that can only ever fire once,
      // which is worse than a clear 400.
      if (v.until_at !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['until_at'],
          message: 'until_at is not valid on a `once` schedule',
        });
      }
      if (v.max_occurrences !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['max_occurrences'],
          message: 'max_occurrences is not valid on a `once` schedule',
        });
      }
      if (v.allow_unbounded !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allow_unbounded'],
          message: 'allow_unbounded is not valid on a `once` schedule',
        });
      }
      if (!!v.spec.fire_at === !!v.spec.delay_seconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'fire_at'],
          message: 'once spec requires exactly one of fire_at or delay_seconds',
        });
      }
    }
  });
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;

// MCP `list_schedules` input. `status='active'` is a query-side alias
// for "pending OR firing" — the DB never persists the literal `active`.
export const ScheduleListStatusFilterSchema = z.enum([
  'pending',
  'firing',
  'active',
  'done',
  'cancelled',
  'failed',
  'all',
]);
export type ScheduleListStatusFilter = z.infer<
  typeof ScheduleListStatusFilterSchema
>;

export const ScheduleListInputSchema = z.object({
  status: ScheduleListStatusFilterSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ScheduleListInput = z.infer<typeof ScheduleListInputSchema>;

export const ScheduleCancelInputSchema = z.object({
  schedule_id: z.string(),
});
export type ScheduleCancelInput = z.infer<typeof ScheduleCancelInputSchema>;

// MCP / internal-route output DTOs. Single-row responses wrap the full
// `ScheduleDto` so the agent always sees the canonical row (e.g. the
// canonicalized `fire_at` after a `delay_seconds` create), and so the
// list response stays consistent with create/cancel output.
export const ScheduleCreateOutputSchema = z.object({
  schedule: ScheduleDtoSchema,
});
export type ScheduleCreateOutput = z.infer<typeof ScheduleCreateOutputSchema>;

export const ScheduleListOutputSchema = z.object({
  schedules: z.array(ScheduleDtoSchema),
});
export type ScheduleListOutput = z.infer<typeof ScheduleListOutputSchema>;

export const ScheduleCancelOutputSchema = z.object({
  schedule: ScheduleDtoSchema,
});
export type ScheduleCancelOutput = z.infer<typeof ScheduleCancelOutputSchema>;
