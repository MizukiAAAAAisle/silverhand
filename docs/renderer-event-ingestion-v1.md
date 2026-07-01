# Renderer event ingestion v1 (Stage-2 central ingestor)

> **Status: DRAFT for review** — #task:1255, renderer lead @Norman.
> Stage-2 follow-up to #1251 (Stage-1 = orphan-frame gate `f8ed335`, already in_review).
> Lanes: renderer structure = Norman · transport↔ingestor applied-cursor contract = Alice (§4.3) ·
> model boundaries + tests review = Cindy. Implementation is **incremental (P1→P2→P3, each shippable)**
> and lands **after** #1251; this doc is the design contract, not yet implemented.

## 1. Problem

Three realtime frame-loss bugs — #1241 (open-socket forward gap), #1251 (no-listener gap), and the
round-2 R2-C1 drop (a live frame that advanced the cursor but was never applied) — are the **same root
class**: the renderer conflates three distinct facts into one transport cursor, and couples the third to
React view lifecycle:

1. **socket received** — a frame arrived at `EventWsClient`.
2. **subscribe ack** — the server reports its head seq for a scope.
3. **cache applied** — the frame was applied to the React Query store.

`acceptEventFrame` advances the resume cursor on (1) (and `subscribed` baselines on (2)), while (3) only
happens if a per-view hook still has an `onWsFrame` listener registered. So whenever (1)/(2) can move the
cursor past a frame that (3) never applied, the next `resume` skips it and the message is lost until a REST
refetch. R2-C1 was exactly this: a live frame published 2s before the user switched away advanced the
cursor, but the view had already unmounted → never applied → resume floor was past it.

Stage-1 (`f8ed335`) tightened the cursor to **applied-to-active(desired)-scope high-water** via an
orphan-frame gate (frames for non-`desiredScopes` are ignored: no cursor advance, no dispatch). That stops
the bleeding and is correct in the terminal model too. But the *structural* coupling remains: cache
application is a side-effect of an open view. Stage-2 removes the coupling.

## 2. Invariant (the goal shiki locked)

> **mount/unmount must NOT decide whether a frame is applied/rendered.** Ingestion is the conversation
> store's responsibility, not a side-effect of a mounted view. The cursor is the **applied-to-store**
> high-water, by construction — because the same code that applies a frame advances the cursor, in one
> step, in one consumer.

Corollary: scope subscribe/unsubscribe is a **bandwidth optimization**, never a correctness boundary.

## 3. Current architecture (grounded 2026-07-01)

- `EventWsClient` (`lib/ws-client.ts`) is a **session-long singleton**; `frameListeners` is a long-lived
  Set. Transport is not the fragile part.
- The fragility is **fragmented per-view consumption**: a single `conversation:<id>` scope has **5–8
  hooks** each registering its own `onWsFrame` and writing a different cache key —
  `useChannelMessages` (`channels/hooks.ts:738`, `messagesKey`), `useThreadCluster` (:970,
  `clusterMessagesKey`), `useThreadRoot` (:1081, `threadRootKey`), `useThreadFollowers` (:1179,
  `threadFollowersKey`), `useChannelThreads`, plus sometimes `ChannelView` / `AgentActivityTimeline`.
  **All share the one `positions[conversation:id]` cursor.**
- Timing (the core flaw): `message` frame → `handleFrame` → `acceptEventFrame` (**advance cursor first**,
  `recordPosition`) → `frameListeners` dispatch → `useConversationStream`
  (`hooks/useConversationStream.ts:110`) → per-view `onEvent` → `appendMessageToCache` (**write cache
  after**). Cursor advance is decoupled from cache write, and cache write only happens when a view
  registered a listener.
- `ingestConversationEvent` (`useConversationStream.ts:27`) currently handles **only `agent_activity`**;
  message-cache writes live in per-view `onEvent` handlers.
- Message cache: `messagesKey(id)=['channels',id,'messages']` is `InfiniteData` with bidirectional
  paging (`MessagesPageParam = undefined | {before,seq} | {after,seq}`). `appendMessageToCache`
  (`channels/hooks.ts:237`) **tail-appends only when the last page is the tail window**, dedups by
  `msg.id` (L256 `cacheHasMessage`), and does **no seq reordering** — seq continuity is enforced at the
  transport layer only.
