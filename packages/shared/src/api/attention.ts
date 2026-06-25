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
 * clears via the stream cursor (`observe`).
 *   - `mention`      = a `mention_self` notification (directed @me).
 *   - `agent_failed` = an `agent_start_failed` notification (the viewer's agent).
 *   - `unread`       = a positional stream's ambient/DM unread aggregate.
 *
 * NOTE — there is no `task` kind in v1 (shiki 2026-06-26). A standing
 * `in_review && member` projection of task state mirrored the task panel as a
 * permanent, non-eliminable item; tasks belong in the task panel. A task source
 * re-enters Activity only when it is event-shaped & notification-backed
 * (`task_needs_review`), read-cleared like a mention — see
 * docs/activity-lifecycle-v1.md §5.1 (v2).
 */
export const ACTIVITY_ITEM_KINDS = [
  'mention',
  'agent_failed',
  'unread',
] as const;
export type ActivityItemKind = (typeof ACTIVITY_ITEM_KINDS)[number];

/** One row in the Activity list. Heterogeneous by `kind`: directed
 *  single-event items (`mention` / `agent_failed`) anchor on one message; an
 *  `unread` item is a per-STREAM aggregate (§7.3) carrying a count and anchored
 *  at its first-unread message.
 *
 *  §5.3 answerability — every item's eliminate route (source_ref-out) is
 *  reconstructable from EXPLICIT fields here; `id` is a render list key ONLY and
 *  MUST NOT be parsed for source routing:
 *    - `mention` / `agent_failed` → set `notifications.read_at` by
 *      `notification_id`.
 *    - `unread`                   → advance the stream cursor (`observe`) keyed
 *      by `conversation_id` + `thread_root_id`. */
export const ActivityItemDtoSchema = z.object({
  /** Stable synthesized list key for the client (NOT a stored row id, and NOT a
   *  source_ref — never parse it; use the explicit source fields below). */
  id: z.string(),
  kind: z.enum(ACTIVITY_ITEM_KINDS),
  salience: z.enum(ACTIVITY_SALIENCES),
  /** Source routing (the §5.3 source_ref). */
  workspace_id: z.string(),
  conversation_id: z.string(),
  /** Which stream: NULL = mainline / channel-level; non-NULL = that reply
   *  cluster. Carried for `mention` items too, so routing reaches the thread. */
  thread_root_id: z.string().nullable(),
  /** The anchor message the item points at. NULL only for `agent_failed` (no
   *  anchor message — pure `read_at` clearing). `mention` / `unread` carry the
   *  anchor message id. */
  message_id: z.string().nullable(),
  /** The notification this item eliminates through (`notifications.read_at`).
   *  Set for `mention` / `agent_failed`; NULL for `unread` (which clears via the
   *  stream cursor). This is the source_ref-out for directed notification-backed
   *  claims — the renderer marks read BY this id, never by parsing `id`. */
  notification_id: z.string().nullable(),
  /** The kind of the anchoring conversation (channel vs DM). `thread`-ness is NOT
   *  a conversation kind here — a thread item carries the PARENT channel/DM kind
   *  and signals its thread-ness via `thread_root_id != null`. Drives the row-1
   *  "where" label (Channel / DM). */
  conversation_kind: z.enum(['channel', 'dm_channel']),
  /** Row-1 location title: ALWAYS the conversation (channel/DM) title — never a
   *  message excerpt. Stable across kinds so the renderer's "where" line has one
   *  meaning. */
  title: z.string(),
  /** For a thread item (`thread_root_id != null`): a one-line excerpt of the
   *  thread's ROOT message, rendered above the reply `preview` so the row reads
   *  root → reply. NULL for non-thread items (mainline unread, channel mention,
   *  agent_failed) — there is no distinct root to show. */
  thread_root_preview: z.string().nullable(),
  /** Short preview of the anchor (message excerpt / failure summary). For a
   *  thread item this is the REPLY content (paired with `thread_root_preview`). */
  preview: z.string().nullable(),
  /** Recency used for the within-tier sort (epoch ms). */
  timestamp: z.number(),
  /** `unread` items: count of ambient unread in the stream, already net of any
   *  directed claims in it (§8 `positional \ directed`). NULL for directed
   *  single-event items. */
  unread_count: z.number().int().nonnegative().nullable(),
});
export type ActivityItemDto = z.infer<typeof ActivityItemDtoSchema>;

/** `GET /api/activity` response. `items` is the fully-resolved list (filtered,
 *  deduped, sorted) — the client renders it as-is and never re-scores. */
export const ListActivityDtoSchema = z.object({
  items: z.array(ActivityItemDtoSchema),
});
export type ListActivityDto = z.infer<typeof ListActivityDtoSchema>;
