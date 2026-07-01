# Event-WS Transport — cursor & resume semantics (v1)

Status: canonical. Owns the client↔server contract for the single-connection
event bus *as a transport*: how scopes are subscribed, how per-scope sequence
cursors are tracked, and how missed frames are recovered. Frame shapes live in
`packages/shared/src/ws-frames.ts`; the client implementation is
`apps/desktop/src/renderer/lib/ws-client.ts`; the server replay path is
`packages/backend/src/ws/ws-connection.ts`. Consumers of the delivered events
(unread, presence, reactions, activity) have their own docs — this one stops at
"the right frames reach `onFrame`, exactly once, in order".

## 1. The one invariant

**The per-scope transport cursor is the client's "applied-to-an-active-scope
high-water mark" — not its "received-on-the-socket" mark. The server never
silently advances the client past frames it has not applied.**

Everything below is a corollary. Three bugs (#1241, #1249/#1251, and the #1251
round-2 orphan-frame drop) were the same violation at different points in the
connection lifecycle; the fixes restore it.

- A scope's cursor is `{ epoch, lastSeq }` = the highest seq the client has
  *contiguously observed and dispatched to an active (desired) consumer* for
  that scope (see `EventWsClient.positions`). It must NOT advance on a frame the
  socket merely received while no consumer was interested (see §4.1).
- Per-scope `seq` is strictly monotonic `+1` within an epoch (server
  `scope-event-bus.nextSeq`), across **all** event kinds for the scope — not
  just messages. (The `event_ws.publish` log only records `kind === 'message'`,
  so message-kind publish-log seqs look sparse; the cursor/resume space counts
  every kind, so it is dense and contiguous. The two are the **same** transport
  seq space — `EventFrame.seq` ≡ publish-log `seq` ≡ resume `lastSeq`/`currentSeq`
  — just filtered differently in the log. Note this is the *transport* seq space,
  distinct from `messages.seq` / `stream_head_seq`; see §3.1.) An observed jump
  within the dense space is a real gap.
- `epoch` is the backend's process-start UUID. An epoch change means the seq
  space reset; the old cursor is moot and the client baselines fresh.

> **Target form (Stage 2, not yet built).** The clean end-state is a single
> long-lived **event ingestor / store** that owns `WS frame → apply → advance`
> atomically; components only *read* the store, so mount/unmount never decides
> whether a frame was "seen", and scope subscribe/unsubscribe degrades to pure
> bandwidth optimization rather than a correctness boundary. The orphan-frame
> gate (§4.1) is the same invariant enforced inside today's lifecycle-coupled
> model; it is forward-compatible (the store cursor is also applied-high-water),
> so it is a step toward the target, not a throwaway patch.

## 2. Three independent cursors — never conflated

The transport layer touches exactly one of these. This is the #1244
"surfaced ≠ eliminated" discipline re-asserted at the transport layer:

| Cursor | Owner | Touched by transport recovery? |
|---|---|---|
| Transport frame cursor (`ws-client positions[scope].lastSeq`) | this doc | **Yes — and only this** |
| Read cursor (`conversation_reads`, advanced by `observe()`) | activity-lifecycle-v1 | **Never** |
| Directed read state (`notifications.read_at`) | activity-lifecycle-v1 §5.3.1 | **Never** |

A replayed frame is **byte-identical** to a live `event` frame on the wire and
read-inert by construction: it flows through `onFrame` into the message cache, and
read-state only advances on an explicit user action elsewhere. **"补帧『可得』≠
『已读』" — recoverable ≠ read.** Read-inertness is non-negotiable: provenance
must **never** touch `conversation_reads` / `notifications.read_at` (the table
above stands unchanged).

