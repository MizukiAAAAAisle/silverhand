# Thread discovery P2 — channel Threads list (backend requirements)

Status: **requirements / hand-off**. Owner of this doc: @Norman (frontend).
Backend implementer: TBD (assigned via the thread-reply-cluster / `thread_root_id`
work thread). Tracking task: #task:1073.

## Why

Today a message that has a thread is discoverable only by the inline reply
badge on its row (`MessageItem` → "N replies"). In a busy channel the only way
to find which messages have threads — or to catch up on thread activity — is to
scroll the whole message stream one row at a time. Slack solves this with a
global **Threads** inbox; Discord with a per-channel **Threads** list in the
channel header. P2 brings the contained, high-leverage half of that to
silverhand: a **per-channel Threads list** — every reply-cluster in the current
channel, newest activity first, one click to open the existing `ThreadPanel`.

A workspace-wide Threads inbox (Slack-style, cross-channel) is the larger
sibling and is **out of scope** for P2 (future, NavRail-level surface).

## Frontend deliverable (context — built by @Norman, not part of this ask)

- A "Threads" toggle in the `ChannelView` header opens a list in the right pane.
- The list renders one row per thread: root author + preview, up to 3 replier
  avatars, "N replies", last-reply relative time, and (if available) an unread
  marker. Rows are sorted by last reply, newest first. Click → open that
  thread's `ThreadPanel`; a back affordance returns to the list.
- Loading / empty ("No threads in this channel yet") / error states.

The frontend consumes **one new backend endpoint** described below. Everything
in this doc is that endpoint's contract.

## Backend deliverable

### 1. Endpoint

```
GET /conversations/:conversationId/threads?limit=<n>&cursor=<opaque>
```

- **Auth**: same gate as reading the conversation (`canViewConversation`).
  A caller who cannot view the channel gets the conversation's normal
  not-found/forbidden response — the thread list must not leak existence.
- **Scope**: `conversationId` must be a `channel` (or `thread`'s parent
  channel); threads are reply-clusters within that one conversation. Calling on
  an unsupported conversation kind → the existing unsupported error shape.
- **Pagination**: `limit` (default 30, cap 50). `cursor` is an opaque
  continuation token; absent = first page. Order is **last_reply_at DESC, then
  root seq DESC** as a stable tiebreak. Response returns `next_cursor` (null
  when exhausted). Keyset/seek pagination over `(last_reply_at, root_seq)` is
  preferred over offset.

### 2. Response DTO (proposed shared schema)

Proposed home: a new `packages/shared/src/api/thread-summary.ts` (new file to
avoid collision with the in-flight `task.ts` / `system-messages.ts` edits).
Zod + exported types, re-exported from the shared barrel.

```ts
// One reply-cluster summary row.
export interface ThreadSummary {
  root_message_id: string;
  // Root message author identity (frontend resolves avatar/name via the
  // existing batch avatar hooks — do NOT inline avatar URLs here).
  root_author: { kind: 'agent' | 'human' | 'system'; id: string };
  // Plain-text preview of the root content, server-truncated to <= 160 chars
  // (raw message text; the frontend handles final ellipsis + mention sigils).
  root_preview: string;
  root_created_at: number; // epoch ms

  reply_count: number;          // non-system replies only (matches existing
                                // replyCountsByRoot semantics)
  last_reply_at: number;        // epoch ms; max(created_at) of non-system replies
  last_reply_message_id: string;

  // Up to 3 DISTINCT most-recent repliers (for stacked avatars), most-recent
  // first. `replier_total` is the distinct replier count (for a "+N" overflow).
  repliers: Array<{ kind: 'agent' | 'human'; id: string }>;
  replier_total: number;

  // OPTIONAL (see §4). Omit the field entirely if no read marker is available.
  unread_count?: number;
}

export interface ListChannelThreadsResponse {
  threads: ThreadSummary[];
  next_cursor: string | null;
}
```

### 3. Query semantics

Source of truth is the reply-cluster spine (migration 43,
`thread_reply_cluster_spine`): a reply has `thread_root_id = <root id>`, a root
has `thread_root_id IS NULL`, all within one `conversation_id`. Index
`idx_messages_thread_root (conversation_id, thread_root_id, seq)` already exists.

Per channel, a "thread" = any root message that has **>= 1 non-system reply**.
For each such root, aggregate over its replies (`thread_root_id = root.id`,
`from_kind != 'system'`, same `conversation_id`):

- `reply_count` = COUNT(*)
- `last_reply_at` = MAX(created_at); `last_reply_message_id` = the id at that max
- `repliers` = DISTINCT (from_kind, from_agent_id|from_user_id), ordered by most
  recent reply, limited to 3; `replier_total` = full distinct count
- root fields (`root_author`, `root_preview`, `root_created_at`) come from the
  root message row

This generalizes the existing `MessageRepo.replyCountsByRoot` (which counts
`from_kind != 'system'` replies for a *given set* of roots inside the loaded
window) to "all roots in the channel, with summary + sort + pagination". Reuse
that `from_kind != 'system'` rule so the count shown in the list matches the
inline badge exactly.

