// NEW for thread-discovery P2 (#task:1074). Bounded context: message /
// reply-cluster discovery. Kept in its own file (not message.ts) to avoid
// colliding with the in-flight task.ts / system-messages.ts `thread_root_id`
// edits. Re-exported via api/index.ts → @silverhand/shared.
//
// This is the contract for `GET /api/channels/:id/threads` — the per-channel
// "Threads" list (every reply-cluster in one channel, newest activity first).
// See docs/thread-discovery-p2-requirements.md.
import { z } from 'zod';

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

  /** Non-system replies only — matches `replyCountsByRoot` / the inline badge. */
  reply_count: z.number().int().nonnegative(),
  /** epoch ms; created_at of the most-recent (max-seq) non-system reply. */
  last_reply_at: z.number(),
  last_reply_message_id: z.string(),

  /** Up to 3 DISTINCT repliers, most-recent first (for stacked avatars).
   *  `replier_total` is the full distinct replier count (for "+N" overflow). */
  repliers: z.array(ThreadReplierSchema),
  replier_total: z.number().int().nonnegative(),

  /** OPTIONAL (P2.1). Omitted in P2: the only read marker today
   *  (`conversation_reads.last_read_seq`) is per-conversation, not
   *  per-thread-stream, so it cannot express per-cluster unread without
   *  lying. Lands once a per-stream read primitive exists. */
  unread_count: z.number().int().nonnegative().optional(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const ListChannelThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummarySchema),
  /** Opaque keyset continuation token over (last_reply_at, root seq). Null
   *  when the final page has been returned. */
  next_cursor: z.string().nullable(),
});
export type ListChannelThreadsResponse = z.infer<
  typeof ListChannelThreadsResponseSchema
>;
