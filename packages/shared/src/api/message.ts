// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: message. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  ConversationKindSchema,
  FromKindSchema,
} from '../db/schema.js';
import {
  MessageAttachmentIdsInputSchema,
  SearchOptionalStringSchema,
  hasMessagePayload,
} from './_zod-helpers.js';
import { AttachmentSnapshotSchema } from './attachment.js';
import { ReactionAggregateDtoSchema } from './reactions.js';
import { LinkedTaskDtoSchema } from './task.js';
import { ThreadSummaryInvariantSchema } from './thread-summary.js';
import { MessageSeqSchema } from '../seq.js';

export const MessageDtoSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  from_kind: FromKindSchema,
  from_agent_id: z.string().nullable(),
  from_user_id: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  /** Attachment snapshots attached to this message (null when none).
   *  Mirrored from `metadata.attachments` for typed access. */
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  /** Viewer-scoped reaction aggregates (one per distinct emoji), or null
   *  when the message has no reactions OR the read path did not enrich them.
   *  Lean by design — reactor identities load lazily via
   *  `GET /api/messages/:id/reactions` on hover (docs/reactions-design.md §6).
   *  `viewer_reacted` is relative to the reading principal. */
  reactions: z.array(ReactionAggregateDtoSchema).nullable(),
  seq: MessageSeqSchema,
  created_at: z.number(),
  /** Reply-cluster thread anchor (v43). NULL = root / main-line message;
   *  non-NULL = a reply in the thread rooted at that message id. The thread
   *  is identified by this root id, not a separate conversation. See
   *  docs/thread-reply-cluster-v1.md. */
  thread_root_id: z.string().nullable(),
  /** The task LINKED to this message via its immutable source provenance
   *  (`tasks.source_message_id == this.id`), or null when this message is not a
   *  task's source. Viewer-invariant (this DTO rides the broadcast
   *  `conversation:{id}` scope). A `public`-non-member HTTP read gets null
   *  (boundary strip). Replaces the retired flat `task_*` "message IS task"
   *  projection. See LinkedTaskDtoSchema. */
  linked_task: LinkedTaskDtoSchema.nullable(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

/** S1 projection-level recovery (#task:1276) — authoritative projection patches
 *  the backend attaches to a `message` event so the client can idempotently
 *  MERGE a derived value instead of invalidate→refetch.
 *
 *  VIEWER-INVARIANT ONLY: a `message` event rides the broadcast
 *  `conversation:{id}` scope (one payload fans to every subscriber), so every
 *  field here MUST be identical for all viewers. Per-viewer facts
 *  (e.g. `viewer_following`) are barred — they ride `viewer:{userId}` or fall
 *  back to refetch. All patches carry ABSOLUTE values (never a delta / `+1`) so
 *  they are replay-idempotent. Canonical: docs/projection-recovery-s1-v1.md. */
export const ThreadRootReplyCountPatchSchema = z.object({
  root_id: z.string(),
  /** Authoritative non-system reply count for `root_id`, computed in the SAME
   *  write transaction as the triggering reply insert (never a future-seq
   *  value). Mirrors `replyCountsByRoot` (`from_kind != 'system'`). */
  reply_count: z.number().int().nonnegative(),
});
export type ThreadRootReplyCountPatch = z.infer<
  typeof ThreadRootReplyCountPatchSchema
>;

export const MessageProjectionsSchema = z.object({
  /** Reply-count projection for the replied-to root (P1). Present only when the
   *  triggering message is a reply (`thread_root_id != null`). */
  thread_root_reply_count: ThreadRootReplyCountPatchSchema.optional(),
  /** Threads-list entry projection for the replied-to root (P2,
   *  docs/projection-recovery-s1-v1.md §5/§6). Present only when the triggering
   *  message is a reply. Carries the VIEWER-INVARIANT `ThreadSummaryInvariant`
   *  (no `viewer_following`) plus `root_seq` (the keyset tie-break); the client
   *  merges the invariant fields into the row it already holds and repositions
   *  its page by the documented keyset `(last_reply_at DESC, root_seq DESC)`. NO
   *  insert in P2 v1 — a root not on the client's page falls back to refetch
   *  (off-page insert is deferred to P2.5). The `{ entry }` wrapper reserves room
   *  for future sibling hints without a wire break. */
  threads_list_entry: z
    .object({ entry: ThreadSummaryInvariantSchema })
    .optional(),
});
export type MessageProjections = z.infer<typeof MessageProjectionsSchema>;

/** Wire payload of a `message` event (`kind:'message'`). `message` is the
 *  inserted row; `projections` is the optional S1 authoritative-delta sidecar —
 *  ADDITIVE: a client that ignores it falls back to invalidate→refetch, so the
 *  backend can ship this ahead of the renderer consumer. */
export const MessageEventPayloadSchema = z.object({
  message: MessageDtoSchema,
  projections: MessageProjectionsSchema.optional(),
});
export type MessageEventPayload = z.infer<typeof MessageEventPayloadSchema>;

/** Per-root enriched reply-badge data (#task:1073, P1). Optional sidecar
 *  that augments `reply_counts_by_root` with what a Slack-style inline reply
 *  badge needs beyond a bare count: the most-recent replier identities (for
 *  a stacked-avatar cluster) and the last-reply time. Absent until the
 *  backend populates it — the badge falls back to count-only. Keyed by root
 *  message id. This schema is the canonical reply-badge sidecar contract.
 *
 *  Carries ONLY optimistically-maintainable reply metadata — NOT per-viewer
 *  unread. Unread / first-unread is server-scored and lives in the dedicated
 *  conversation-unread read-model (`ConversationStreamUnreadDto`, `GET
 *  /api/conversations/:id/unread`); the chip reads "N new" from there, never
 *  from this window sidecar (#task:1226). */
export const ReplyBadgeSummarySchema = z.object({
  /** Total non-system replies. Mirrors `reply_counts_by_root` for self-
   *  containment; the count shown still reads `reply_counts_by_root` so the
   *  two never visibly diverge. */
  reply_count: z.number().int().nonnegative(),
  /** Epoch ms of the most recent non-system reply. */
  last_reply_at: z.number(),
  /** Up to 3 distinct most-recent repliers, most-recent first. */
  repliers: z.array(
    z.object({
      kind: z.enum(['agent', 'human']),
      id: z.string(),
    }),
  ),
  /** Full distinct replier count (drives a "+N" overflow past the 3 shown). */
  replier_total: z.number().int().nonnegative(),
});
export type ReplyBadgeSummary = z.infer<typeof ReplyBadgeSummarySchema>;

export const ConversationMessagesDtoSchema = z.object({
  messages: z.array(MessageDtoSchema),
  /** Reply-cluster badge data keyed by root message id. Values are the
   *  total non-system replies in that root's cluster, independent of the
   *  current pagination window. */
  reply_counts_by_root: z.record(z.string(), z.number().int().nonnegative()),
  /** Optional enriched reply-badge sidecar keyed by root message id
   *  (#task:1073, P1). Present only once the backend ships it; consumers
   *  must treat it as possibly-undefined and fall back to count-only. */
  reply_summaries_by_root: z
    .record(z.string(), ReplyBadgeSummarySchema)
    .optional(),
  has_more_before: z.boolean(),
  /** Open-time snapshot of the opened stream's head (#task:1226): the
   *  `conversation_stream_heads.latest_seq` for the requested stream (mainline
   *  when no `thread_root_id`, else that reply-cluster), captured in the SAME
   *  read as this window — never a later/separate query, so a concurrent tail
   *  arriving after the window can't slip into the snapshot. The client echoes
   *  this as an `at_seq` position to `observe()` so the cursor advances to the
   *  open-time head, not to "current latest" — under v1 read-to-clear, opening a
   *  thread marks it read up to this head (the window, latest or
   *  around-first-unread, is a locate view, not a coverage guarantee); the
   *  invariant is only that a concurrent tail (seq > this value) is not
   *  swallowed. Window-independent. 0 for an empty stream. */
  stream_head_seq: MessageSeqSchema,
  /** True when at least one message exists with seq > max(messages.seq).
   *  For the default "latest" window this is always false; for an
   *  anchored window (`before_seq` / `after_seq` / `around_message_id`)
   *  it reflects the real DB state, so a bidirectional infinite query
   *  knows whether to issue a `getNextPageParam`. */
  has_more_after: z.boolean(),
});
export type ConversationMessagesDto = z.infer<typeof ConversationMessagesDtoSchema>;

export const ThreadFollowerStateDtoSchema = z.object({
  /** Canonical reply-cluster root; the request may name either the root
   *  message or any reply in that cluster. */
  thread_root_id: z.string(),
  /** Whether the current human viewer is subscribed to future delivery /
   *  notification for this thread. This is not a permission bit. */
  viewer_following: z.boolean(),
  /** Agent followers that are still visible members of the parent channel.
   *  Renderer uses this to filter channel-level run-state bubbles inside a
   *  thread panel. */
  follower_agent_ids: z.array(z.string()),
});
export type ThreadFollowerStateDto = z.infer<
  typeof ThreadFollowerStateDtoSchema
>;

export const ThreadFollowMutationDtoSchema = z.object({
  thread_root_id: z.string(),
  changed: z.boolean(),
  viewer_following: z.boolean(),
});
export type ThreadFollowMutationDto = z.infer<
  typeof ThreadFollowMutationDtoSchema
>;

export const SendMessageInputSchema = z.object({
  content: z.string(),
  /** Optional attachment ids previously returned by the upload endpoint.
   *  Server validates each id belongs to the same channel as the
   *  destination conversation. */
  attachment_ids: MessageAttachmentIdsInputSchema,
  /** Reply-cluster target message id. A main-line target opens a cluster;
   *  replying to an existing reply joins that reply's root. */
  reply_to_message_id: z.string().min(1).optional(),
}).refine(hasMessagePayload, {
  message: 'message must include text or at least one attachment',
  path: ['content'],
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

/** Per-stream unread for one stream (mainline or a single reply-cluster),
 *  scored server-side against the viewer's own per-stream `conversation_reads`
 *  cursor (#task:1226). `unread_count` 0 ⟺ both first-unread fields null. */
export const StreamUnreadDtoSchema = z.object({
  unread_count: z.number().int().nonnegative(),
  /** First (lowest-seq) unread message in this stream — drives "jump to first
   *  unread". Both null when caught up (`unread_count === 0`). */
  first_unread_message_id: z.string().nullable(),
  first_unread_seq: MessageSeqSchema.nullable(),
});
export type StreamUnreadDto = z.infer<typeof StreamUnreadDtoSchema>;

/** Per-conversation per-viewer stream-unread read-model (#task:1226) — the
 *  SINGLE source of truth for thread / mainline "N new" + first-unread on the
 *  client. The reply chip and the Threads list both read this (keyed by root),
 *  so the same server-scored fact never lives in two caches that drift. Unread
 *  is server-scored (the client can't optimistically derive it), so this lives
 *  OUTSIDE the optimistically-patched message-window cache and is settled from
 *  REST after viewer-scoped `unread_updated` frames or local observe() success.
 *  `threads` is sparse: it carries ONLY roots with unread > 0 (a missing root
 *  means 0). */
export const ConversationStreamUnreadDtoSchema = z.object({
  /** Mainline (non-thread) unread for the viewer. */
  mainline: StreamUnreadDtoSchema,
  /** Per-reply-cluster unread keyed by root message id. Sparse — only roots
   *  with unread > 0 appear; absent root ⇒ 0 unread. */
  threads: z.record(z.string(), StreamUnreadDtoSchema),
});
export type ConversationStreamUnreadDto = z.infer<
  typeof ConversationStreamUnreadDtoSchema
>;

export const MessageUnreadPointerDtoSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string(),
  seq: MessageSeqSchema,
  thread_root_id: z.string().nullable(),
});
export type MessageUnreadPointerDto = z.infer<
  typeof MessageUnreadPointerDtoSchema
>;

export const MessageUnreadByConversationDtoSchema = z.object({
  by_conversation: z.record(z.string(), z.number()),
  latest_by_conversation: z.record(z.string(), MessageUnreadPointerDtoSchema),
  total: z.number(),
});
export type MessageUnreadByConversationDto = z.infer<
  typeof MessageUnreadByConversationDtoSchema
>;

export const MessageUnreadSummaryDtoSchema = z.object({
  by_workspace: z.record(z.string(), z.number()),
});
export type MessageUnreadSummaryDto = z.infer<
  typeof MessageUnreadSummaryDtoSchema
>;

/** The `unread_updated` MESSAGE-variant payload (viewer scope, #task:1283).
 *  Carries authoritative ABSOLUTE unread at each read-model boundary a badge
 *  consumer keys on, so the client idempotently patches the displayed badge
 *  caches instead of invalidate→whole-list refetch. All values are absolute
 *  (never deltas), from the same `ConversationReadRepo` REST serves.
 *  - `conversation_unread_count` → `by_conversation[conversation_id]`
 *  - `workspace_unread_count`    → `by_workspace[workspace_id]`, `total`,
 *                                   favorites row `unread_count`
 *  - `latest_unread` (pointer, not a count) → `latest_by_conversation`;
 *    null ⇒ this conversation has no unread (cleared → delete the key).
 *  The two variants are discriminated SOLELY by `conversation_id` presence:
 *  the MESSAGE variant always carries it, the BADGE variant never does. The
 *  badge variant is not required to be empty (the mark-read route ships
 *  `{marked}`, and observe ships `dismissed_notification_ids` — see
 *  `UnreadUpdatedBadgePayload`); consumers must key on the discriminator, not on
 *  an empty body. See docs/projection-recovery-s1-unread-v1.md. */
export const UnreadUpdatedMessagePayloadSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  conversation_unread_count: z.number(),
  workspace_unread_count: z.number(),
  latest_unread: MessageUnreadPointerDtoSchema.nullable(),
});
export type UnreadUpdatedMessagePayload = z.infer<
  typeof UnreadUpdatedMessagePayloadSchema
