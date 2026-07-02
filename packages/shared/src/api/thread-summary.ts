// NEW for thread-discovery P2 (#task:1074). Bounded context: message /
// reply-cluster discovery. Kept in its own file (not message.ts) to avoid
// colliding with the in-flight task.ts / system-messages.ts `thread_root_id`
// edits. Re-exported via api/index.ts → @silverhand/shared.
//
// This is the contract for `GET /api/conversations/:id/threads` — the
// per-channel "Threads" list (every reply-cluster in one channel, newest
// activity first). The path takes a conversation id but only resolves
// channel / dm_channel. This file is the canonical contract for that endpoint.
import { z } from 'zod';
import { MessageSeqSchema } from '../seq.js';

/** Author identity kind for a thread row. 'human' mirrors the
 *  principal-level vocabulary (DB `principal_kind`); the storage column
 *  `from_kind = 'user'` maps to 'human' here so the frontend resolves it
 *  through the same human/agent avatar hooks. */
export const ThreadAuthorKindSchema = z.enum(['agent', 'human', 'system']);
export type ThreadAuthorKind = z.infer<typeof ThreadAuthorKindSchema>;

export const ThreadAuthorSchema = z.object({
  kind: ThreadAuthorKindSchema,
  /** Agent id (kind='agent') or user id (kind='human'); '' for a
   *  system-authored root, which carries neither. */
  id: z.string(),
});
export type ThreadAuthor = z.infer<typeof ThreadAuthorSchema>;

/** Repliers are never system (system messages are excluded from a cluster's
 *  reply set), so the kind is the narrower human/agent pair. */
export const ThreadReplierSchema = z.object({
  kind: z.enum(['agent', 'human']),
  id: z.string(),
});
export type ThreadReplier = z.infer<typeof ThreadReplierSchema>;

/** One reply-cluster summary row. The frontend resolves avatar/name from
 *  `*_author` / `repliers` identities via the existing batch avatar hooks —
 *  no avatar URLs are inlined here. */
export const ThreadSummarySchema = z.object({
  root_message_id: z.string(),
  root_author: ThreadAuthorSchema,
  /** Plain-text preview of the root content, server-truncated to <= 160 chars
   *  (raw text; the frontend handles final ellipsis + mention sigils). */
  root_preview: z.string(),
  root_created_at: z.number(),
  /** Root message's conversation-global `MessageSeq`. This is the **tie-break
   *  half of the list keyset** `(last_reply_at DESC, root_seq DESC)`
   *  (`message-repo.ts:578`) — `last_reply_at` can tie to the millisecond across
   *  roots, and the server resolves the tie by `root.seq DESC`. Exposed so the
   *  client can reproduce the server's total order EXACTLY when it repositions a
   *  row from an S1 `threads_list_entry` patch (docs/projection-recovery-s1-v1.md
   *  §6) — there is one documented keyset, applied to authoritative values, so
   *  the client order is a deterministic function of authority and cannot drift.
   *  Additive (the value was always computed at `message-repo.ts:552`, just not
   *  surfaced). */
  root_seq: MessageSeqSchema,

  /** Non-system replies only — matches `replyCountsByRoot` / the inline badge. */
  reply_count: z.number().int().nonnegative(),
  /** epoch ms; created_at of the most-recent (max-seq) non-system reply. */
  last_reply_at: z.number(),
  last_reply_message_id: z.string(),

  /** Up to 3 DISTINCT repliers, most-recent first (for stacked avatars).
   *  `replier_total` is the full distinct replier count (for "+N" overflow). */
  repliers: z.array(ThreadReplierSchema),
  replier_total: z.number().int().nonnegative(),

  /** Whether the requesting viewer follows this cluster (`thread_followers`,
   *  principal_kind='human'). Drives the followed→sticker / non-followed→dot
   *  split (§5) and mirrors the sidebar roll-up's "followed" set. Read-only
   *  projection of the delivery-subscription table — never written here.
   *
   *  Per-thread unread / first-unread is NOT carried here — it is server-scored
   *  and lives in the dedicated conversation-unread read-model
   *  (`ConversationStreamUnreadDto`, `GET /api/conversations/:id/unread`) that
   *  the Threads list and the reply chip both read by root, so the same fact
   *  never sits in two payloads (#task:1226). */
  viewer_following: z.boolean(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** The VIEWER-INVARIANT subset of `ThreadSummary` — every field except the
 *  per-viewer `viewer_following` (`thread_followers`, principal-scoped). This is
 *  the exact shape an S1 `threads_list_entry` projection carries on the broadcast
 *  `conversation:{id}` message frame (docs/projection-recovery-s1-v1.md §3/§5):
 *  the frame fans one payload to every subscriber, so it can carry ONLY
 *  viewer-invariant facts. The client merges these invariant fields into the row
 *  it already holds and KEEPS its own cached `viewer_following` (it cannot be
 *  defaulted here without the client inventing a viewer fact — Cindy gate ③).
 *  Derived from `ThreadSummarySchema` (one source of truth, no field drift). */
export const ThreadSummaryInvariantSchema = ThreadSummarySchema.omit({
  viewer_following: true,
});
export type ThreadSummaryInvariant = z.infer<
  typeof ThreadSummaryInvariantSchema
>;

export const ListChannelThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
  /** Opaque keyset continuation token over (last_reply_at, root seq). Null
   *  when the final page has been returned. */
  next_cursor: z.string().nullable(),
});
export type ListChannelThreadsResponse = z.infer<
  typeof ListChannelThreadsResponseSchema
>;
