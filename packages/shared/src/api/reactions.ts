// Bounded context: message reactions (docs/reactions-design.md §12).
// Re-exported via api/index.ts → @silverhand/shared. Shared between the
// backend (write use-cases, read-model, routes), the CLI, and the renderer
// so the contract (DTO shapes, event payload, emoji validation) lives in
// exactly one place.
import { z } from 'zod';

/** A reaction's reactor is a Principal projection: user or agent. System
 *  principals never react (route layer rejects them), so 'system' is not a
 *  legal reactor kind — mirrors `messages.from_kind` minus 'system'. */
export const ReactorKindSchema = z.enum(['user', 'agent']);
export type ReactorKind = z.infer<typeof ReactorKindSchema>;

/** Viewer-scoped aggregate carried on `MessageDto.reactions` (one row per
 *  distinct emoji on the message). Deliberately lean — just what a chip
 *  needs to render — so a 200-message window stays cheap (§6). Reactor
 *  identities are NOT inlined here; they load lazily via the detail
 *  endpoint on hover (§3.5). */
export const ReactionAggregateDtoSchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  /** True when the message's viewer (the requesting principal) has this
   *  emoji on this message. For a human read that's the user; for agent
   *  read-history it's that agent. */
  viewer_reacted: z.boolean(),
});
export type ReactionAggregateDto = z.infer<typeof ReactionAggregateDtoSchema>;

/** One reactor in the lazy hover detail. `display_name` is resolved
 *  server-side (single-message join — cheap) so the renderer needn't
 *  cross-reference the directory. */
export const ReactionReactorDtoSchema = z.object({
  kind: ReactorKindSchema,
  id: z.string(),
  display_name: z.string(),
});
export type ReactionReactorDto = z.infer<typeof ReactionReactorDtoSchema>;

/** GET /api/messages/:id/reactions — per-emoji reactor lists for the
 *  hover tooltip ("who reacted"). Returned as an array, most-reacted /
 *  insertion order preserved by the read-model. */
export const MessageReactionDetailDtoSchema = z.object({
  emoji: z.string(),
  reactors: z.array(ReactionReactorDtoSchema),
});
export type MessageReactionDetailDto = z.infer<
  typeof MessageReactionDetailDtoSchema
>;

/** Human route body (POST/DELETE /api/messages/:id/reactions). The message
 *  id is in the path. */
export const ReactMessageInputSchema = z.object({
  emoji: z.string(),
});
export type ReactMessageInput = z.infer<typeof ReactMessageInputSchema>;

/** Internal agent route body (POST/DELETE …/react-message). Carries the
 *  message id because the agent route is conversation-scoped, not
 *  message-scoped. */
export const AgentReactMessageInputSchema = z.object({
  message_id: z.string().min(1),
  emoji: z.string(),
});
export type AgentReactMessageInput = z.infer<
  typeof AgentReactMessageInputSchema
>;

/** WS `message_reaction_changed` payload (scope `conversation:<cid>`).
 *  `count` is the authoritative post-change server aggregate for this
 *  emoji on this message — the renderer sets it absolutely, never +/- by
 *  `op` (replay/optimistic safety, §5.2). `reactor_kind`/`reactor_id`
 *  let the renderer flip `viewer_reacted` only when the reactor is the
 *  current viewer. `thread_root_id` routes the patch to the right stream
 *  (main vs reply-cluster). */
export const MessageReactionChangedEventSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  thread_root_id: z.string().nullable(),
  emoji: z.string(),
  op: z.enum(['add', 'remove']),
  reactor_kind: ReactorKindSchema,
  reactor_id: z.string(),
  count: z.number().int().nonnegative(),
});
export type MessageReactionChangedEvent = z.infer<
  typeof MessageReactionChangedEventSchema
>;

/** WS event kind constant — the open `EventFrame.kind` string this feature
 *  publishes (ws-frames keeps `kind` an open string; we don't tighten it
 *  to a union, per §12.I). */
export const MESSAGE_REACTION_CHANGED_EVENT = 'message_reaction_changed';

// ── emoji validation (§5.3) ──────────────────────────────────────────
// Conservative, slock-borrowed rule: trim non-empty, no internal
// whitespace, char length ≤ 16, and only emoji code points. We do NOT
// try to count grapheme clusters / ZWJ sequences — a char cap is the
// boundary slock ships and it's simpler than getting ZWJ exactly right.

/** Max length in UTF-16 code units (slock parity). A multi-code-point ZWJ
 *  emoji (e.g. 👨‍👩‍👧) is well under this. */
export const MAX_REACTION_EMOJI_LENGTH = 16;

/** Only emoji code points (and their components, e.g. skin-tone / ZWJ).
 *  Mirrors slock's `^(\p{Extended_Pictographic}|\p{Emoji_Component})+$`. */
const REACTION_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;

/** Stable error code surfaced to CLI / renderer when an emoji is rejected. */
export const INVALID_REACTION_CODE = 'invalid_reaction';

export type ValidateReactionEmojiResult =
  | { ok: true; emoji: string }
  | { ok: false; code: typeof INVALID_REACTION_CODE; reason: string };

/** Validate + normalize a reaction emoji. Returns the trimmed emoji on
 *  success. Authoritative server-side check; the CLI pre-checks with the
 *  same function for a fast local error. */
export function validateReactionEmoji(
  raw: string,
): ValidateReactionEmojiResult {
  const emoji = raw.trim();
  if (emoji.length === 0) {
    return { ok: false, code: INVALID_REACTION_CODE, reason: 'emoji is empty' };
  }
  if (/\s/u.test(emoji)) {
    return {
      ok: false,
      code: INVALID_REACTION_CODE,
      reason: 'emoji must not contain whitespace',
    };
  }
  if (emoji.length > MAX_REACTION_EMOJI_LENGTH) {
    return {
      ok: false,
      code: INVALID_REACTION_CODE,
      reason: `emoji exceeds ${MAX_REACTION_EMOJI_LENGTH} chars`,
    };
  }
  if (!REACTION_EMOJI_RE.test(emoji)) {
    return {
      ok: false,
      code: INVALID_REACTION_CODE,
      reason: 'emoji must be a Unicode emoji',
    };
  }
  return { ok: true, emoji };
}