>;

/** The `unread_updated` BADGE-variant payload (viewer scope). Discriminated
 *  from the message variant by the ABSENCE of `conversation_id`. Beyond the
 *  discriminator it MAY carry `dismissed_notification_ids` — the notification
 *  ids that just transitioned unread→read in this observe() batch. That field
 *  is consumed by the OS-notification-dismiss projection (#task:1431): the same
 *  "notification read" domain fact that refreshes the badge count also tells the
 *  desktop main process which OS notifications to `.close()`, so no read
 *  predicate is re-derived on the client. Other producers (the mark-read route)
 *  carry `marked` instead; both are optional and non-load-bearing for the badge
 *  count itself, which the client always refetches. */
export interface UnreadUpdatedBadgePayload {
  dismissed_notification_ids?: string[];
  marked?: number;
}

const SearchOptionalMillisSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

export const SearchScopeSchema = z.enum(['all', 'regular', 'dm']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

// Stream scope for message search (#task:1334). `all` searches both the
// mainline and every thread of the matched conversation(s) — the historical
// behaviour. `mainline` / `thread` narrow to a single renderable stream of
// ONE conversation, backing the header inline find: the filter uses the same
// predicate as the message-window read-model, so a hit is always
// materializable in the panel that issued it ("搜到必可见").
export const SearchStreamSchema = z.enum(['all', 'mainline', 'thread']);
export type SearchStream = z.infer<typeof SearchStreamSchema>;

// Result ordering. `recency_desc` (default) is discovery order. `seq_asc`
// is conversation order for inline prev/next navigation — only meaningful
// within a single conversation, so it is gated on `conversation_id`.
export const SearchOrderSchema = z.enum(['recency_desc', 'seq_asc']);
export type SearchOrder = z.infer<typeof SearchOrderSchema>;

export const SearchQueryInputSchema = z
  .object({
    q: z.string().trim().max(200).optional().default(''),
    scope: SearchScopeSchema.optional().default('all'),
    stream: SearchStreamSchema.optional().default('all'),
    workspace_id: SearchOptionalStringSchema,
    conversation_id: SearchOptionalStringSchema,
    thread_root_id: SearchOptionalStringSchema,
    user_id: SearchOptionalStringSchema,
    agent_id: SearchOptionalStringSchema,
    from: SearchOptionalMillisSchema,
    to: SearchOptionalMillisSchema,
    order: SearchOrderSchema.optional().default('recency_desc'),
    // Cap raised to 500 so inline find can return a complete single-stream
    // match set for prev/next; advanced search callers keep the 80 default.
    limit: z.coerce.number().int().positive().max(500).optional().default(80),
  })
  .refine(v => !(v.user_id && v.agent_id), {
    message: 'user_id and agent_id cannot both be set',
    path: ['user_id'],
  })
  // A stream only exists within a conversation; narrowing to one requires
  // naming which conversation.
  .refine(v => v.stream === 'all' || !!v.conversation_id, {
    message: 'stream filter requires conversation_id',
    path: ['stream'],
  })
  // Thread scope needs the anchoring root message id.
  .refine(v => v.stream !== 'thread' || !!v.thread_root_id, {
    message: 'stream=thread requires thread_root_id',
    path: ['thread_root_id'],
  })
  // seq is per-conversation; ordering by it across conversations is
  // meaningless, so seq_asc is gated on a single-conversation scope.
  .refine(v => v.order !== 'seq_asc' || !!v.conversation_id, {
    message: 'order=seq_asc requires conversation_id',
    path: ['order'],
  });
export type SearchQueryInput = z.infer<typeof SearchQueryInputSchema>;

export const SearchWorkspaceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['regular', 'dm']),
});
export type SearchWorkspaceRef = z.infer<typeof SearchWorkspaceRefSchema>;