- **Precedent for the ingestor pattern**: App-level singleton sync hooks already centralize viewer/app
  scope ingestion into React Query — `usePresenceSync` (`['presence']`), `useAgentSync` (`['agents']`),
  `useViewerWorkspacesSync` (`['workspaces']`), `useActivity` / `useUnreadCounts` /
  `useNotificationToasts`. The conversation ingestor is the same pattern applied to `conversation:<id>`.
- **Read axis is already separate**: `useMarkMessageChannelRead` / `useMarkThreadRead` → `postObserve`
  (`observe.ts`) write `conversation_reads`; `useMarkConversationNotificationsRead` →
  `POST /api/notifications/read` writes `read_at`. WS frames never trigger read mutations. **Keep it.**
- React Query `QueryClient` is the **only** cache — no zustand/redux/context store.

## 4. Target architecture: central conversation ingestor

### 4.1 The ingestor singleton (renderer, mine)

A single App-level long-lived module — mounted once near the app root next to the existing sync hooks —
is the **only `onWsFrame` consumer for conversation-scope events**. It:

1. **Routes by event kind** (`message`, `message_reaction_changed`, `task_changed`, `agent_activity`),
   replacing the per-view `onEvent` switches.
2. **Applies to the React Query cache** by reusing the existing pure mutators (`appendMessageToCache`,
   `bumpReplyCountInCache`, `applyReactionChangedToCache`, `applyTaskChangedToCache`,
   `applyAgentRunStateToCache`) — centralized, not duplicated.
3. **Advances the applied-cursor atomically after a successful apply** (see §4.3 contract). Apply and
   advance are one step in one consumer ⇒ no "cursor advanced but not applied" window.

The ingestor writes the same cache keys (`messagesKey`, `clusterMessagesKey`, `threadRootKey`,
`threadFollowersKey`) so existing readers see no shape change.

### 4.2 Views become pure readers

`useChannelMessages` / `useThreadCluster` / `useThreadRoot` / `useThreadFollowers` drop their `onWsFrame`
subscriptions and become plain `useInfiniteQuery` / `useQuery` readers of the cache the ingestor fills.
A view mounting = start reading already-applied cache; unmounting = stop reading. **mount/unmount no
longer gates apply.**

### 4.3 Transport↔ingestor applied-cursor contract (P2)

Today `positions[scope]` conflates three facts: received-high-water (socket got it) / applied-high-water
(cache wrote it) / resume floor (replay starts here). They only diverge in the **"received but not
applied"** window — exactly the window that lost R2-C1. Stage-2 collapses that window by making the
cursor advance *because* apply happened. The agreed contract (Alice transport · Cindy correctness review):

1. **Delivery guarantee (transport→ingestor):** within one epoch, frames are delivered **in seq order,
   contiguous**; a gap is filled by resume *before* delivery, or escalated to `snapshot_required`. The
   ingestor does **NOT** recompute continuity.
2. **`markApplied(scope, seq, epoch)`:** the ingestor calls it **synchronously, once per frame, in seq
   order, after a successful apply**. `epoch` is mandatory (prevents a frame applied just before an epoch
   flip from clobbering the new baseline with a stale-epoch mark). Hard ordering: **apply → markApplied**,
   never cursor-before-apply.
3. **Apply-failure (Cindy #3):** the ingestor **wraps each frame's apply in try/catch**, records an
   `ingestor:apply_failed {scope, seq, kind}` diagnostic, and **does not markApplied** — it must NOT rely
   on an exception bubbling up naturally. One event writes several RQ caches (a message frame touches
   `messagesKey` + `clusterMessagesKey` + `threadRootKey`) ⇒ **no natural all-or-nothing** ⇒ every partial
   write must be **idempotent / replay-safe** (already true: `cacheHasMessage` id-dedup, id-keyed reply
   bumps). Self-heal = *failure → cursor doesn't advance → the **next frame or resubscribe** triggers
   recovery/replay → resume re-delivers → idempotent replay fills in* (no instant trigger required — if no
   frame follows the failure, the unadvanced cursor still makes the next `resume` re-deliver). **Not a
   rollback.** `markApplied` is the single commit point, reached only
   when all of a frame's writes returned without throwing.
4. **Input assertion (Cindy #4):** per scope, assert incoming seq ∈ {already-seen (dup → idempotently
   absorbed, cursor **not** rewound)} ∪ {applied+1}. A `> applied+1` frame should never reach the ingestor
   (= transport was bypassed) → `ingestor:nonmonotonic_input` diagnostic + **no markApplied**. A narrow
   fence against a future bypass path — **not** a second resume engine; it never reorders or recovers.
