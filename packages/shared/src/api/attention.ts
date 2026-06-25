// Attention bounded context — read-side (CQRS) projection of the human's
// "queue waiting on me" (#task:1227). Bounded context: Attention (internal);
// user-facing surface/feature name: Activity. Re-exported via api/index.ts →
// @silverhand/shared. Canonical: docs/activity-lifecycle-v1.md.
//
// v1 (②a) defines the ONE write-side aggregate Attention owns: the per-(viewer,
// channel) ambient preference (the channel `所有消息 / 仅提及` control). It is a
// user DECISION → owned state (建表准入测试, §4.2); everything else Attention
// surfaces (positional unread / directed mentions / tasks) is a projection.
import { z } from 'zod';

/**
 * Channel ambient attention mode (§6 / §13.3). The internal model is a single
 * ambient on/off; the user wording is 所有消息 / 仅提及 (the renderer maps the
 * label, never the internal word):
 *   - `all`      = ambient ON  → the channel's mainline ambient unread enters
 *                  the Activity list.
 *   - `mentions` = ambient OFF → ambient unread stays an in-place hint only;
 *                  directed claims (@me / task / DM) still enter unconditionally.
 */
export const CHANNEL_ATTENTION_MODES = ['all', 'mentions'] as const;
export type ChannelAttentionMode = (typeof CHANNEL_ATTENTION_MODES)[number];

/** Channel default = ambient OFF (§6: channel → off unless set to 所有消息).
 *  Absence of a stored preference resolves to this. Single source so the read
 *  path and `enter()` (②c) never disagree on the default. */
export const DEFAULT_CHANNEL_ATTENTION_MODE: ChannelAttentionMode = 'mentions';

/** The viewer's effective ambient preference for one channel (GET / PUT
 *  `/api/conversations/:id/attention-preference`). `mode` is always resolved —
 *  the default is applied server-side when no row exists, so the client never
 *  branches on "unset". */
export const ChannelAttentionPreferenceDtoSchema = z.object({
  conversation_id: z.string(),
  mode: z.enum(CHANNEL_ATTENTION_MODES),
});
export type ChannelAttentionPreferenceDto = z.infer<
  typeof ChannelAttentionPreferenceDtoSchema
>;

/** PUT body for setting the viewer's ambient preference for a channel. This is
 *  the ONLY surface that writes attention state (§5.2); it never touches
 *  delivery/follow. */
export const SetChannelAttentionPreferenceInputSchema = z.object({
  mode: z.enum(CHANNEL_ATTENTION_MODES),
});
export type SetChannelAttentionPreferenceInput = z.infer<
  typeof SetChannelAttentionPreferenceInputSchema
>;

// ───────────────────────────── Activity list (②c) ─────────────────────────────
//
// `GET /api/activity` returns the viewer's Activity list — the projection of
// `listActivity(viewer, scope)` (§9.2). Pure read side: every item is computed
// from an existing source (per-stream cursor read-model / `notifications` /
// `messages.task_*`), NEVER from an Attention-owned copy. The server returns the
// list already `enter()`-filtered (§6), per-(viewer, message) de-duplicated (§7),
// and salience-sorted (§13.2: directed tier first, most-recent-first within tier).

/**
 * Salience tier (§5.2) — derived, never stored. `directed` items are visually
 * stronger and sort above `ambient`. DM unread is positional by mechanism but
 * `directed`-grade by salience (§5.1: "永远进, directed-grade").
 */
export const ACTIVITY_SALIENCES = ['directed', 'ambient'] as const;
export type ActivitySalience = (typeof ACTIVITY_SALIENCES)[number];

/**
 * The claim class of an Activity item — drives the icon and the eliminate route
 * (§5.3). `mention` / `agent_failed` clear via `notifications.read_at`; `unread`
 * clears via the stream cursor (`observe`); `task` is resolve-cleared (no
 * `Mark as read`, its disappearance is anchored on `task_status`).
 *   - `mention`      = a `mention_self` notification (directed @me).
 *   - `agent_failed` = an `agent_start_failed` notification (the viewer's agent).
 *   - `task`         = a task assigned to the viewer that needs action.
 *   - `unread`       = a positional stream's ambient/DM unread aggregate.
 */
export const ACTIVITY_ITEM_KINDS = [
  'mention',
  'agent_failed',
  'task',
  'unread',
] as const;
export type ActivityItemKind = (typeof ACTIVITY_ITEM_KINDS)[number];

/** One row in the Activity list. Heterogeneous by `kind`: directed
 *  single-event items (`mention` / `agent_failed` / `task`) anchor on one
 *  message/task; an `unread` item is a per-STREAM aggregate (§7.3) carrying a
 *  count and anchored at its first-unread message. */
export const ActivityItemDtoSchema = z.object({
  /** Stable synthesized id for client list keys (not a stored row id). */
  id: z.string(),
  kind: z.enum(ACTIVITY_ITEM_KINDS),
  salience: z.enum(ACTIVITY_SALIENCES),
  /** Source routing (the §5.3 source_ref). */
  workspace_id: z.string(),
  conversation_id: z.string(),
  /** Which stream: NULL = mainline / channel-level; non-NULL = that reply
   *  cluster. Carried for `mention` items too, so routing reaches the thread. */
  thread_root_id: z.string().nullable(),
  /** The anchor message the item points at. NULL for `agent_failed` (no message)
   *  and `task` (anchored on the task, see `task_number`). */
  message_id: z.string().nullable(),
  /** 来源标识: the conversation (channel/DM) title. */
  title: z.string(),
  /** Short preview of the anchor (message excerpt / failure summary). */
  preview: z.string().nullable(),
  /** Recency used for the within-tier sort (epoch ms). */
  timestamp: z.number(),
  /** `unread` items: count of ambient unread in the stream, already net of any
   *  directed claims in it (§8 `positional \ directed`). NULL for directed
   *  single-event items. */
  unread_count: z.number().int().nonnegative().nullable(),
  /** `task` items only. */
  task_number: z.number().int().nullable(),
  task_status: z.string().nullable(),
});
export type ActivityItemDto = z.infer<typeof ActivityItemDtoSchema>;

/** `GET /api/activity` response. `items` is the fully-resolved list (filtered,
 *  deduped, sorted) — the client renders it as-is and never re-scores. */
export const ListActivityDtoSchema = z.object({
  items: z.array(ActivityItemDtoSchema),
});
export type ListActivityDto = z.infer<typeof ListActivityDtoSchema>;
