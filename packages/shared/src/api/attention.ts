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