5. **Cold-start spans TWO independent seq spaces — never conflate them (Alice catch, Cindy confirmed).**
   - **transport seq** (`EventFrame.seq` / `subscribed.seq` / `positions.lastSeq` / resume): in-memory
     `seqCounters` (`scope-event-bus.ts`), **resets to 0 each backend boot, bound to `epoch` (process
     UUID), counts all event kinds**. This is the **only** space `positions[scope]` / resume / `markApplied`
     operate in.
   - **message seq** (`stream_head_seq` / observe `at_seq` / `conversation_reads`): the **persistent**
     conversation-global allocator (`reserveNextSeq` → `conversation_stream_heads.latest_seq`,
     `ConversationMessagesDto.stream_head_seq`). **Survives restart.**

   Seeding the transport cursor with `stream_head_seq` is a **cross-space bug**: after a backend restart
   transport seq resets to 0 (new epoch) while `stream_head_seq` stays high (e.g. 2521);
   `markApplied(scope, 2521, newEpoch)` → `resume{lastSeq:2521}` → the new buffer (transport seq 1..N) has
   nothing `> 2521` → empty → the client thinks it is caught up, and live frames at transport seq 1,2… are
   `<= 2521` → dropped as stale. **Breaks on every restart.** So `stream_head_seq` is **never** written to
   `positions`.

   **Correct cold-start (two water marks):**
   1. `subscribe` → record the `subscribed` **transport** seq **S** and **buffer** frames arriving after S
      (do not apply, do not yet commit the cursor). Subscribe-*before*-REST-read closes the
      "read returned, not yet subscribed" lost-frame gap.
   2. Load the REST snapshot and apply it.
   3. **Commit the transport cursor to S** (transport space, with epoch) — only **after** the snapshot is
      applied. (ack-head is the transport floor per §3, but it may **not** advance the *applied* cursor
      before snapshot apply — that is the corrected form of the old "no ack-head baseline" rule: not
      forbidden, just gated on snapshot apply.)
   4. Drain the buffer in **transport seq** order; for each frame, run its store effect, then
      `markApplied(frame.seq, frame.epoch)` (transport space).

   **Two distinct concerns — do not conflate (Cindy):**
   - **(i) pre-S state coverage (snapshot completeness).** Before S the client had **no listener**, so
     events that happened before S are **not in the buffer**. Each kind must name a source that rebuilds its
     pre-S state:
     - `message` → `ConversationMessagesDto.messages` (boundary `stream_head_seq`);
     - `reaction` → same DTO (reactions are embedded aggregates on the returned messages);
     - `task_changed` → the DTO's task fields on the message;
     - `agent_activity` → **NOT in the message snapshot** (it is `AgentRunState`, fetched separately). If
       cold-start must show the **current** run state it needs its **own** `AgentRunState` snapshot / REST
       source; otherwise it is explicitly **best-effort / live-only**. **Idempotent apply does NOT cover
       pre-S `AgentRunState`** — a pure-idempotent claim here is wrong.
   - **(ii) S-onward drain/replay safety (idempotency).** Every buffered/replayed frame from S onward must
     apply idempotently (dedup-by-id, set-based reactions, id-keyed task patch). This is a **drain-safety**
     property, **independent** of (i) — it is *not* a pre-S coverage relation.

   For message-class drain specifically: dedup against the **message snapshot boundary** —
   `payload.message.seq <= stream_head_seq` → already covered, drop/no-op; `> stream_head_seq` → apply
   (append / gap-bump). `stream_head_seq` is a **message-space dedup boundary only**, never a transport
   seed; it is window-independent (the route captures the opened stream head, not `max(messages.seq)` of
   the loaded window).

   So: **`markApplied` advances the transport cursor (transport seq); the snapshot-join dedup uses
   `message.seq` vs `stream_head_seq`. Two mechanisms, two spaces, never mixed.** A view with no
   message-window snapshot cannot independently commit the conversation cursor — it must obtain a snapshot
   first or wait for an existing cursor.
6. **Ownership:** forward-gap detection / ordering = **transport**; dedup / idempotency / input assertion =
   **ingestor**. resume/reconnect still read `positions[scope]`; the only change is the *writer*
   (`acceptEventFrame` → `markApplied`) for conversation scopes.
