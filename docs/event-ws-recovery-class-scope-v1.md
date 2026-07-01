# Recovery-class transport-scope partition (Stage-2 P2 design, v1)

Status: **design / not yet implemented.** Owner: Alice (transport↔ingestor cursor
contract). Reviewers: Cindy (backend publish + model boundary), Norman (renderer
subscribe). Gates the Stage-2 #1255 **P2** transport work (flip cursor to
`markSatisfied` + cold-start two-watermark + drop orphan gate). **No backend /
transport code changes until this doc + the kind matrix below are signed off by
Cindy and the scope-topology change is blessed by shiki** (it has grown past the
original "single-scope cursor flip" P2 framing). Companion docs:
`event-ws-transport-v1.md` (transport cursor/resume contract — canonical),
`renderer-event-ingestion-v1.md` (renderer ingestor structure),
`activity-lifecycle-v1.md` (read axis — untouched here).

## 1. Why (the cost-out finding)

P1 made the App-level conversation ingestor the sole writer of the conversation
**message-window** cache and turned every product view into a pure reader. P2 was
originally scoped as "flip the transport cursor writer from `acceptEventFrame` to
the ingestor's `markSatisfied`, add cold-start two-watermark, drop the orphan gate"
— on the assumption that, under synchronous apply, `received-high-water ≡
applied-high-water`, so one per-scope cursor suffices.

**That assumption is false.** Source audit (all read, not grepped):
`conversation:<id>` is a single transport seq space carrying kinds with
**heterogeneous recovery models**:

- Some kinds are an *ordered patch stream over the message-window projection*
  (`message` optimistic-append, `reaction` aggregate patch, `task_changed` chip
  patch). A missed frame here is **not** reliably recovered by refetch-on-mount —
  #1251 (R2-C1) proved that empirically; **resume is load-bearing** for them.
- Other kinds are *own-cache / invalidate* projections (`agent_status`,
  `agent_activity`, `conversation_activity`, `conversation_members_changed`,
  `thread_updated`). Each has its own cache + `refetchOnMount` /
  invalidate self-heal; they **do not need ordered resume**.

A single cursor over both classes cannot be correct. The invalidate-class kinds
are frequently **readerless** (timeline closed, members panel closed) → their
frames produce zero store effect → with per-target reader gates (locked in
`event-ws-transport-v1.md` §4.1), `applied-high-water` diverges from
`received-high-water`. Then the cursor either:

- **freezes** on every readerless side-channel frame (degenerate: resume replays
  a growing tail until it overflows the 200-entry buffer → `snapshot_required`), or
- **jumps past** an unapplied `message` frame when a later side-channel frame is
  treated as progress — re-introducing the #1251 drop (cursor resumes above a
  message that refetch won't recover).