**Stage-2 (#1255) does need delivery provenance — but at the delivery layer, not
on the payload.** A non-idempotent delta (reply-count / thread-root bump, §4.1)
must know whether it is applying a `live` frame (optimistic `+1`) or a `backfill`
(replay-buffer) frame (→ authoritative recovery, never `+1`). This is **delivery
metadata** the ws-client/ingestor already has — live fanout vs replay-buffer
drain — surfaced to the ingestor as `{provenance: 'live' | 'backfill'}` (or
equivalent call-path context). The **wire `event` frame and `MessageDto` stay
byte-identical**; provenance is *not* a backend payload/schema change. It governs
only content-recovery for non-idempotent deltas — it still writes no read-state,
so read-inertness holds.

## 3. Subscribe = establish-listener, resume-from-cursor

`subscribe(scope)`:

1. Mark the scope desired (refcounted; multiple mounts share one wire
   subscription).
2. Send `{ type: 'subscribe', scope }`.
3. **If a cursor is retained for the scope, send a paired `resume`** from it
   (`sendSubscribe`). The server replays everything after `lastSeq`.

The `subscribed` ack carries the server's high-watermark seq at registration
time. **It is a baseline of last resort, not a re-baseline:** it sets the cursor
*only* when no usable same-epoch cursor is already retained. A retained
same-epoch cursor is client-authoritative — the ack must NOT advance it to head,
or the resume's replay would look stale and the gap would be skipped (this was
the #1251 clobber). A retained cursor from a *stale* epoch is moot → baseline
fresh from the ack; any optimistic resume against the old epoch self-heals via
`snapshot_required`.

### 3.1 Cold-start: two water marks in two seq spaces (Stage-2)

Cold-start (first subscribe, no retained cursor) joins a REST snapshot with the
live frame stream. The load-bearing fact: **these two are in different,
independent seq spaces and must never be mixed into one number.**

- **Transport seq** — `EventFrame.seq` / `SubscribedFrame.seq` / `positions[scope].lastSeq`.
  Minted in-memory by `scope-event-bus.nextSeq` (per scope, +1 over **all** event
  kinds), **reset to 0 on every backend boot**, paired with `epoch`. This is the
  *only* space the transport cursor and `resume` understand.
- **Message seq** — `ConversationMessagesDto.stream_head_seq`, i.e.
  `conversation_stream_heads.latest_seq`, which stores a value from the persisted
  conversation-global allocator (`messages.seq`). It **survives reboots** and is
  the space `observe()` / `conversation_reads` live in.

> **Why they cannot be conflated (reboot proof).** After a restart the transport
> space resets to 0 (new `epoch`) while `stream_head_seq` is still, say, 2521.
> Seeding `positions[scope].lastSeq = 2521` and resuming would match nothing in
> the fresh replay buffer (seqs `1..N`), so the client believes it is caught up;
> the live frames that follow arrive at transport seq `1, 2, …` — all `≤ 2521` —
> and are dropped as stale. Every reboot silently breaks the stream. So
> `stream_head_seq` **never** seeds `positions`.

The two water marks have disjoint jobs:

1. **Transport baseline** (transport space, with `epoch`) — the cold-start floor
   for `positions[scope]` / resume. It is the `subscribed` ack seq `S`, but it is
   **committed only after the REST snapshot has been applied** — the ack arriving
   does *not* mean the store is applied to head. (This is the corrected #5: the
   rule is not "never ack-baseline", it is "never advance the applied cursor off
   the ack head *before* the snapshot is applied".)
2. **Message snapshot boundary** (message space) — `stream_head_seq`, used only to
   decide whether a buffered **message** payload is already covered by the
   snapshot: `payload.message.seq ≤ stream_head_seq` → drop/no-op,
   `> stream_head_seq` → apply (append or gap-bump). It is **never** written to
   `positions`.

Correct cold-start order:

```
subscribe
  → record subscribed transport seq S; buffer every frame after S (don't apply)
  → REST snapshot loads and is applied to the cache
  → commit transport cursor = S            (transport space)
  → drain the buffer in transport-seq order:
      • message-kind: dedup by payload.message.seq vs stream_head_seq (message space)
      • each frame: after its store effect succeeds → markApplied(scope, frame.seq, frame.epoch)
```

Subscribe-before-read closes the "published after the REST read but before the
listener attached" gap. A view with no message-window snapshot cannot independently
seed the cursor — it must first obtain a snapshot or wait for an existing cursor.

**Per-kind pre-S coverage vs drain idempotency — two different axes (Cindy's
checkpoint).** Idempotent apply only makes draining the buffer (frames *after* S)
safe to replay; it says **nothing** about events that happened *before* S, which —
with no listener attached yet — were never buffered. So cold-start must define,
per event kind, an explicit **pre-S state coverage**: where does the current state
for everything up to S come from?

- `message` / `reaction` / `task_changed` — covered by `ConversationMessagesDto`
  (messages up to `stream_head_seq`; reaction aggregates and task fields embedded
  in the same DTO).
- `agent_activity` — **not** in the message snapshot (it is `AgentRunState`, a
  separate source). If the UI needs cold-start to show the correct *current* run
  state, it **must** have its own snapshot/REST source; otherwise it must be
  declared **best-effort / live-only**. Pure idempotent apply does **not** cover
  it — that only replays S-after frames, it cannot rebuild the pre-S current state.

Orthogonally, the buffer drain must be idempotent so any replayed/duplicate frame
is a safe no-op. Idempotency is a drain/replay-safety requirement, **not** a pre-S
coverage relation — the two must not be conflated. Cross-ref
`docs/renderer-event-ingestion-v1.md` §4.3.5 / §5.

## 4. Unsubscribe retains the cursor

`unsubscribe(scope)` drops the desired/confirmed/recovery state **but keeps
`positions[scope]`**. The scope becomes *detached*: no live listener, cursor
retained so a later resubscribe (§3) can replay anything published in the gap.

Pre-fix, `unsubscribe()` deleted the cursor, so the next `subscribe()` had
nothing to resume from and re-baselined to head off the ack — silently skipping
every frame published while no listener was attached (the **no-listener gap**,
`646d223`). The inbox/Activity work didn't introduce this; it mounts and
unmounts conversation views far more often, so the latent defect started firing
in dogfood.

Cursors are retained for the **whole session** — there is deliberately no
eviction bound. The cost is a scope string + two primitives per scope, sub-MB
even at 10× the conversations a session ever opens; a stale cursor self-heals on
resubscribe (resume → replay, or `snapshot_required` if the gap exceeds the
server buffer). A bounded LRU is **not admissible as a bare delete**: an evicted
scope resubscribes with no `resume`, the server has no reason to emit
`snapshot_required` (it never saw a stale position), and the `subscribed` ack
baselines to head — which silently skips any traffic during detachment, i.e.
the no-listener gap returning in LRU form. If memory ever forces a bound it
**must** carry a tombstone → forced snapshot: an evicted scope's next
subscribe must drive the `snapshot_required` refetch path rather than ack-
baseline. (That path is cheap on the renderer — `channels/hooks.ts` already
maps `snapshot_required` → `invalidateQueries` — but it is out of scope until a
real memory pressure point exists.)

### 4.1 Orphan-frame gate — cursor advances only for desired scopes

Retaining the cursor across unsubscribe is necessary but not sufficient. There is
a race: when a view unmounts, the client-side `unsubscribe()` removes the scope
from `desiredScopes` and detaches the bridge listener **immediately**, but the
socket stays OPEN and the server keeps fanning out events for that scope until it
processes the unsubscribe (tens of ms later). A frame landing in that window has
**no consumer to apply it**. If the client let such a frame advance the cursor
(or let a late `subscribed` ack re-baseline, or a late `snapshot_required`
refetch), the cursor would move past a frame that was never applied — and the
eventual resubscribe would resume *after* it, losing it until a manual refetch.

This was the #1251 round-2 drop: R2-C1 was a **live message** published ~2s
*before* the user switched away (`listenerCount:1` server-side), but it reached
the client after the local listener had already detached. `acceptEventFrame`
advanced the cursor for it (and the non-message frames behind it) with nothing to
apply them to; the switch-back resume started above C1's seq, so it never came
back. Note the no-listener batch published *after* the server stopped fanning out
replayed fine — only the one frame caught in the local-unmount-vs-server-stop
gap was lost.

The fix: `handleFrame` ignores any scope-bearing frame (`event` / `subscribed` /
`snapshot_required`) whose scope is not in `desiredScopes` — no cursor advance,
no `confirmedScopes`/baseline mutation, no `positions` delete, no dispatch (it
emits an `orphan_frame` diagnostic and returns). The retained cursor therefore
stays frozen at the last seq that was applied **while the scope was desired**, so
the resubscribe's resume replays the orphaned frame. This is the invariant from
§1 stated operationally: **the cursor tracks applied-to-active-scope, not
socket-received.**

> **Stage-2 (#1255): two watermarks + content-apply-only.** Canonical design:
> `docs/event-ws-recovery-class-scope-v1.md` (recovery-class scope partition +
> the full predicate, verdict signed by Cindy/Norman/Alice). The orphan gate's
> two conflated jobs split into two watermarks on the message-stream scope:
>
> - **`received-high-water`** — advanced in `acceptEventFrame` on **every**
>   received desired-scope frame. Serves **wire continuity / forward-gap detection
>   only** (§5). It does **not** imply the content is store-recoverable.
> - **`applied-high-water`** (= the retained `positions[scope]` resume floor) —
>   advanced by the ingestor's `markApplied(scope, seq, epoch)` **only when a frame
>   produced a real write to a resume-recoverable content cache.** This alone is
>   the resume floor.
>
> They coincide while a content reader applies every frame; they diverge whenever
> the scope legally receives a message frame that writes no warm content — a
> derived-invalidate-only reader (`useChannelThreads`/`useThreadFollowers`), or an
> **off-window reply** (the `bumpReplyCountInCache` `!hasKey && !hasRoot` no-op)
> even with ChannelView mounted. Gap detection reads `received`, so a stalled
> `applied` never raises a false gap; resume replays from `applied`, so a
> readerless/no-op frame is re-delivered to a later content reader (idempotent).
> This **supersedes** the earlier single-cursor reasoning here (that a gap-bump
> "must still advance the cursor or resume re-delivers forever") — under two
> watermarks `received` carries continuity, so `applied` is free to track only
> real content and never stalls.
>
> **What counts as a content write (Cindy's boundary).**
> - **Advances `applied`:** mainline tail-append, **first** mainline live-gap bump,
>   **in-window** reply-count bump, cluster append/patch, thread-root / root-badge
>   bump, reaction / task-chip patch of an in-cache row.
> - **Cursor-inert (must NOT advance `applied`):** **off-window** reply-count
>   no-op, a live-gap bump when the gap is **already** `true`, Threads-list /
>   followers derived-invalidate, any frame whose target has no reader.
>
> **Implementation — helpers return `applied: boolean`, tiered by replay-idempotency
> (Norman).** `markApplied` must **not** be inferred from a `setQueryData` reference
> change: `bumpReplyCountInCache` returns a fresh outer object even on a no-op,
> which would mis-advance the resume floor (a #1251 re-entry). A false **positive**
> is always #1251 (a no-op marked applied floats the floor past un-applied
> content). Whether a false **negative** is safe depends on the kind, because an
> under-reported frame stays above the floor and is **replayed** — safe only if
> that replay is idempotent:
> - **Idempotent kinds (false-negative safe; may err toward false)** —
>   `appendMessageToCache` (dedups by message id), `applyReactionToMessage` (**sets**
>   the aggregate from the event's absolute `count`), `applyTaskChangedToCache`
>   (**sets** task fields), activity `mergeById`. Replay is a no-op.
> - **Non-idempotent kinds (false-negative UNSAFE)** — `bumpReplyCountInCache` and
>   `applyThreadRootReplyBump` are unconditional `+1` deltas with **no per-reply-id
>   dedup**, so replaying a reply frame **double-counts**. ("REST
>   `reply_counts_by_root` recompute self-heals it" is exactly the hidden
>   compensation path to avoid.) These must **either** report `applied` exactly
>   after a real bump (trivial: `applied = !(took the !hasKey && !hasRoot early
>   return)`) **or** be made replay-idempotent via per-reply-id dedup before relying
>   on replay. (Tiers audited by Cindy.)
>
> So the rule is not a blanket "conservatively mark true." It is: false-positive
> forbidden always; false-negative permitted **only** for kinds whose replay is
> idempotent. **Implementation gate (Cindy):** a boolean predicate is not enough —
> every `applied:false` path that can be replayed must be *proven* either
> replay-idempotent or accurately marked, with a per-kind test (including "the same
> reply frame replayed above the floor does not double-count") and per-content-kind
> `snapshot_required` coverage. Otherwise "false-negative safe" degenerates into a
> hidden compensation path.
>
> > **Non-idempotent delta resolution (Alice + Cindy, signed).** Reachability is
> > **confirmed** (`subscribe()` is refcounted, so a ChannelView mounting under an
> > already-subscribed Threads panel fires no resume; the initial REST load makes
> > `reply_counts_by_root` authoritative *including* a prior off-window reply; a
> > later socket reconnect resumes from the old applied floor and backfills that
> > reply, and `bumpReplyCountInCache` (hooks.ts:653) `+1`s unconditionally on top →
> > double). Accurate live marking cannot save it (no apply happened live).
> >
> > The fix is **provenance + authoritative recovery, not bare skip.** The
> > **delivery path carries** `live` / `backfill` provenance (ws-client/ingestor
> > delivery metadata — live fanout vs replay-buffer drain — **not** a wire/payload
> > schema change; the `event` frame and `MessageDto` stay byte-identical, see §2).
> > A non-idempotent delta (`bumpReplyCountInCache`, `applyThreadRootReplyBump`):
> > - on `live` → optimistic `+1` as today;
> > - on `backfill` → **must NOT delta-apply, and must NOT silently no-op.** It
> >   forces **authoritative recovery** of the affected target — invalidate/refetch
> >   the content cache holding that root's count (or confirm a covering REST
> >   snapshot already applied this resume cycle). This reuses the existing
> >   `reconcile*` / `invalidateQueries` machinery; it does **not** change the
> >   count-shaped cache or the REST DTO.
> >
> > Bare skip would fix double-count into **missed-count** (Cindy's counter-example:
> > ChannelView open, root in-window, a reply missed during a disconnect → resume
> > backfill → if skipped with no refetch, the count is permanently short by 1). So
> > the rule is *skip optimistic delta + force authoritative recovery for that
> > target*. Acceptance must cover **both** directions:
> > 1. REST already includes the reply count, then resume replays the reply →
> >    **not** double-counted;
> > 2. an active window misses a reply during a disconnect → resume backfill does
> >    **not** delta-apply but **does** trigger refetch/reconcile → final count
> >    correctly +1.
> >
> > Idempotent kinds (append by-id, set-type reaction/task, activity merge-by-id)
> > are unaffected — they may apply identically on `live` and `backfill`.
>
> > **Applied-water timing of backfill-reconcile frames (Alice transport lane;
> > Cindy-corrected, reverses the earlier "count as applied on invalidate" lean).**
> > A backfill non-idempotent delta **initiates** authoritative recovery and stays
> > **unapplied until that recovery commits**. `invalidateQueries()` dispatches a
> > refetch — it is *not* proof the content is recoverable; the refetch may fail, be
> > cancelled, or not yet have written the authoritative count. The applied-water is
> > a **durable resume floor**, an in-flight refetch is not — so advancing the floor
> > past such a frame on dispatch would re-create a silent **missed-count** (resume
> > stops re-delivering seq N while the UI still holds the stale count). Norman's and
> > my first lean ("invalidate fired ⟹ applied") is therefore **rejected**.
> >
> > Two invariants follow:
> > 1. **Commit-gated:** the seq carrying a backfill non-idempotent delta is not
> >    applied until its authoritative recovery has **committed** (the authoritative
> >    count is in cache, via refetch success or a covering snapshot).
> > 2. **Contiguous floor:** applied-water is the high-water of a *contiguously*
> >    satisfied run. A pending-recovery seq N **blocks** the floor even if a later
> >    frame N+1 (append / reaction / task) applied successfully — N+1's write lands
> >    in cache but the floor cannot pass N until N is satisfied.
> >
> > **v1 = option 1 (simple-safe), chosen.** Backfill non-idempotent delta triggers
> > (and naturally coalesces) the per-target refetch but does **not** count as
> > applied; the floor stays at N−1. It releases through the **existing**
> > buffer-overflow → `snapshot_required` path, which commits the floor to the
> > server-stamped transport seq (`SnapshotRequiredFrame.currentSeq`, apply-gated —
> > **§6**), satisfying N and everything contiguous at once (the same baseline
> > mechanism cold-start uses; the seq comes from transport space, **never**
> > `stream_head_seq`). Cost, surfaced honestly: one
> > unsatisfiable backfill delta **pins the floor for the rest of the session**, so
> > each later reconnect replays the tail from N−1 until the replay buffer (200/scope)
> > overflows and forces the covering snapshot. That redundant replay is **bounded**
> > (≤ buffer depth, idempotent applies) and **self-healing**; correctness over
> > efficiency, no new state.
> >
> > **option 2 (deferred optimization) — per-scope pending-satisfaction queue.** Track
> > each pending backfill seq; on its refetch commit mark that seq *satisfied*, then
> > advance applied-water contiguously (absorbing the already-applied N+1…M). This
> > eliminates the floor-pin and the redundant replay, at the cost of a stateful queue
> > with its own failure modes (leaked entries on never-committing refetch, cancel
> > handling, epoch-flip-while-pending). **Only in this model does "a backfill-reconcile
> > frame counts as applied" hold** — and only *after* commit, never on dispatch. Not
> > built for v1; revisit if dogfood shows the floor-pin churn matters.
> >
> > **`satisfied` defined precisely (Cindy + Norman, signed).** A pending backfill
> > seq becomes *satisfied* — and only then may advance the floor — by **one of two**
> > routes, never by mere dispatch:
> > 1. **authoritative value written** — the affected target's authoritative count is
> >    in cache (refetch success, or a covering snapshot committed); or
> > 2. **synchronous strong eviction** — the old content was `removeQueries`-removed
> >    (a *real delete*, not a stale-mark), so it provably cannot be displayed and a
> >    future mount must REST cold-start.
> > Route 2 is clean **only for an inactive/absent target** (no live observer): there
> > `removeQueries` advances that seq immediately. For an **active** target
> > (ChannelView open) it is **forbidden** — `removeQueries` makes the observer flash
> > `undefined`→loading on every reconnect (UX-unacceptable, and it is the warm-cache
> > bulldozer we rejected as option 3). An active target must use background
> > invalidate/refetch, which is async-commit → its seq stays **pending/unapplied
> > until the refetch commits** (route 1). So: every "recovery initiated" is *not*
> > applied; only "authoritative value written" or "old content synchronously removed
> > and non-displayable" is satisfied — and the active backfill delta always lands in
> > option 1's conservative floor-pin.
> >
> > Acceptance (adds to §8 / the recovery-class doc): (i) a backfill non-idempotent
> > delta does **not** advance the floor while its recovery is pending; (ii) a later
> > applied frame does **not** jump the floor past that pending seq; (iii) the floor
> > releases on the covering `snapshot_required` snapshot; (iv) repeated reconnect
> > re-coalesces to a single recovery with **no** double-count and no missed-count;
> > (v) an **inactive/absent** target's `removeQueries` route marks that seq satisfied
> > (floor may advance); (vi) an **active** target uses invalidate/refetch (no
> > `removeQueries` flash) and its seq stays pending until commit.
>
> **Read-inert + granularity unchanged.** The live-gap affordance never feeds the
> resume floor or `observe()`/`read_at` (#1244 holds). `markApplied`/`applied` is
> **scope-level** (one resume floor per `conversation:<id>`); the per-target reader
> gates and the affordance are **window/key-level**. A frame may write some open
> targets and not others; `applied` advances iff **≥1** target took a real content
> write. Truly applying with no reader mounted = P3 interest registry, out of P2
> scope. **The per-target reader gates are not lifted in P2; `markApplied` honors
> them.**
>
> Removal of the literal orphan-gate code is **not** unconditional: allowed only
> once three preconditions are statically verifiable — (a) the App-level ingestor
> is the sole consumer of message-stream frames, (b) no view hook calls
> `onWsFrame` or writes a message-window cache, (c) the resume-floor writer is
> `markApplied` (`acceptEventFrame` stops advancing `applied`, still advances
> `received`). Until all three hold, the gate stays.

## 5. Live forward-gap recovery (#1241)

While the socket stays OPEN (so reconnect/resume never fires), a dropped frame
used to advance the cursor silently. `acceptEventFrame` now gates every live
`event` on seq continuity within the cursor's epoch:

- `seq === lastSeq + 1` — contiguous. Advance, drop any recovery latch, dispatch.
- `seq > lastSeq + 1` — forward gap. Hold the cursor, `resume` from it, latch
  `recovering` so concurrent gapped frames coalesce into one in-flight resume,
  and swallow the frame (replay redelivers it in order).
- `seq <= lastSeq` — duplicate/stale. Dispatch (cache is idempotent), do not move
  the cursor or disturb recovery.
- missing cursor / epoch change — fresh baseline, dispatch.

The `recovering` latch clears on the first contiguous (replay-caught-up) frame,
on `snapshot_required`, and at every connection-lifecycle reset — no timer, no
deadlock.

## 6. Recovery exhausted → snapshot_required

If the server can't cover the gap (replay buffer too small, or epoch mismatch)
it sends `snapshot_required`.

**Stage-1 (current):** the frame is `{type, scope, reason}` only. The client
deletes the cursor, drops the recovery latch, dispatches so conversation hooks do
a full REST refetch, and the **next event re-baselines** the cursor. This works
only because Stage-1's cursor is transport-driven (`acceptEventFrame` re-baselines
on the first post-snapshot event).

**Stage-2 P2 — snapshot_required IS a re-cold-start, and needs a transport-seq
baseline source (Cindy blocker, signed option 1).** Once the cursor is
`markApplied`-driven, "the next event re-baselines" no longer holds: nothing tells
the resume floor where to land. The baseline **must** come from the transport seq
space (`EventFrame.seq` / `SubscribedFrame.seq` / `positions[scope]`) — it can
**never** be `stream_head_seq` (the REST snapshot's message-seq; the §3.1 reboot
proof forbids it). The scope stays subscribed across snapshot_required (no
`SubscribedFrame` is re-emitted to harvest a seq from), so:

- **Extend the frame (shared schema):** `SnapshotRequiredFrame` gains
  `{ epoch, currentSeq }` — the server's current transport seq + epoch for the
  scope at emit time (it already holds both in `ws-connection.ts`; backend stamps
  them — Alice/backend lane, Cindy reviews). This makes the frame **isomorphic to `SubscribedFrame`
  / `EventFrame`** (all three position-bearing server frames now carry
  `epoch` + a transport seq); the seq-less `SnapshotRequiredFrame` was the lone
  inconsistency, and option 1 removes it. (Option 2 — force a redundant
  re-subscribe just to harvest `SubscribedFrame.seq` — is rejected: the scope is
  already subscribed, so re-subscribing to mint a baseline fights the protocol.)

- **Commit is apply-gated, not receipt-gated (isomorphic to cold-start §3.1 and to
  the backfill-recovery rule §4.1 — three places, one rule).** Receiving the frame
  does not advance the floor. The flow:
  1. **Transport** records `pendingBaseline[scope] = { seq: currentSeq, epoch }`,
     drops the recovery latch, and **buffers** live frames `> currentSeq` for the
     scope (does not apply them — exactly cold-start buffering); dispatches the
     frame to the ingestor.
  2. **Ingestor (renderer lane)** brings every target in the scope to a
     guaranteed-recoverable state, by the **same `satisfied` taxonomy as §4.1** (no
     new rule), then signals the transport once all are satisfied:
     - **active target** (live observer, warm cache) → `reconcile*` /
       `invalidateQueries`, made **promise-returning** (drop the fire-and-forget
       `void`), background refetch, no flash → satisfied **on fulfilled settle**
       (these are the async waits, joined below);
     - **inactive target** — satisfied **only if provably reconstructed from
       authoritative REST on next mount, never from replay-to-fill** (see the guard
       below). Two clean ways to guarantee that: leave a truly **absent** cache (no
       data → cold-start on mount, trivially satisfied), or **`removeQueries`** a
       warm-unmounted cache (synchronous strong eviction; no observer to flash →
       forces REST cold-start). A warm cache left in place is satisfied **only** when
       the guard proves its remount does an authoritative refetch rather than serving
       a `gcTime`-residual stale cache.
     The load-bearing hazard is the warm-unmounted cache: if a later mount could serve
     it fresh **without** an authoritative refetch, committing the floor past
     `currentSeq` is a **silent skip** (the floor moved past frames that cache never
     applied). This must not rest on assumption — see the guard in §8. (P3's
     interest-registry shrinks this category by keeping caches subscribed; P2 closes
     it by the guard + eviction fallback.)
     **Commit signal — `allSettled`, not fail-fast (Cindy).** Join the active
     reconciles with `Promise.allSettled` (or equivalent): **all fulfilled** → fire
     `commitSnapshotBaseline(scope, epoch)` once (multiple targets coalesce to one
     commit, same shape as §8 (h)(iii)); **any rejected / cancelled / aborted** →
     **do not commit**, emit a diagnostic; the floor stays pinned and the next resume
     retries (initiated ≠ committed, carried all the way to the floor). Fail-fast
     `Promise.all` is wrong here — it would let the first rejection mask the other
     targets' outcomes.
  3. **Transport** commits on that signal: if the signalled epoch matches
     `pendingBaseline.epoch`, set `positions[scope] = pendingBaseline`, clear
     pending, and drain the buffer `> seq` in transport-seq order. A stale-epoch or
     no-pending signal is discarded (a newer epoch superseded the recovery).

- **Bounded-context boundary (transport↔ingestor):** the renderer never handles a
  transport seq. Its only signal is "the snapshot content for this scope committed"
  — a content fact it owns — via a transport method (e.g.
  `commitSnapshotBaseline(scope, epoch)`); transport translates that into advancing
  the floor to the seq **it** stashed. This is the same commit-after-apply discipline
  as `markApplied` for content frames and the active-target backfill recovery (§4.1).

This is exactly what releases the option-1 backfill floor-pin (§4.1): when the
pinned floor lets the gap grow past the replay buffer, the server emits
`snapshot_required{currentSeq}`; the apply-gated commit above advances the floor to
`currentSeq` with a **real transport seq**, not the imaginary `snapshotMaxSeq` the
earlier draft named.

## 7. Reconnect

On a fresh socket's `authenticated` frame, `resubscribeDesiredScopes()` re-sends
`subscribe` for every desired scope and one batched `resume` carrying each
scope's retained cursor. Same invariant as §3, applied to the whole desired set
at once.

## 8. Test coverage

`apps/desktop/src/renderer/lib/ws-client.test.ts`:
- viewer-scope canonicalisation (alias never on the wire; reconnect resume
  carries canonical `viewer:<id>` + last seq).
- live forward-gap recovery (#1241): contiguous dispatch, gap swallow + resume,
  snapshot_required re-baseline, concurrent-gap coalescing.
- no-listener gap (#1251): cursor retained across unsubscribe and replayed on
  resubscribe; `subscribed` ack does not clobber a retained same-epoch cursor;
  stale-epoch ack does re-baseline; detached cursors retained for the whole
  session (no lossy eviction — the oldest still resumes after heavy churn).
- orphan-frame gate (#1251 round-2, §4.1): an `event` arriving after unsubscribe
  does not advance the retained cursor (frozen at last applied seq, resume
  replays it); a late `subscribed` ack for a no-longer-desired scope does not
  re-baseline; a late `snapshot_required` for it does not delete the cursor.
- snapshot_required baseline (§6, Stage-2): the post-snapshot resume floor is the
  server-stamped transport seq (`SnapshotRequiredFrame.currentSeq` / `SubscribedFrame.seq`),
  **never** `stream_head_seq`; the floor commits **only after** the ingestor's
  reconcile settles (apply-gated, not on frame receipt); the join is
  `Promise.allSettled` — **all fulfilled** → one `commitSnapshotBaseline`, **any
  rejected/cancelled/aborted** → no commit + diagnostic + floor stays pinned (next
  resume retries); the commit is epoch-checked (a stale-epoch / no-pending
  `commitSnapshotBaseline` is discarded); live frames in `(currentSeq, commit]` are
  buffered and drained post-commit without double-count.
- snapshot_required inactive-target guard (§6): every target treated as
  inactive-vacuous-satisfied must be **proven** (test / static guard) to reconstruct
  from authoritative REST on next mount — not to serve a `gcTime`-residual stale
  cache expecting replay-to-fill. A target that can't prove it must either join the
  active reconcile set or be `removeQueries`-evicted to non-displayable at
  snapshot_required; an **active** target must never be `removeQueries`-evicted (it
  would flash loading) — invalidate/refetch only, pending until commit.
- snapshot_required content-target **whitelist** (Cindy + Norman; guard, not a
  scattered observer-count branch): every conversation-scope content target is
  explicitly classified as exactly one of `active-reconcile` (live observer →
  invalidate/refetch, joined) / `warm-remove` (warm cache, `refetchOnMount:false`
  primeAround — e.g. mainline `useChannelMessages`, `useThreadCluster` — →
  `removeQueries`) / `absent-vacuous` (no cache) / `always-refetch-safe`
  (`refetchOnMount:'always'` — e.g. `useAgentRunStates`, `useAgentActivityFeed` →
  mount forces authoritative REST, no eviction needed). A **new** conversation-scope
  content target with no declared class **fails the test** — behavior must not drift
  implicitly.

## 9. Implementation status — step-4 transport seam (#1255 P2, shipped)

The transport half of the two-watermark flip is implemented in `ws-client.ts`
(the ingestor half — `markApplied` call sites, `commitSnapshotBaseline` after the
`allSettled` reconcile join, and the `live`/`backfill` provenance branch — is
Norman's renderer lane). The v1 decisions worth naming (all deliberate, all
correctness-first):

- **Two watermarks only for content-gated scopes** (`isContentGated(scope) =
  parseConversationScope(scope) !== null`, i.e. the message stream
  `conversation:<id>`). Every other scope (`viewer:` / `workspace:` / `app` /
  `conversation-side:`) has no content-apply seam, so its floor **auto-advances
  with `received`** — the pre-P2 single-cursor behavior, preserved bit-for-bit.
  `conversation-side:` is cursor-inert / self-healing, so it correctly falls in
  the auto-advance set.
- **Provenance is derived, not latched.** A frame extending the received-water is
  `live`; a frame at-or-below it (`seq <= received`) is a `backfill` re-delivery.
  This is exactly "live fanout vs replay-buffer drain" without a separate replay
  flag: the received-water already *is* "what I have seen". Delivered as a second
  `onFrame(frame, meta)` arg (`EventDeliveryMeta`), undefined for non-event frames
  — no wire/payload change.
- **`markApplied` advance is strict-contiguous (v1 = option 1).** Floor moves to
  `seq` only when `seq === floor + 1`; any skipped seq (no-op / readerless /
  pending backfill delta) pins the floor until the covering `snapshot_required`
  commit. Set-max is forbidden (false-positive = #1251). Option 2's
  pending-satisfaction queue is deferred.
- **`snapshot_required` re-cold-start is fully apply-gated** (pendingBaseline +
  buffer `> currentSeq` + `commitSnapshotBaseline(scope, epoch)`, epoch-checked,
  drains post-commit). **Cold-start (first subscribe) is NOT pendingBaseline-gated
  in v1** — the `subscribed` ack baselines both water marks immediately. This is
  safe because the REST snapshot is the authoritative pre-S coverage (§3.1): a
  resume-from-S that "skips" transport seqs `1..S` loses nothing, since the
  snapshot already reflects them. The live-vs-REST *ordering* at cold-start is the
  ingestor's concern (React Query), not a resume-floor correctness one.
- **Orphan-frame gate retained, not removed** (§4.1 permits this). Its removal
  preconditions are not all met — `useConversationStream` still registers an
  `onWsFrame`. It is complementary to the applied floor (pre-filters non-desired
  scopes before any water-mark/dispatch touch), so it stays until P3.
- **Known v1 cost:** a snapshot reconcile that never commits (persistently
  rejected refetch) keeps `pendingBaseline` + buffer for the connection's
  lifetime (floor pinned, frames buffered). It self-heals on the next reconnect
  (`clearConnectionState` drops pending/buffer; resubscribe re-arms via a fresh
  `snapshot_required`). Matches §6 "floor stays pinned and the next resume
  retries."