7. **Single-cursor precondition = synchronous apply** (`setQueryData` runs synchronously — that is the
   only guarantee it gives; it is **not** a multi-cache transaction). Cross-cache consistency for a frame
   that writes several keys rests on §4.3.3 (idempotent replay + `markApplied` as the single commit
   point), **not** on any RQ atomicity. Synchronous apply ⇒ received ≡ applied in the same tick ⇒ one
   cursor suffices. If apply ever becomes async, re-introduce a separate received-seq + pending queue —
   explicitly **not** now.

**P2 scope = conversation scopes only.** The viewer/app sync hooks (`usePresenceSync` / `useAgentSync` /
`useViewerWorkspacesSync` / `useActivity`) are already resident singletons where received ≡ applied holds
trivially — not the root cause, not in P2 (may migrate later).

**What "apply" means — gap-bump still applies (Alice, two orthogonal axes).** A frame whose store effect
is a *gap-fact bump* (not-at-tail window, see §5 P1 finding) is **still applied** and **still
markApplied**. Two axes that must not be conflated:
- **Axis A — transport applied:** consuming frame N → `markApplied(scope, N, epoch)`. It means only "I
  handled this frame, don't redeliver it," independent of whether the store effect was an append or a
  gap-bump.
- **Axis B — UI affordance:** the store effect for a not-at-tail window is a window-scoped gap-fact bump
  (no append).