export const SearchConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ConversationKindSchema,
  channel_id: z.string(),
  closed_at: z.number().nullable(),
  created_at: z.number(),
});
export type SearchConversationRef = z.infer<typeof SearchConversationRefSchema>;

export const SearchResultDtoSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace'),
    workspace: SearchWorkspaceRefSchema.extend({
      description: z.string().nullable(),
      archived_at: z.number().nullable(),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  }),
  z.object({
    type: z.literal('conversation'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
  }),
  z.object({
    type: z.literal('message'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
    message: MessageDtoSchema,
    /** The author agent's immutable `@handle` (`agents.name`), or `null` for
     *  user messages — same field as `SavedMessageDto.agent_name`, same
     *  reason it needs no identity invalidation (#task:1705). */
    agent_name: z.string().nullable(),
  }),
]);
export type SearchResultDto = z.infer<typeof SearchResultDtoSchema>;

export const SearchDtoSchema = z.object({
  query: SearchQueryInputSchema,
  results: z.array(SearchResultDtoSchema),
  // Total message matches for the query BEFORE the result cap, and whether
  // the returned list was truncated to `limit`. Drives the inline find
  // "2 / 7" (exact) vs "2 / 200+" (truncated) counter and tells the
  // renderer prev/next only spans the returned set. Named-entity
  // (workspace/conversation) results are not counted here — this is the
  // message-match total. (#task:1334)
  total: z.number(),
  truncated: z.boolean(),
});
export type SearchDto = z.infer<typeof SearchDtoSchema>;