### 4. Unread (optional — P2.1)

`unread_count` = replies in the cluster newer than the viewer's last-read
position for that thread. Include it **only if** a per-viewer read marker for
threads/conversations already exists (e.g. a `last_read_seq`). If there is no
such marker today, **omit the field** — the list still works (sorted by
recency) and unread can be a fast-follow once a read-state primitive exists. Do
not block P2 on building read-state.

### 5. Edge cases

- **Deleted root**: `ON DELETE CASCADE` removes replies with the root, so the
  cluster disappears — no orphan rows. No special handling needed.
- **System-only clusters**: a root whose only "replies" are system messages is
  NOT a thread (reply_count would be 0) → excluded by the `from_kind != 'system'`
  + `>= 1 reply` rule.
- **Closed channel**: still listable (read-only); closing affects composing, not
  reading. No filter on `closed_at` for the list itself.
- **Empty**: zero qualifying roots → `{ threads: [], next_cursor: null }`.

### 6. Live updates (nice-to-have, not blocking)

The channel already publishes `message` events. A new reply bumps a cluster's
`last_reply_at` / `reply_count`. If cheap, emit (or let the client derive from)
the existing message stream so an open Threads list re-sorts live. If not, the
list refetching on open / on `conversation_members_changed`-style invalidation
is acceptable for P2.

## P1 — enriched inline reply badge (backend requirement)

P1 is the sibling of P2: the same data shortage (a reply only carries a count)
makes the **inline** reply badge on each message row too quiet to act as the
"this message has a thread" signal. P1 enriches that badge to a Slack-style
strip — recent replier avatars + count + last-reply time — which needs the
existing per-window reply sidecar extended, NOT a new endpoint.

### What exists today

`GET /api/conversations/:id/messages` already returns a per-window sidecar
`reply_counts_by_root: Record<rootMessageId, number>` (count of non-system
replies per root in the window). The frontend merges it across pages and
drives the count-only badge.

### The ask — one optional sidecar field

Add an **optional** sibling to that same response (already specced in
`packages/shared/src/api/message.ts` as `ReplyBadgeSummarySchema` +
`ConversationMessagesDto.reply_summaries_by_root?`):

```ts
reply_summaries_by_root?: Record<rootMessageId, {
  reply_count: number;        // mirrors reply_counts_by_root (self-contained)
  last_reply_at: number;      // epoch ms, max(created_at) of non-system replies
  repliers: Array<{ kind: 'agent' | 'human'; id: string }>; // ≤3, most-recent first
  replier_total: number;      // distinct repliers (for "+N" overflow)
}>
```

- **Keying & population**: exactly the roots already in
  `reply_counts_by_root` for that window (don't widen the set). Each entry
  aggregates the same non-system replies the count uses.
- **Optional on purpose**: the field is `.optional()` in the schema, so until
  it's populated the frontend renders the existing count-only badge for every
  row — no broken intermediate state. Ship it when ready.
- **Reuse**: this is the per-root version of P2's `ThreadSummary` minus the
  root preview (the root *is* the message row here). The aggregate is the same
  shape of query (`MessageRepo`), just scoped to the window's root ids instead
  of the whole channel — consider sharing the replier-aggregation SQL between
  this and P2's `listChannelThreads`.

### Frontend status (built, contract-ready)

The whole P1 frontend is done and merged-ready against this contract: the
shared schema field, the `useChannelMessages` merge (`replySummariesByRoot`)
+ optimistic live-reply patch (advances `last_reply_at`, moves the replier to
the front of the avatar cluster), and the enriched `MessageItem` badge with
count-only fallback. It activates automatically the moment the backend starts
emitting `reply_summaries_by_root`.

## Coordination note

A separate session is mid-flight on `thread_root_id` across
`packages/shared/src/api/task.ts`, `packages/backend/src/services/task-service.ts`,
and task system-message fixtures (continuation of #task:1056; it currently has a
TS2719 type-identity drift uncommitted). This P2 endpoint reads the **same
spine column** but is otherwise independent — put the new DTO in its own
`thread-summary.ts` file and the new query in `MessageRepo` (next to
`replyCountsByRoot`) to keep the surfaces from colliding.

## Summary of the ask

**P2 — channel Threads list (new endpoint):**

1. New shared DTO file `api/thread-summary.ts` (`ThreadSummary`,
   `ListChannelThreadsResponse`) + barrel export.
2. `MessageRepo.listChannelThreads(conversationId, { limit, cursor })` — the
   aggregate query in §3, keyset-paginated.
3. `GET /conversations/:id/threads` route — auth gate + maps repo result to the
   DTO.
4. (Optional P2.1) `unread_count` if a read marker exists.

**P1 — enriched inline reply badge (extend existing response):**

5. Populate the optional `reply_summaries_by_root` sidecar on
   `GET /api/conversations/:id/messages` (schema already in `api/message.ts`).
   Same replier-aggregation as P2, scoped to the window's root ids. Frontend
   is already wired and falls back to count-only until this lands.