The trap to avoid: reading "didn't append to the visible window" as "didn't really apply" and skipping
`markApplied`. That would stall the cursor at N → resume re-delivers N → the ingestor re-bumps the gap
forever (no-progress loop). The gapped frame's **message content** is not backfilled by resume — it is
backfilled by gap → scroll-to-latest → REST (seeded by `stream_head_seq`, §4.3.5), the same mechanism as
cold-start. Conversely (Cindy #3) the **gap fact is never a cursor/read input** — it never feeds
`markApplied` / resume floor / `conversation_reads` / `read_at`. So: *the frame is markApplied; the gap
fact does not touch the cursor.*

**Granularity (confirmed from code, not assumed):** `markApplied` is **scope-level** (one cursor per
`conversation:<channelId>`); the gap fact is **window/key-level** (`messagesKey` vs
`clusterMessagesKey(channelId, root)`), finer. All conversation-scope consumers — `useChannelMessages`,
`useThreadCluster`, `useThreadRoot`, `useThreadFollowers` — subscribe the **same**
`conversation:<channelId>` scope (verified in `channels/hooks.ts`: cluster/followers subscribe the
channel, not a separate thread scope). So one cursor per conversation, many gap facts per conversation —
another reason the two axes must stay separate.

### 4.4 Scope subscription / interest (bandwidth, P3)

Subscription stays driven by the active conversation set (open primary + secondary pane + open threads),
but **owned by the ingestor / a small interest registry**, not by individual view mounts. Until P3,
subscription can remain roughly view-driven; the Stage-1 orphan gate covers the unsubscribe race.

## 5. Migration path (incremental, each step independently shippable)

- **P1 (renderer, mine) — prep / mechanical consolidation, NOT a correctness fix:** introduce the
  ingestor as the single conversation-event consumer; move the cache writes into it; convert views to pure
  readers. During P1 the **cursor is still transport-advanced** — correctness is held by the existing
  Stage-1 orphan gate, unchanged. This step only removes the per-view fragmentation; it does **not** close
  `cursor = applied-high-water` (that lands in P2). No "zero regression / correctness completion" claim.

  **P1 implementation finding (2026-07-01, after reading the 8 consumers).** P1 is *not* purely
  mechanical: two consumers drive **event-derived view-local React state**, not just cache writes —
  `useChannelMessages` and `useThreadCluster` each set `hasNewerLiveGap` from inside their `onEvent`
  (a tail message arrived but this window's last page isn't the tail → show "scroll to latest" instead of
  lying with an append). To satisfy Cindy's **gate-(b) "views have zero `onWsFrame`"**, this state cannot
  stay event-driven in the view — the ingestor (which already has cache access) must own the **set**: on a
  mainline `message` whose target window's last page isn't tail, set a **per-window boolean
  `hasNewerLiveGap` cache fact** that the view reads. It must stay a **boolean set/clear**, *not* a
  derivation like `liveTailSeq > windowMax`: the current semantic is narrow — gap is true only when a live
  message *arrived while away from tail*, and a pure jump-to-history must **not** raise it (a derivation
  would, broadening behavior, which P1 may not do). Ownership: **set** = ingestor (frame-driven);
  **clear** = channel-switch / `isAtTail`→true / `resetToLatest` stay view effects (not frame-driven,
  retargeted from `useState` to the gap cache key), and `snapshot_required` clear+invalidate moves to the
  ingestor. The view writing the gap *key* on those clears is permitted (Cindy #2 "explicit-helper-driven
  clears") — it is a UI-affordance cache, never the message cache and never a frame apply. So P1's scope is
  "consolidate cache writes **and** promote event-derived view state to an ingestor-owned cache fact," so
  every conversation-scope view becomes fully `onWsFrame`-free.
  (The other event-derived facts are benign: `useThreadRoot`/`useThreadCluster` reply-count bumps and
  `useThreadFollowers` invalidate-on-reply are cache writes/invalidations, not React state; jump-prime
  epoch is written by the *queryFn* fetch, not `onEvent`, so it stays put.)

  **gate-(b) static test fences** "view has zero `onWsFrame`" **and** "view never calls the message-apply
  mutators (`appendMessageToCache` / `bumpReplyCountInCache` / `applyTaskChangedToCache` /
  `applyReactionChangedToChannelCaches`)" — **not** "view does zero `setQueryData`" (the gap-key flip is
  allowed).

  **P1 increments (each test-green, independently shippable):**
  - **P1a** — ingestor scaffold (App-level singleton next to `usePresenceSync`/`useActivity`) + main
    stream: it owns `useChannelMessages`'s writes (append / reply-bump / task_changed / reaction) and the
    `hasNewerLiveGap` cache fact; `useChannelMessages` drops `useConversationStream`, reads gap from cache.
    Tests: read-inert extended to the ingestor, main-stream pure-reader static fence, multi-cache
    idempotency.
  - **P1b** — thread cluster + root + followers: move their writes/invalidations + cluster gap fact into
    the ingestor; convert to readers.
  - **P1c** — `agent_activity` + `ChannelView` + `useChannelThreads`: route remaining conversation-scope
    kinds through the ingestor; convert. After P1c **every** conversation-scope view is `onWsFrame`-free →
    gate-(b) satisfiable → Alice's P2.
- **P2 (transport, Alice) — the correctness closure:** flip the resume floor to applied-high-water via
  `markApplied`; `acceptEventFrame` stops advancing the cursor for conversation scopes; add the cold-start
  two-water-mark join (§4.3.5: transport cursor committed to S after snapshot apply; message dedup via
  `stream_head_seq`). **Orphan-gate removal is gated** — it may be removed only once these three are
  statically/unit verifiable, otherwise the gate stays (not "structurally unnecessary" hand-wave):
  - (a) the conversation scope's **sole** consumer is the App-level ingestor;
  - (b) **every** view hook has zero `onWsFrame` and never calls the message-apply mutators (gap-key flips
    are allowed — see the gate-(b) static-test note above);
  - (c) the cursor writer is **fully** switched to `markApplied` (no `recordPosition` path for conversation
    scopes).
- **P3 (optional, later):** move scope subscription to an interest registry fully decoupled from view
  mount (pure bandwidth optimization layer).

## 6. Invariants preserved

- **Read axis stays separate** — the ingestor never writes `conversation_reads` / `read_at`. The #1244
  `surfaced ≠ eliminated` invariant holds one layer down; the read-inert guard
  (`realtime-ingestion-read-inert.test.ts`) extends to fence the ingestor.
- **React Query remains the only cache** — no new store; same cache keys/shapes.
- **Idempotent apply** — dedup-by-id (`cacheHasMessage`) is retained; replay/overlap stays safe.

### 6.1 Replay-safety contracts (#task:1262)

Every ingestor cache effect must have an explicit replay-safety contract before
it can participate in message-stream cursor advancement. The code-level source
is `REPLAY_SAFETY_CONTRACTS` in `conversation-ingestor.ts`; the dispatch maps
(`MESSAGE_STREAM_KIND_CONTRACTS` / `SIDE_KIND_CONTRACTS`) bind wire kinds to
those effects.

Current classes:
- **idempotent content apply** — safe to replay directly and may advance
  applied-water when the helper reports a real apply (`cluster_message_window`,
  `task_message_patch`, `reaction_message_patch`).
- **non-idempotent live-only delta with authoritative backfill recovery** —
  may advance applied-water only for the live optimistic path; backfill must
  trigger authority and remain unapplied until commit. This currently covers
  reply-count effects (`mainline_message_window` reply bump and
  `thread_root_reply_count`) and is intentionally visible for #1263 to collapse.
- **derived invalidate / side self-healing** — cursor-inert. These effects may
  refetch or merge their own projection but must not advance the message-stream
  applied-water (`thread_followers_invalidate`, `channel_threads_invalidate`,
  and all side-scope effects).

#1262 is a substrate, not the final replay model: it makes the current
classification typed and test-visible so #1263 can reclassify reply count from
non-idempotent delta to idempotent-by-construction, and #1264 can replace the
client-side provenance inference with server-authoritative delivery metadata.
Do not use #1262 to permanently bless the `+1` reply-count model.

## 7. Resolved by the §4.3 contract

- **Apply-failure** → §4.3.3: try/catch + diagnostic + no markApplied; partial writes idempotent; self-heal
  via resume replay, no rollback.
- **Replay ordering** → §4.3.1/§4.3.4: transport delivers in-order contiguous; ingestor tail-appends and
  dedups by id, does **not** seq-reorder.
- **Cold-start** → §4.3.5: **two seq spaces**. transport cursor commits to the `subscribed` seq S
  (transport space) **after** snapshot apply (ack-head may not advance the *applied* cursor before that);
  message-class drain dedups `payload.message.seq` vs `stream_head_seq` (message space); `stream_head_seq`
  is **never** written to `positions`. **Pre-S state covered per-kind; drain remains idempotent** (two
  separate concerns — §4.3.5(i)/(ii)).
- **agent_activity** → routed through the same ingestor (single consumer for all conversation-scope kinds);
  the cursor flip is conversation-scope-wide, not per-kind. But `agent_activity` is **not** covered by the
  message snapshot — cold-start correctness requires its **own** `AgentRunState` snapshot/REST source,
  otherwise it is explicitly **best-effort / live-only**. Idempotent apply only covers **S-onward
  drain/replay**, never pre-S `AgentRunState`.

Still open (non-blocking, P3): interest-registry granularity (per-conversation vs also per-thread-root).

## 8. Test surface

Transport-side (Alice owns):
- apply success ⇒ `markApplied`; apply throw ⇒ **no** `markApplied`, and recovery (forward-gap/resume)
  fires on the **next frame or resubscribe** — not necessarily immediately (if no frame follows the
  failure there is no instant recovery, but the cursor stayed put so the next `resume` re-delivers). This
  is distinct from the old tail-frame blind spot; don't assert an immediate trigger.
- duplicate replay (`seq <= applied`) is idempotently absorbed; cursor not rewound.
- cold-start (two seq spaces): transport cursor committed to `subscribed` seq S **only after** snapshot
  apply (ack-head must not advance the applied cursor before); message drain dedups `message.seq` vs
  `stream_head_seq`; `stream_head_seq` **never** written to `positions`; **reboot reproduction** — transport
  seq resets to 0 / new epoch while `stream_head_seq` persists, so a `stream_head_seq` transport seed would
  drop all live frames as stale (the bug this guards).
- P2 orphan-gate-removal precondition lock: a static assertion that **view hooks have zero `onWsFrame`**
  (so the gate can't be removed while a per-view consumer still exists).

Ingestor-side (mine; Cindy reviews):
- **read-inert**: the ingestor writes no `conversation_reads` / `read_at` — extend the existing source
  fence (`realtime-ingestion-read-inert.test.ts`) to cover the ingestor module.
- **replay-safety contracts**: tests assert that every message-stream and side
  wire kind is routed through an explicit contract entry, that side effects are
  cursor-inert, that derived invalidations do not count as content apply, and
  that the remaining non-idempotent reply-count effects stay visible until
  #1263 reclassifies them.
- **multi-cache idempotency**: a frame that writes `messagesKey` + `clusterMessagesKey` + `threadRootKey`,
  replayed, produces no duplicates and no double reply-count bump.
- **views are pure readers**: static fence that `useChannelMessages` / `useThreadCluster` / `useThreadRoot`
  / `useThreadFollowers` no longer register `onWsFrame` or write conversation caches (this doubles as the
  P2 gate-(b) lock above).