//
// One global flat list — no per-channel grouping, no tags. Each entry
// joins back to the source message + its workspace/conversation so the Saved
// view can render content + jump back to the conversation.
export const SavedMessageDtoSchema = z.object({
  id: z.string(),
  message: MessageDtoSchema,
  workspace_id: z.string(),
  workspace_name: z.string(),
  conversation_id: z.string(),
  conversation_title: z.string(),
  channel_id: z.string(),
  /**
   * The author agent's immutable `@handle` (`agents.name`), or `null` for
   * user messages. NOT a display-name snapshot: `name` is decided at agent
   * creation and never editable, so a later profile rename does not change
   * this value and there is no "historical vs current name" question to
   * settle. It is therefore exempt from live identity invalidation — the
   * mutable carriers are `display_name` / `avatar_url` (#task:1705).
   */
  agent_name: z.string().nullable(),
  saved_at: z.number(),
});
export type SavedMessageDto = z.infer<typeof SavedMessageDtoSchema>;

/** Query for `GET /api/saved` (#task:1258). Mirrors
 *  `ArchivedChannelsQueryInputSchema`: the Saved view filters SERVER-SIDE so the
 *  filters act over the whole saved history, not the `LIMIT`-capped client
 *  window (a client-side date/workspace filter would silently drop saved
 *  messages older than the newest N). `workspace_id` narrows to one workspace
 *  (omitted = all workspaces the caller can see); `since` is `saved_at >= since`
 *  (epoch ms) — the SAVE-time window, not message created/updated time, matching
 *  the list's `saved_at DESC` order. Both are applied before `ORDER BY … LIMIT`. */
export const SavedMessagesQueryInputSchema = z.object({
  workspace_id: z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  since: z.preprocess(
    v => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().nonnegative().optional(),
  ),
});
export type SavedMessagesQueryInput = z.infer<typeof SavedMessagesQueryInputSchema>;

//
// Single source of truth for what "@name" means in a message body.
// Mirrors the renderer-side regex in `Markdown.tsx` and the
// composer-side detector — the boundary check rejects emails (`me@x`)
// and paths (`a/@b`), and the alpha-first requirement rejects issue
// refs like `@123`. Aligned with auth-signup generated user names
// (alpha-first by design: `users.name` is the permanent mention
// anchor). `CreateAgentInputSchema.name` is intentionally broader
// (`/^[a-zA-Z0-9_-]+$/`, allows numeric-first); a numeric-first
// agent name will not be `@`-mentionable until/unless that schema
// is tightened — out of scope for the registration rewrite.
const MENTION_RE = /(?<![\w/])@([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Returns the unique set of @-names referenced in `text`, in
 *  first-occurrence order. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