The partition removes the *truly-readerless, self-healing* kinds
(agent_status / agent_activity / conversation_activity / members) from the
resume-governed scope, so they stop inflating the message-stream's
received/applied gap and its replay buffer. **It does not, by itself, restore a
single cursor** — because the derived-invalidate readers (`useChannelThreads` /
`useThreadFollowers`, §3.1) stay subscribed to message-stream and legally receive
`message` frames that produce **no** content-apply. Two consecutive replies to a
Threads-only viewer (seq 10, 11) each only `invalidateChannelThreadsList`;
`applied-high-water` stalls at 9 while `received-high-water` reaches 11. So the
two watermarks genuinely diverge *inside the message-stream's own transport seq
space*, and the design must own that — see §4. (Cindy's blocker, accepted.)

> Two orthogonal two-watermark axes exist; do not conflate them:
> - **Cold-start axis** (locked, §4 cold-start): transport-seq baseline `S` vs
>   message-seq boundary `stream_head_seq`. Seeds the cursor + dedups drain.
> - **Steady-state axis** (this §, the residual): `received-high-water` (wire-gap
>   detection / live continuity) vs `applied-high-water` (resume floor / content
>   recovery), **both in transport-seq space**. The partition shrinks but does not
>   erase this axis; §4 adopts it explicitly.

## 2. Kind matrix (gate-1 — every conversation-scope kind has a unique home)

| kind | publisher(s) | renderer consumer | apply / recovery | class |
|---|---|---|---|---|
| `message` | conversation-message-service:603/614, conversation-member:274/420, schedule-service:771/827, mention-cc:264, channel-service:571 (rename system message) | ingestor → message-window cache (append / reply-badge bump / live-gap) | optimistic append; **resume** (refetch unreliable, #1251) | **message-stream** |
| `message_reaction_changed` | reaction service | ingestor → `applyReactionChangedToChannelCaches` patches in-window reaction aggregates (+ thread-root) | in-place patch of existing message row → **resume** | **message-stream** |
| `task_changed` | task-service:1932/1994 | ingestor → `applyTaskChangedToChannelCaches` patches the in-window task chip (+ task-by-number) | in-place patch of message-window chip → **resume**; the task-by-number half could invalidate, but the chip half pins it to the message-window | **message-stream** |
| `agent_status` | status-projector:125/148/193/225/256 | ingestor → channel-agents cache (retain/release buffer + queryFn merge) | invalidate + buffer-replay; `snapshot_required` → reconcile | **side-channel** |
| `agent_activity` | event-handler:686/909, outbound-event-fanout:1402/1417/1572 | ingestor → agent-run-states cache | `refetchOnMount:'always'` own cold-start | **side-channel** |
| `conversation_activity` | event-handler:743 | ingestor → agent-activity-feed infinite query (per-agentId) | own REST cold-start (infinite query) | **side-channel** |
| `conversation_members_changed` | conversation-member:275/421 | `useConversationMembers` (its own `onWsFrame`) | invalidate members query | **side-channel** |
| `agent_init_timeout` | event-handler:504 | dev EventStream only (no product consumer) | ephemeral notice; invalidate/refetch-recoverable | **side-channel** |
| `compaction_stale` | event-handler:558 | dev EventStream only (no product consumer) | ephemeral notice; invalidate/refetch-recoverable | **side-channel** |
| `agent_event` | event-handler:575 (parsed-event SSE, **high-frequency** — every parsed agent event) | dev EventStream only (renderer Events panel) | own cache / refetch; **must not** inflate message-stream | **side-channel** |
| `thread_updated` | conversation-message-service:614, channel-service:480 | **no renderer consumer (confirmed vestigial, Norman)** — Threads-list liveness rides the `message` kind via `ingestMessage → invalidateChannelThreadsList` | n/a (unconsumed) | **side-channel** — published-but-unconsumed; do not promote to a load-bearing source in P2 |

> **Audit gap closed (§1(b), Alice at implementation):** the original §1 audit
> missed three conversation-scope kinds — `agent_init_timeout`,
> `compaction_stale`, `agent_event` (all published by `event-handler` on
> `runtime_*` frames). None is a message-window patch, so all three are
> side-channel. `agent_event` in particular is **high-frequency** (one per
> parsed agent event): leaving it on the message stream would inflate the
> message-stream replay buffer and received/applied gap and defeat the
> partition's purpose (§1), so its move is a correctness requirement, not
> gold-plating. Their only consumer today is the dev `EventStream` panel (and
> `agent_init_timeout` has none). Post-cutover, a dev panel that wants to keep
> observing side kinds must add a `conversation-side:<id>` observe subscription
> (§6) — this is already true for `agent_status`/`agent_activity` after the
> partition, not new to these three.

> **Not a transport kind (Cindy):** task `status` is a `TaskNarrativeKind`, not a
> wire event kind — it materializes as `message` + `task_changed` frames, both
> already rows above. It gets no matrix row. (Removed the earlier "task status"
> side-channel line.)

**Open matrix items (must close before sign-off):** (a) `thread_updated` —
**closed**: Norman confirmed zero renderer consumer; Threads-list liveness rides
the `message` kind, so it is published-but-unconsumed (vestigial). Keep it on the
side scope at migration (it costs nothing) but do **not** make any consumer
depend on it in P2; a separate cleanup may stop publishing it. (b) re-confirm no
other kind reaches `conversation:<id>` — **closed** (Alice at implementation):
the re-verification surfaced `agent_init_timeout` / `compaction_stale` /
`agent_event`, now classified side-channel above.

Viewer-scoped kinds (`unread_updated`, `notification`, `mention_self`, …) are on
`viewer:<id>`, **not** conversation scope (channels/hooks.ts:2048/2087/2211/2258
all `subscribeViewerScope`) — confirmed by Norman; excluded from this partition.

## 3. Partition design

Migration-minimal split — keep the resume-class on the existing scope, move only
the invalidate-class out:

- **`conversation:<id>` = message-stream** (unchanged scope name): `message`,
  `message_reaction_changed`, `task_changed`. **Resume floor** =
  `applied-high-water`, advanced by the ingestor's `markSatisfied` once a frame's
  effects reach a resume-safe **satisfaction disposition** — content write,
  derived-invalidate *commit*, warm-inactive `removeQueries`, or cold-absent
  vacuous (canonical per-kind contract: `event-ws-transport-v1.md` §9; §4 below is
  the historical predicate that preceded it); **wire continuity** = a separate
  `received-high-water` advanced on every received frame. The two diverge whenever
  a derived-invalidate reader keeps the scope live without a content reader (§4
  two-watermark).
- **`conversation-side:<id>` = side-channel** (new scope): `agent_status`,
  `agent_activity`, `conversation_activity`, `conversation_members_changed`,
  `thread_updated`(if ever consumed; today unconsumed — see §2).
  **Cursor-inert**: no `markSatisfied`, no resume floor, no message
  `snapshot_required` semantics (gate-2). Recovery is per-consumer invalidate /
  own REST cold-start (each already exists from P1c). It reuses the EventWs
  transport + replay buffer purely as a delivery pipe.

One side scope (not per-projection) for v1: simplest, correctness-equivalent. A
closed timeline still *receives* (cursor-inert) activity frames = wasted
bandwidth only; per-projection scopes are a future bandwidth optimization, not a
correctness need. (Trade-off flagged for Cindy.)

### 3.1 Reader → scope, by projection dependency (Cindy's gate)

A reader subscribes the scope of **the kind its liveness depends on** — not
"whatever cache it owns". This matters because two readers consume a
*message-derived* fact yet write no message-window cache:

| reader hook | liveness depends on | subscribes | effect on a message frame |
|---|---|---|---|
| `useChannelMessages` | `message`/`reaction`/`task_changed` | **message-stream** | content-apply (append / reaction·task patch) + derived-invalidate (reply-count, #1263 (c)) |
| `useThreadCluster` | `message`/`reaction`/`task_changed` (per root) | **message-stream** | content-apply (cluster append / patch) |
| `useThreadRoot` | `message` reply count + `reaction` | **message-stream** | **derived-invalidate** (reply-count authoritative `invalidateQueries`, commit-gated — **no local bump**, #1263 (c)); `reaction` = content-apply patch |
| `useThreadFollowers` | `message` to a followed root | **message-stream** | **derived-invalidate** (followers snapshot) — cursor-inert |
| `useChannelThreads` | `message` → Threads-list count | **message-stream** | **derived-invalidate** (`invalidateChannelThreadsList`) — cursor-inert |
| `useChannelAgents` | `agent_status` | **side-channel** | own cache + buffer |
| `useAgentRunStates` | `agent_activity` | **side-channel** | own cache, `refetchOnMount` |
| `useAgentActivityFeed` | `conversation_activity` | **side-channel** | own infinite query |
| `useConversationMembers` | `conversation_members_changed` | **side-channel** | invalidate |

**Load-bearing exception (Cindy's catch):** `useChannelThreads` (and
`useThreadFollowers`) are invalidate-only but their liveness rides the
message-stream `message` kind, **so they subscribe message-stream, not side
scope.** Moving them to side scope would leave message-stream unsubscribed when a
Threads panel is the only open reader → new replies never reach
`ingestMessage → invalidateChannelThreadsList` → the list goes silently stale.
This is Cindy's option 1 (keep them on message-stream); we reject option 2
(promote the currently-unconsumed `thread_updated` to a load-bearing side source)
as a larger change with no offsetting benefit.

But note the consequence in §4: their effect is a **derived-invalidate**, which
must be **cursor-inert** even though it rides the message-stream scope.

## 4. P2 cursor mechanics on the narrowed message-stream scope

Two watermarks on the message-stream scope (steady-state axis), because the
content-apply fence alone leaves the derived-invalidate readers diverging
(Cindy's blocker):

- **`received-high-water`** — advanced in `acceptEventFrame` on **every** received
  frame, contiguous in transport-seq space. Drives **wire-gap detection** ("did
  the socket drop a frame?" → `seq > received+1` ⇒ resume) and live continuity
  **only**. It does **not** imply the frame's content is store-recoverable (Cindy
  口径 1) — a received frame may have been applied, no-op'd, or readerless.
- **`applied-high-water`** (= `positions[scope]`) — advanced by ingestor
  `markSatisfied` **only on a real content write** (§4.1 predicate). It alone is the
  **resume floor** (resubscribe replays from here so a later-mounting content
  reader recovers).

They coincide while a content reader is mounted (every message frame
content-applies); they diverge when only a derived-invalidate reader
(`useChannelThreads`/`useThreadFollowers`) keeps the scope live. The seq-10/11
Threads-only case resolves cleanly: received → 11 (no false gap — gap detection
uses received), applied stays 9 (resume floor stays at the last
content-recoverable frame). On ChannelView reopen, resume replays 10/11 from 9 →
content-applies → no #1251 drop. If a Threads-only viewer outlives the replay
buffer (applied frozen, received climbs past buffer size), a reconnect yields
`snapshot_required` → fresh snapshot → correct, bounded self-heal.

Why option 2 over Cindy's 1/2/3: **option 2, with option 1 now excluded.**
- **Option 1 (make message-stream a pure content-reader scope) is excluded** —
  not merely undesirable. Norman's off-window no-op finding (§4.1) shows the
  divergence is **intrinsic to message-stream**, not caused by the straddle
  readers: even with ChannelView mounted, an off-window reply produces a semantic
  no-op, so two consecutive off-window replies diverge received/applied regardless
  of who else subscribes. Removing threads/followers cannot restore a single
  cursor. (It was also the `thread_updated`-promotion / split-one-fact-into-two
  path already rejected.)
- **Option 3 (derived/skipped frame force-evicts the message-window cache to
  license a cursor bump) is rejected as default** — it binds transport cursor
  correctness to renderer cache eviction (a brittle cross-bounded-context
  invariant). Acceptable only if explicitly owned + strong-tested; we don't.
- **Option 2** keeps **one fact = one event** (the message frame; content readers
  apply, derived readers invalidate — single source of truth) and pays only an
  honest second integer per scope. `received` answers "did the wire drop a frame";
  `applied` answers "from where must resume restore warm content" — different
  questions, so forcing them equal was the original sin. The partition's value is
  **downgraded from "eliminate the divergence" to "minimize it"**: moving the
  high-frequency self-healing kinds off message-stream keeps the two watermarks
  close and the replay buffer small.

### 4.1 Satisfaction disposition (was: the content-apply predicate)

> **⚠️ Retitled + superseded (#1261 + #1263 (c)) — canonical contract is
> `event-ws-transport-v1.md` §9.** This section originally specified a *content-apply
> predicate*: apply helpers returned `applied: boolean` and the cursor writer fired
> iff a helper *actually mutated* a resume-recoverable cache, with a per-kind
> false-positive/false-negative asymmetry around the non-idempotent reply-count
> `+1`. That model is gone:
> - **#1263 (c)** deleted the optimistic reply-count `+1` — `bumpReplyCountInCache`
>   and `patchReplySummary` are **removed** (structurally dead); reply count now
>   recovers by authoritative `invalidateQueries` on every delivery. The two apply
>   helpers (`applyMainlineMessageToChannelCaches` / `applyThreadRootReplyBump`)
>   return `Promise<void> | null` (the invalidate's promise, or a no-op) — **not**
>   `applied: boolean`.
> - **#1261** generalized `markApplied` into a commit-gated **pending-satisfaction
>   queue**: a frame is *satisfied* once all its per-target effects **commit**
>   (`Promise.allSettled` all-fulfilled), and the floor drains contiguously.
> Per-kind satisfaction disposition + the #1263 (A) hybrid-gate exception are
> specified **once**, in transport §9. Do not re-spec them here — the paragraphs
> below are retained only for the two-watermark rationale they motivate.

- `acceptEventFrame` advances **only** `received-high-water`;
  `applied-high-water` (= `positions[conversation:<id>]`, the resume floor) is
  advanced **solely** by the ingestor's `markSatisfied`. This **supersedes the
  P1-era "the cursor writer fires regardless of store effect, else the cursor
  stalls" reasoning** — under two watermarks, `received` carries continuity, so
  `applied` is free to advance only once a frame is resume-safe and never stalls
  gap detection.

  > **Non-idempotent delta resolution (Alice + Cindy, signed) — ⚠️ SUPERSEDED
  > (#1263 (c) + #1264).** The reasoning below reaches for *delivery provenance*
  > (`+1` on `live`, authoritative recovery on `backfill`). What actually landed is
  > simpler: **#1263 (c) dropped the optimistic `+1` for every delivery** — reply
  > counts recover by authoritative invalidate/refetch on `live` and `backfill`
  > alike, so replay is idempotent-by-construction and no consumer needs the tag.
  > **#1264 then deleted delivery provenance entirely** (see
  > `event-ws-transport-v1.md` §2/§9). Read this as the reasoning that motivated
  > authoritative recovery, not as the current delivery model. — Reachability
  > confirmed: refcounted `subscribe()` (ChannelView under an already-subscribed
  > Threads panel fires no resume) + authoritative REST `reply_counts_by_root`
  > including a prior off-window reply + a later reconnect resuming from the old
  > floor → `bumpReplyCountInCache` `+1`s on top → double; accurate live marking
  > can't save it (no live apply). **Fix = provenance + authoritative recovery, not
  > bare skip:** the **delivery path carries** `live`/`backfill` (ws-client/ingestor
  > delivery metadata, **not** a wire/payload schema change — `event` frame and
  > `MessageDto` stay byte-identical); a non-idempotent delta applies
  > `+1` on `live`, but on `backfill` must **neither delta-apply nor silently
  > no-op** — it forces authoritative recovery of the affected target
  > (invalidate/refetch, reusing existing `reconcile*`/`invalidateQueries`; or
  > confirm a covering snapshot). Bare skip would convert double-count into
  > **missed-count** (Cindy: active window misses a reply during a disconnect →
  > backfill must still refetch). No cache-shape/REST-DTO change. See
  > `event-ws-transport-v1.md` §2/§9.

- **Why this boundary is right (resume-dependence — the live criterion).** The only
  effects that *truly* need ordered resume are writes to a **warm** content window
  that won't refetch (#1251 is warm-cache reuse, not a REST fault — verified: REST
  `reply_counts_by_root` is recomputed per window fetch, and `useThreadCluster`
  cold-starts reply bodies). This is exactly the criterion transport §9 states as
  "an effect is gated iff resume correctness depends on its settle." The line is
  "does a resume-recoverable cache depend on this effect having committed," not
  "was it a tail-append." Off-window no-ops and pure derived-invalidates whose data
  is authoritative-on-open fall out naturally.

  **Cluster append is a content-apply; reply-count is a commit-gated
  derived-invalidate (post-(c)).** A reply's cluster-window append patches a
  resume-recoverable cache → satisfies after the write. A reply's mainline/thread-root
  **reply-count** no longer *bumps* any cache — under #1263 (c) it is an
  authoritative `invalidateQueries`, so its seq is satisfied only after the refetch
  **commits** (commit-gated, per transport §9). The satisfying set is thus {mainline
  append, cluster append, reaction/task patch of an in-cache row} *(sync content
  writes)* ∪ {mainline + thread-root reply-count invalidate} *(commit-gated)* ∪
  {warm-inactive `removeQueries`, cold-absent vacuous}. Only Threads-list /
  followers derived-invalidate and side-scope effects never touch this floor.

  **Known residual — single cursor vs. multiple warm caches (P3, not introduced
  here).** One cursor governs N independently-cached content windows (mainline +
  each open cluster + each thread-root). A frame applied by window A advances the
  shared cursor past it even if a *warm-but-unmounted* window B (RQ cache still
  within gcTime, no live observer → ingestor's per-target gate sees it as
  inactive → won't re-apply on remount) also needed it. This is **not** introduced
  by the satisfaction disposition and **not** a regression: today's
  applied-to-desired-scope cursor (#1251 `f8ed335`) has the identical gap, because
  `desiredScopes` keys on subscription, not on which warm cache applied. The clean
  closure is **P3 interest-registry** — apply to every *interested* (warm) cache,
  not just the mounted ones, so a single cursor stays correct. P2 holds parity
  with today on this axis; the recovery-class split is orthogonal to it.

- Cold-start two-watermark (§3.1-of-transport-doc) unchanged: transport baseline
  `S` committed only after the REST message snapshot applies; `stream_head_seq`
  (message space) only for message-payload drain dedup, never written to
  `positions`.
- **Orphan gate → received-high-water.** The orphan gate (`f8ed335`) conflated
  two jobs: wire-gap detection and stopping a readerless frame from floating the
  resume cursor. P2 splits them: `received-high-water` (advanced for every desired
  scope frame) takes wire-gap detection; `applied-high-water` (advanced solely by
  the ingestor's `markSatisfied`, on satisfaction disposition) is the resume floor. `acceptEventFrame` stops self-advancing
  the **resume** cursor — that flip is safe here because the preconditions hold
  (ingestor sole markSatisfied caller + sole message-window writer; no view hook
  writes the message-window cache or resume cursor). `useConversationMembers` /
  agent / activity readers no longer touch this scope (they moved to
  `conversation-side:<id>`). `useChannelThreads` / `useThreadFollowers` stay, but
  their derived-invalidate is cursor-inert, so they advance `received` (wire
  continuity) without floating `applied` past an un-applied message.

## 5. Side-channel recovery model (gate-2)

Side-channel frames must **never**: call `markSatisfied`, advance any resume floor,
or trigger the message-stream `snapshot_required` → message refetch path. On a
`conversation-side:<id>` `snapshot_required`, each consumer does its **own**
invalidate / REST snapshot (members invalidate, agents reconcile, activity
infinite-query refetch). Read-inert holds throughout (no `conversation_reads` /
`read_at` writes).

**Side scope = message-resume-cursor-inert, not mechanism-less (Cindy
condition 2).** It is a normal transport scope: it keeps `received`-side delivery
— ordered fan-out, gap detection, the replay buffer, and `snapshot_required` as a
delivery pipe + diagnostics. What it does **not** have is the message
**`applied`/resume-floor** layer: no `markSatisfied`, it never feeds any message
resume floor, and its `snapshot_required` drives only each consumer's own
invalidate (never a message refetch). So §8's "no-listener replay on both scopes"
is consistent — both scopes replay at the transport layer; only message-stream
carries the `applied` content-resume watermark.

## 6. dev EventStream isolation (gate-3)

`components/dev/EventStream.tsx` still subscribes `conversation:<id>` via
`useConversationStream`. Post-P2 it must **not** be a product cursor consumer:
either (a) it subscribes observe-only (never feeds `markSatisfied` / never advances
`positions`), or (b) it moves to a dedicated diagnostic subscription. Decision:
**(a) observe-only** — least churn; `useConversationStream` already only
dispatches, and dev EventStream never wrote the cursor. We assert (test) that no
`markSatisfied` path is reachable from `useConversationStream`. This prevents the
dev panel from re-creating a "listener present but no store apply" gray zone.

## 7. Migration plan (gate-4 — no double-publish / missed-subscription)

Phased, each step shippable, with test locks:

1. **Introduce `conversation-side:<id>` scope** (shared/backend constant +
   renderer scope helper). No behavior change yet.
2. **Backend publish cutover** (Alice/backend lane; Cindy reviews) — **DONE**:
   a new `ScopeEventBus.publishSide(conversationId, event)` routes to
   `conversation-side:<id>` (via `conversationSideScope`, no compat emit — the
   side channel has no legacy in-process consumers). All side-channel publish
   sites moved from `publish()` to `publishSide()`: status-projector
   (`agent_status` ×5), event-handler (`agent_activity`, `conversation_activity`,
   plus the audit-surfaced `agent_init_timeout` / `compaction_stale` /
   `agent_event`), outbound-event-fanout (`agent_status` ×2, `agent_activity`
   ×3), conversation-member (`conversation_members_changed` ×2),
   conversation-message-service / channel-service (`thread_updated`). `message` /
   `task_changed` stay on `publish()`; `message_reaction_changed` stays on its
   existing `publishToScope('conversation:<id>')`. Backend subscribe
   authorization added: `permissions.ts::parseWsScope` parses
   `conversation-side:` into a `conversation-side` `ParsedWsScope` variant,
   `canSubscribeScope` gates it through the same `canViewConversation`, and
   `conversationIdFromScope` diagnostics (ws-connection + scope-event-bus)
   recognize both prefixes via the shared parsers. (task `status` is not a
   transport kind — nothing to move.) Test locks: `scope-event-bus.test.ts`
   asserts `publishSide` routes only to the side scope with an independent seq
   space; `ws-server.test.ts` asserts a client can subscribe
   `conversation-side:<id>` (same view gate) and receive its fanout.
3. **Renderer subscribe cutover** (Norman lane): the **4 true side-channel
   consumers** (`useConversationMembers`, `useAgentRunStates`,
   `useAgentActivityFeed`, `useChannelAgents`) subscribe `conversation-side:<id>`;
   the ingestor splits its routing by scope. **`useChannelThreads` /
   `useThreadFollowers` stay on message-stream** (§3.1 — message-derived
   liveness). **Plus a verified gap to close (Norman):** `ingestSnapshotRequired`
   today reconciles mainline / cluster / followers / channel-threads /
   agent-run-states / agents but has **no `agent-activity-feed` branch**
   (`useAgentActivityFeed` relies on `refetchOnMount:'always'`, which cold-starts
   on mount but does not reconcile a *live* reconnect). Since the side scope
   retains `snapshot_required` (§5), each side consumer needs its own reconcile
   branch — add an `agent-activity` `snapshot_required` branch to the ingestor, or
   an open activity timeline won't backfill on live reconnect. Test lock:
   subscribe/unsubscribe of the two scopes are independent; no-listener replay
   covered for **both** scopes (≥1 each); a Threads-panel-only reader still
   receives `message` frames and refetches the list; an open activity timeline
   backfills on a side-scope `snapshot_required` (not only on remount).
4. **P2 cursor flip on message-stream** (Alice lane): markSatisfied + cold-start
   two-watermark + drop orphan gate (§4). Only after steps 1–3 land green.

Ordering rule: a kind is published to its new scope and consumed there in the
**same** step (no window where it is published to one scope but subscribed on the
other).

## 8. Acceptance criteria (the 4 gates as tests)

1. **Matrix completeness** — every `conversation:*` / `conversation-side:*` kind
   appears in §2 with a single class; CI guard that a new publish kind must be
   classified.
2. **Side-channel cursor-inertness** — a side-channel frame never advances
   `positions` / never calls `markSatisfied` / a side-scope `snapshot_required`
   drives only that consumer's invalidate, not a message refetch.
3. **dev EventStream observe-only** — no `markSatisfied` reachable from
   `useConversationStream`; dev panel subscription does not move the product cursor.
4. **Migration integrity** — message-stream scope test receives only
   message/reaction/task_changed; side scope only side-channel kinds; two-scope
   subscribe/unsubscribe independence; no-listener replay for both scopes.
5. **Steady-state two-watermark (the blocker, §4)** —
   (a) *Threads-only consecutive replies*: with only `useChannelThreads` mounted,
   deliver seq 10 then 11; assert `received-high-water` = 11 (no false gap raised),
   `applied-high-water` = 9 (stalled, no content-apply), and the Threads-list was
   invalidated twice.
   (b) *Reopen recovery*: then mount ChannelView → resume replays 10/11 from the
   applied floor → both content-apply → no message dropped (the #1251 guard, now
   under the derived-invalidate path).
   (c) *Buffer-overflow self-heal*: a Threads-only viewer past the replay-buffer
   size yields `snapshot_required` on reconnect, not a silent skip.
   (d) *gap-detection source*: assert wire-gap detection reads `received`, never
   `applied` (a stalled applied must not raise a false gap).
   (e)–(g) *[SUPERSEDED by #1261 + #1263 (c)]* — the original axes tested the
   `applied: boolean` helper predicate (off-window reply "does not advance applied";
   helpers return `applied: boolean`; per-kind false-negative idempotency). That
   model is gone: helpers return `Promise<void> | null`, reply-count is a
   commit-gated derived-invalidate, and an off-window reply on an **active** mainline
   now satisfies **vacuously** (authoritative on paginate — the floor DOES advance),
   not "applied stays put". The current per-kind satisfaction tests are (h)/(h2)
   below + the ingestor suite (`conversation-ingestor.test.ts`); canonical contract
   in `event-ws-transport-v1.md` §9.
   (h) *reply-count replay idempotency — #1263 (c), provenance deleted #1264*:
   the optimistic `+1` is gone; every delivery (live or replayed) recovers the
   count by authoritative invalidate/refetch, so replay is idempotent-by-
   construction. Tests: (i) the SAME reply frame delivered twice (live + replay)
   → the local count is **never bumped locally** (the optimistic `+1` helper is
   deleted; recovery is authoritative-invalidate) → cannot double-count; (ii) an active in-window root missing a reply during a
   disconnect → resume redelivers → invalidate/refetch → final count correctly +1
   (no missed-count). There is no `live`/`backfill` classification to test — a
   replayed frame dispatches identically to fresh fanout.
   (iii) *coalesce, no storm (Norman)*: N reply-count invalidates on the
   same target across one resume → `invalidateQueries` natural dedup → **one**
   refetch, no refetch storm.
   (h2) *satisfaction is commit-gated, not dispatch-gated (#1261; Alice + Cindy +
   Norman, signed)*: a derived-invalidate reply-count effect **initiates** a
   refetch and stays **unsatisfied until that refetch commits**; the floor
   advances only through **contiguous satisfied** frames, so a pending seq N blocks
   the floor even when a later N+1 already applied. The **pending-satisfaction
   queue** landed (was "deferred option 2"): `markSatisfied` records the seq, then
   drains the floor contiguously; a rejected refetch pins the floor. `satisfied` =
   all per-target effects committed (`Promise.allSettled` all-fulfilled):
   authoritative value written **or** old content `removeQueries`-removed (real
   delete, non-displayable) **or** cold-absent (vacuous) — never "recovery merely
   dispatched". Tests: (i) a content-write frame satisfies once after settle;
   (ii) a derived-invalidate reply satisfies only AFTER the refetch commits (not
   on dispatch), no optimistic `+1`; (iii) a rejected refetch pins the floor;
   (iv) **warm-inactive** target's `removeQueries` route → satisfied (floor may
   advance); (v) **cold-absent** → vacuous satisfy; (vi) a multi-target reply
   satisfies EXACTLY ONCE after all effects settle. (Canonical satisfaction
   disposition in `event-ws-transport-v1.md` §9.)

Plus the message-stream cursor tests inherited from `event-ws-transport-v1.md` §8
(no-listener gap, orphan-frame — the latter now via markSatisfied), and cold-start
two-watermark (§4 cold-start axis).

## P2 done-criteria + acknowledged residual (Cindy, honest delivery framing)

P2 is **done** when: (1) the message-stream two-watermark is correct
(`received-high-water` for wire-gap detection, `applied-high-water` as the
content-apply resume floor); (2) the side scope is separated (`conversation-side:<id>`
cursor-inert, its own reconcile per consumer incl. the agent-activity-feed
`snapshot_required` gap); (3) the read axis is untouched (no `observe()` /
`conversation_reads` / `notifications.read_at` writes); (4) it does **not** re-run
#1251 — no dropped, double-counted, or missed frames.

P2 does **not** claim to have eliminated view-lifecycle influence on **all** warm
caches. The multiple-warm-cache / warm-unmounted residual is **known and bounded**
(handled by the §6 guard + eviction fallback and, structurally, by the P3
interest-registry which keeps caches subscribed). Delivery notes must not overstate
this — P2 closes the #1251 class on message-stream, not every warm-cache lifecycle
edge.
