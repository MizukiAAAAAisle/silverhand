# Event-WS Transport — cursor & resume semantics (v1)

This doc owns the client↔server contract for the single-connection
event bus *as a transport*: how scopes are subscribed, how per-scope sequence
cursors are tracked, and how missed frames are recovered. Frame shapes live in
`packages/shared/src/ws-frames.ts`; the client implementation is
`apps/desktop/src/renderer/lib/ws-client.ts`; the server replay path is
`packages/backend/src/ws/ws-connection.ts`. Consumers of the delivered events
(unread, presence, reactions, activity) have their own docs — this one stops at
"the right frames reach the ingestor in order, with duplicate/replay delivery
made safe downstream." The wire is **not** exactly-once: resume and reconnect
can re-deliver a frame, so correctness rests on ingestor idempotency +
authoritative recovery (§9), never on a once-only delivery guarantee.

## 1. The one invariant

**A content-gated scope tracks two watermarks, not one. The resume floor is the
`applied`-high-water — the highest seq whose effects have reached a resume-safe
satisfaction disposition (§9) — never the `received`-on-the-socket mark. The
server never silently advances the client past frames whose effects it has not
committed.**

Everything below is a corollary. The failure mode this rules out: if a frame the
socket merely received — no consumer applied it, or it was an off-window /
readerless no-op — advanced the resume floor, the next resume would start
*after* it and the frame would be lost until a manual refetch.

- The two watermarks (see §4.1, §9): **`received`-high-water** advances on every
  in-order desired-scope frame and serves wire-continuity / forward-gap
  detection only (§5); **`applied`-high-water** (the retained
  `resumeFloorPositions[scope]` resume floor) advances only via the ingestor's
  `markSatisfied`, once a frame's effects commit. They coincide while a content
  reader applies every frame and diverge on a readerless / no-op frame. A
  non-content-gated scope has no apply seam, so its floor auto-advances with
  `received` (§9).
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

> **Central ingestor.** A single long-lived **event ingestor** —
> `conversation-ingestor.ts`, the App-level `ingestConversationFrame` /
> `useConversationIngestor` — is the central consumer of conversation frames
> across both transport scopes; it owns `frame → apply → markSatisfied`, and
> components only *read* the resulting caches. Because a view hook
> (`useConversationStream`) can also register an `onWsFrame`, the
> lifecycle-coupled orphan-frame gate (§4.1) enforces the same applied-floor
> invariant for those listeners.

## 2. Transport watermarks vs read state — never conflated

Transport recovery touches only the transport-layer watermarks — the two
per-scope water marks of §1/§9 (`receivedPositions` / `resumeFloorPositions`):
one transport cursor concept, two watermarks, not a third read-facing cursor. It
never touches read state:

| State | Owner | Touched by transport recovery? |
|---|---|---|
| Transport watermarks (`receivedPositions` / `resumeFloorPositions`) | this doc | **Yes — and only these** |
| Read cursor (`conversation_reads`, advanced by `observe()`) | activity-lifecycle-v1 | **Never** |
| Directed read state (`notifications.read_at`) | activity-lifecycle-v1 §5.3.1 | **Never** |

A replayed frame is **byte-identical** to a live `event` frame on the wire and
read-inert by construction: it flows through `onFrame` into the message cache, and
read-state only advances on an explicit user action elsewhere. **"补帧『可得』≠
『已读』" — recoverable ≠ read.** Read-inertness is non-negotiable: provenance
must **never** touch `conversation_reads` / `notifications.read_at` (the table
above stands unchanged).

**No delivery provenance.** A replayed frame carries no `live`/`backfill` tag:
the ws-client derives no provenance, `onFrame` carries no `meta`, and a
replay-drain frame dispatches **identically** to fresh fanout. Replay
idempotency is wholly the ingestor's responsibility — every non-idempotent
projection recovers by *authoritative invalidate* (no optimistic `+1`), and rows
dedupe by id. The failure mode this forbids: a non-idempotent delta (a
reply-count / thread-root bump, §4.1) applied optimistically on a replayed frame
would double-count if a concurrent REST snapshot already covered it; recovering
by authoritative invalidate instead makes replay ≡ fresh, so the ingestor never
needs to know whether a frame is live or a backfill drain. The wire `event`
frame and `MessageDto` are byte-identical, and no path writes read-state, so
read-inertness (§2) holds unchanged.

**The HTTP ACK is not a transport source.** A committed `message` reaches the
renderer on the WS `message` frame **and** as the human send route's HTTP ACK —
the SAME committed payload (`{ message, projections? }`), produced once
backend-side (#task:1749). Only the **WS frame is a transport event**: it carries
a per-scope `seq`/`epoch`, advances `received`, and — once its effects settle —
advances the `applied` resume floor via `markSatisfied`. The ACK carries **no**
transport identity: no `seq`, no `epoch`, no watermark of either kind, and no
read state (§2 table stands). It shares only the renderer's idempotent apply seam
so the sender sees content + derived projections immediately; it never
participates in resume, forward-gap detection, or the satisfaction state machine.
Because both apply paths are absolute/idempotent, the same committed message
applied on both planes is safe with no once-only coordination — only
invalidate-only effects may refetch once more, an accepted best-effort cost.

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
or the resume's replay would look stale and the gap would be skipped. A retained
cursor from a *stale* epoch is moot → baseline
fresh from the ack; any optimistic resume against the old epoch self-heals via
`snapshot_required`.

### 3.1 Cold-start: two water marks in two seq spaces

Cold-start (first subscribe, no retained cursor) joins a REST snapshot with the
live frame stream. The load-bearing fact: **these two are in different,
independent seq spaces and must never be mixed into one number.**

- **Transport seq** — `EventFrame.seq` / `SubscribedFrame.seq` / `resumeFloorPositions[scope].lastSeq`.
  Minted in-memory by `scope-event-bus.nextSeq` (per scope, +1 over **all** event
  kinds), **reset to 0 on every backend boot**, paired with `epoch`. This is the
  *only* space the transport cursor and `resume` understand.
- **Message seq** — `ConversationMessagesDto.stream_head_seq`, i.e.
  `conversation_stream_heads.latest_seq`, which stores a value from the persisted
  conversation-global allocator (`messages.seq`). It **survives reboots** and is
  the space `observe()` / `conversation_reads` live in.

> **Why they cannot be conflated (reboot proof).** After a restart the transport
> space resets to 0 (new `epoch`) while `stream_head_seq` is still, say, 2521.
> Seeding `resumeFloorPositions[scope].lastSeq = 2521` and resuming would match nothing in
> the fresh replay buffer (seqs `1..N`), so the client believes it is caught up;
> the live frames that follow arrive at transport seq `1, 2, …` — all `≤ 2521` —
> and are dropped as stale. Every reboot silently breaks the stream. So
> `stream_head_seq` **never** seeds `resumeFloorPositions`.

The two water marks have disjoint jobs:

1. **Transport baseline** (transport space, with `epoch`) — the cold-start floor
   for `resumeFloorPositions[scope]` / resume. It is the `subscribed` ack seq `S`, but it is
   **committed only after the REST snapshot has been applied** — the ack arriving
   does *not* mean the store is applied to head. (The rule is not "never
   ack-baseline", it is "never advance the applied cursor off the ack head
   *before* the snapshot is applied".)
2. **Message snapshot boundary** (message space) — `stream_head_seq`, used only to
   decide whether a buffered **message** payload is already covered by the
   snapshot: `payload.message.seq ≤ stream_head_seq` → drop/no-op,
   `> stream_head_seq` → apply (append or gap-bump). It is **never** written to
   `resumeFloorPositions`.

Correct cold-start order:

```
subscribe
  → record subscribed transport seq S; buffer every frame after S (don't apply)
  → REST snapshot loads and is applied to the cache
  → commit transport cursor = S            (transport space)
  → drain the buffer in transport-seq order:
      • message-kind: dedup by payload.message.seq vs stream_head_seq (message space)
      • each frame: after its effects commit → markSatisfied(scope, frame.seq, frame.epoch)
```

Subscribe-before-read closes the "published after the REST read but before the
listener attached" gap. A view with no message-window snapshot cannot independently
seed the cursor — it must first obtain a snapshot or wait for an existing cursor.

**Per-kind pre-S coverage vs drain idempotency — two different axes.**
Idempotent apply only makes draining the buffer (frames *after* S)
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

## 4. Unsubscribe retains both watermarks

`unsubscribe(scope)` drops the desired/confirmed/recovery state **but keeps both
watermarks for the scope — `resumeFloorPositions[scope]` (the resume floor) and
`receivedPositions[scope]` (the received-water)**. The scope becomes *detached*:
no live listener, both watermarks retained so a later resubscribe (§3) can
replay anything published in the gap and gap detection continues seamlessly
across the detachment.

Deleting the resume floor on unsubscribe would leave the next `subscribe()`
nothing to resume from — it would re-baseline to head off the ack and silently
skip every frame published while no listener was attached (the **no-listener
gap**); dropping the received-water would break gap detection on the next
in-order frame. Retaining both watermarks is what closes that gap; it matters
most for views that mount and unmount frequently.

Both watermarks are retained for the **whole session** — there is deliberately no
eviction bound. The cost is a scope string + two primitives per scope, sub-MB
even at 10× the conversations a session ever opens; a stale floor self-heals on
resubscribe (resume → replay, or `snapshot_required` if the gap exceeds the
server buffer). A bounded LRU is **not admissible as a bare delete**: an evicted
scope resubscribes with no `resume`, the server has no reason to emit
`snapshot_required` (it never saw a stale position), and the `subscribed` ack
baselines to head — which silently skips any traffic during detachment, i.e.
the no-listener gap returning in LRU form. If memory ever forces a bound it
**must** carry a tombstone → forced snapshot: an evicted scope's next
subscribe must drive the `snapshot_required` refetch path rather than ack-
baseline. (That path is cheap on the renderer — `channels/hooks.ts` already
maps `snapshot_required` → `invalidateQueries`.)

### 4.1 Orphan-frame gate — the received-water advances only for desired scopes

Retaining the watermarks across unsubscribe is necessary but not sufficient. There is
a race: when a view unmounts, the client-side `unsubscribe()` removes the scope
from `desiredScopes` and detaches the bridge listener **immediately**, but the
socket stays OPEN and the server keeps fanning out events for that scope until it
processes the unsubscribe (tens of ms later). A frame landing in that window has
**no consumer to apply it**. If the client let such a frame advance the received-water
(or let a late `subscribed` ack re-baseline, or a late `snapshot_required`
refetch), the received-water would move past a frame that was never applied — and the
eventual resubscribe would resume *after* it, losing it until a manual refetch.

Concretely: a live message published shortly *before* the user switches away
(`listenerCount:1` server-side) can reach the client *after* the local listener
has detached. If `acceptEventFrame` advanced the received-water for it (and the frames
behind it) with nothing to apply them to, the switch-back resume would start
above that seq and never recover it. (A batch published *after* the server stops
fanning out replays fine — only a frame caught in the local-unmount-vs-server-stop
gap is at risk.)

The fix: `handleFrame` ignores any scope-bearing frame (`event` / `subscribed` /
`snapshot_required`) whose scope is not in `desiredScopes` — no cursor advance,
no `confirmedScopes`/baseline mutation, no `resumeFloorPositions` delete, no dispatch (it
emits an `orphan_frame` diagnostic and returns). The retained cursor therefore
stays frozen at the last seq that was applied **while the scope was desired**, so
the resubscribe's resume replays the orphaned frame. This is the invariant from
§1 stated operationally: **the cursor tracks applied-to-active-scope, not
socket-received.**

> **Two watermarks on the message-stream scope.** The orphan gate's two
> conflated jobs — wire continuity and "is this frame store-recoverable" — split
> into two watermarks:
>
> - **`received-high-water`** — advanced in `acceptEventFrame` on **every**
>   received desired-scope frame. Serves **wire continuity / forward-gap detection
>   only** (§5). It does **not** imply the content is store-recoverable.
> - **`applied-high-water`** (= the retained `resumeFloorPositions[scope]` resume floor) —
>   advanced by the ingestor's `markSatisfied(scope, seq, epoch)` **only once a
>   frame's effects reach a resume-safe satisfaction disposition** (§9: content
>   write / commit-gated derived-invalidate / warm-inactive removeQueries /
>   cold-absent vacuous). This alone is the resume floor.
>
> They coincide while a content reader applies every frame; they diverge whenever
> the scope legally receives a message frame that writes no warm content — a
> derived-invalidate-only reader (`useChannelThreads`/`useThreadFollowers`, see
> §4.2), or an off-window reply that is a semantic no-op even with ChannelView
> mounted. Gap detection reads `received`, so a stalled `applied` never raises a
> false gap; resume replays from `applied`, so a readerless/no-op frame is
> re-delivered to a later content reader (idempotent).
>
> The canonical per-kind satisfaction contract is **§9**; earlier
> content-apply-predicate / delivery-provenance / floor-pin variants are not part
> of the current model.
>
> **Read-inert + granularity unchanged.** The live-gap affordance never feeds the
> resume floor or `observe()`/`read_at`. `markSatisfied`/`applied` is
> **scope-level** (one resume floor per `conversation:<id>`); the per-target reader
> gates and the affordance are **window/key-level**. A frame may touch some open
> targets and not others; `applied` advances once the frame's per-target effects
> reach satisfaction (§9 disposition). **The per-target
> reader gates are not lifted; `markSatisfied` honors them.**
>
> The orphan-gate code is load-bearing while a view hook
> (`useConversationStream`) still registers an `onWsFrame` or writes a
> message-window cache: those lifecycle-coupled listeners are why a frame can
> arrive for a scope with no consumer, and the gate freezes the resume floor
> rather than advancing past an unapplied frame.

### 4.2 Recovery-class scope partition

`conversation:<id>` carries kinds with **heterogeneous recovery models** in one
transport seq space, and that forces a scope split. Some kinds are an *ordered
patch stream over the message-window projection* whose missed frames are **not**
reliably recovered by refetch-on-mount — resume is load-bearing.
Others are *own-cache / invalidate* projections that self-heal via their own REST
`refetchOnMount` / invalidate and need no ordered resume. A single per-scope cursor
over both classes is **impossible**: the invalidate-class frames are frequently
**readerless** (timeline closed, members panel closed), so `applied-high-water`
diverges from `received-high-water` — the cursor either freezes on every readerless
side frame (resume replays a growing tail until it overflows the 200-entry buffer)
or jumps past an unapplied `message` frame when a later side frame is treated as
progress (re-introducing that drop). The two scopes are:

- **`conversation:<id>` = message-stream** (unchanged scope name):
  `message`, `message_reaction_changed`, `task_changed`. Resume floor =
  `applied-high-water` (advanced by `markSatisfied` on satisfaction disposition,
  §9); wire continuity = `received-high-water` (§4.1).
- **`conversation-side:<id>` = side-channel** (separate scope): `agent_status`,
  `agent_activity`, `conversation_activity`, `conversation_members_changed`,
  `thread_updated` (published-but-unconsumed today — do not make any consumer
  depend on it). **Cursor-inert**: no `markSatisfied`, no resume floor, no message
  `snapshot_required` semantics.

**Kind matrix** — which scope each conversation-scope kind rides:

| kind | scope | recovery |
|---|---|---|
| `message` | message-stream | optimistic append; resume load-bearing |
| `message_reaction_changed` | message-stream | in-place aggregate patch; resume |
| `task_changed` | message-stream | in-place chip patch; resume |
| `agent_status` | side-channel | invalidate + buffer-replay |
| `agent_activity` | side-channel | own `refetchOnMount:'always'` cold-start |
| `conversation_activity` | side-channel | own REST infinite-query cold-start |
| `conversation_members_changed` | side-channel | invalidate members query |
| `agent_init_timeout` | side-channel | dev-only; invalidate/refetch-recoverable |
| `compaction_stale` | side-channel | dev-only; invalidate/refetch-recoverable |
| `agent_event` | side-channel | dev-only, **high-frequency**; own cache/refetch |

`agent_init_timeout` / `compaction_stale` / `agent_event` are side-channel
kinds, not message-stream kinds. `agent_event` in particular is
high-frequency, so keeping it off the message stream — where it would inflate the
replay buffer and the received/applied gap — is a **correctness requirement**, not
a bandwidth nicety. (Viewer-scoped kinds — `unread_updated`, `notification`,
`mention_self` — ride `viewer:<id>`, not conversation scope, and are excluded.)

**Load-bearing exception.** `useChannelThreads` and `useThreadFollowers` are
invalidate-only, but their liveness rides the message-stream `message` kind, so
they **stay subscribed to message-stream, not the side scope**. Moving them off
would leave message-stream unsubscribed when a Threads panel is the only open
reader → new replies never reach `ingestMessage → invalidateChannelThreadsList` and
the list goes silently stale. Their effect on a message frame is nonetheless a
**cursor-inert** derived-invalidate: they advance `received` but never `applied`.

**Why the partition does not restore a single cursor (option-1 exclusion).** The
off-window no-op divergence is **intrinsic to the message-stream**, not caused by
those straddle readers: even with ChannelView mounted, two consecutive off-window
replies each produce a semantic no-op, so `received`/`applied` diverge regardless
of who subscribes. Removing threads/followers cannot collapse the two watermarks —
so making message-stream a pure content-reader scope is excluded, and the
two-watermark split (§4.1) is unconditional on this scope.

**Side scope is cursor-inert but NOT mechanism-less.** `conversation-side:<id>` is
a normal transport scope: it keeps ordered fan-out, forward-gap detection, the
replay buffer, and `snapshot_required` as a delivery pipe. What it lacks is only
the `applied`/resume-floor layer — no `markSatisfied`, it feeds no message resume
floor. A side-scope `snapshot_required` drives **only each consumer's own
invalidate / REST cold-start, never a message refetch**.

**dev EventStream is observe-only.** `components/dev/EventStream.tsx` subscribes
`conversation:<id>` via `useConversationStream` but must never be a product cursor
consumer — it only dispatches, never calls `markSatisfied` or advances the resume floor
(test-asserted). This prevents a "listener present but no store apply" gray zone.

**Migration ordering.** A kind is published to its new scope and consumed there in
the **same** step — there is never a window where a widened kind set is published
to a scope whose consumer has not yet migrated (which would drop live delivery).

## 5. Live forward-gap recovery

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
it sends `snapshot_required`. This is a **re-cold-start** and it is **fully
apply-gated**: receiving the frame does not advance the resume floor.

Because the cursor is `markSatisfied`-driven, "the next event re-baselines" does
**not** hold — nothing would tell the resume floor where to land. The baseline
**must** come from the transport seq space (`EventFrame.seq` /
`SubscribedFrame.seq` / `resumeFloorPositions[scope]`), **never** `stream_head_seq` (the
REST snapshot's message-seq; the §3.1 reboot proof forbids it). The scope stays
subscribed across `snapshot_required` (no `SubscribedFrame` is re-emitted to
harvest a seq from), so the frame itself carries the baseline:

- **`SnapshotRequiredFrame` carries `{ epoch, currentSeq }`** — the server's
  current transport seq + epoch for the scope at emit time (it already holds both
  in `ws-connection.ts`). This makes the frame **isomorphic to `SubscribedFrame`
  / `EventFrame`**: all three position-bearing server frames carry `epoch` + a
  transport seq. (Forcing a redundant re-subscribe just to harvest
  `SubscribedFrame.seq` is rejected — the scope is already subscribed.)

- **Commit is apply-gated, not receipt-gated** (isomorphic to cold-start §3.1 and
  to the backfill-recovery rule §4.1 — three places, one rule). The flow:
  1. **Transport** records `pendingBaseline[scope] = { seq: currentSeq, epoch }`,
     drops the recovery latch, and **buffers** live frames `> currentSeq` for the
     scope (does not apply them — exactly cold-start buffering); dispatches the
     frame to the ingestor.
  2. **Ingestor (renderer lane)** brings every target in the scope to a
     guaranteed-recoverable state, by the **same `satisfied` taxonomy as §4.1** (no
     new rule), then signals the transport once all are satisfied:
     - **active target** (live observer, warm cache) → `reconcile*` /
       `invalidateQueries`, made **promise-returning**, background refetch, no flash
       → satisfied **on fulfilled settle** (these are the async waits, joined below);
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
     applied). This must not rest on assumption — see the guard in §8.
     **Commit signal — `allSettled`, not fail-fast.** Join the active
     reconciles with `Promise.allSettled` (or equivalent): **all fulfilled** → fire
     `commitSnapshotBaseline(scope, epoch)` once (multiple targets coalesce to one
     commit); **any rejected / cancelled / aborted** →
     **do not commit**, emit a diagnostic; the floor stays pinned and the next resume
     retries (initiated ≠ committed, carried all the way to the floor). Fail-fast
     `Promise.all` is wrong here — it would let the first rejection mask the other
     targets' outcomes.
  3. **Transport** commits on that signal: if the signalled epoch matches
     `pendingBaseline.epoch`, set `resumeFloorPositions[scope] = pendingBaseline`, clear
     pending, and drain the buffer `> seq` in transport-seq order. A stale-epoch or
     no-pending signal is discarded (a newer epoch superseded the recovery).

- **Bounded-context boundary (transport↔ingestor):** the renderer never handles a
  transport seq. Its only signal is "the snapshot content for this scope committed"
  — a content fact it owns — via a transport method (e.g.
  `commitSnapshotBaseline(scope, epoch)`); transport translates that into advancing
  the floor to the seq **it** stashed. This is the same commit-after-apply discipline
  as `markSatisfied` for content frames (§4.1).

This is exactly what releases a **real-gap floor-pin** (§4.1): when an unsatisfied
seq (a genuine gap, not a cursor-inert frame the satisfaction queue absorbs) lets
the gap grow past the replay buffer, the server emits
`snapshot_required{currentSeq}`; the apply-gated commit above advances the floor to
`currentSeq` with a **real transport seq**.

## 7. Reconnect

On a fresh socket's `authenticated` frame, `resubscribeDesiredScopes()` re-sends
`subscribe` for every desired scope and one batched `resume` carrying each
scope's retained cursor. Same invariant as §3, applied to the whole desired set
at once.

## 8. Guards (test-enforced)

Two invariants the snapshot-recovery contract (§6) rests on are locked by
`ws-client.test.ts` so they cannot drift implicitly:

- **Inactive-target recovery guard.** Every target treated as
  inactive-vacuous-satisfied at `snapshot_required` must be **proven** to
  reconstruct from authoritative REST on next mount — never to serve a
  `gcTime`-residual stale cache expecting replay-to-fill. A target that cannot
  prove it must either join the active reconcile set or be `removeQueries`-evicted
  to non-displayable; an **active** target must never be `removeQueries`-evicted
  (it would flash loading) — invalidate/refetch only, pending until commit.
- **Content-target whitelist guard** (not a scattered observer-count branch):
  every conversation-scope content target is classified as exactly one of
  `active-reconcile` (live observer → invalidate/refetch, joined) / `warm-remove`
  (warm cache, `refetchOnMount:false` primeAround — e.g. mainline
  `useChannelMessages`, `useThreadCluster` — → `removeQueries`) / `absent-vacuous`
  (no cache) / `always-refetch-safe` (`refetchOnMount:'always'` — e.g.
  `useAgentRunStates`, `useAgentActivityFeed` → mount forces authoritative REST,
  no eviction needed). A **new** content target with no declared class **fails
  the test** — recovery behavior must not drift implicitly.

## 9. Satisfaction contract — two-watermark state machine

The transport half of the two-watermark flip lives in `ws-client.ts`; the ingestor
half — `markSatisfied` call sites and `commitSnapshotBaseline` after the
`allSettled` reconcile join — is the renderer lane. The current contract (all
decisions correctness-first):

- **Two watermarks only for content-gated scopes** (`isContentGated(scope) =
  parseConversationScope(scope) !== null`, i.e. the message stream
  `conversation:<id>`). Every other scope (`viewer:` / `workspace:` / `app` /
  `conversation-side:`) has no content-apply seam, so its floor **auto-advances
  with `received`** — the single-cursor behavior for non-content-gated scopes,
  preserved bit-for-bit.
  `conversation-side:` is cursor-inert / self-healing, so it correctly falls in
  the auto-advance set.
- **No delivery-provenance classification.** `acceptEventFrame`
  is a pure seq-continuity gate returning `boolean`: `seq === received+1` →
  accept + advance received (and, for non-content-gated scopes, the auto floor);
  `seq > received+1` → forward gap → resume from the applied floor + swallow;
  `seq <= received` → duplicate re-delivery, accept without moving any water mark.
  A replay-drain frame (a forward-gap fill, a new-during-disconnect frame the
  client never received) dispatches **identically** to fresh fanout — there is no
  `live`/`backfill` tag, no `backfillThrough` replay window, and no `meta` arg on
  `onFrame`. Replay idempotency is the ingestor's job (authoritative-invalidate on
  every delivery, id-dedup rows). There is no `backfillThrough` field /
  `noteBackfillThrough` and no provenance return; the two-watermark
  accept/gap/resume logic is otherwise unchanged.
- **`markSatisfied` advance is a pending-satisfaction queue AND not a
  baseline authority.** `markSatisfied` (generalizing the former `markApplied`) is
  called by the ingestor once a frame reaches a resume-safe DISPOSITION (content
  committed OR cursor-inert and harmless to replay — see §4.1). The satisfied seq
  is recorded, then the floor drains contiguously from `floor+1` through every
  already-satisfied seq — so an out-of-order satisfy (a later frame satisfied
  while an earlier seq is still pending) is remembered and absorbed the moment the
  gap fills, and a cursor-inert frame no longer PINS the floor behind it. A
  genuinely un-satisfied seq (a real gap) still pins the floor until the covering
  `snapshot_required` commit or a replay re-satisfies it. Set-max is still
  forbidden (false-positive = a silent drop). With **no same-epoch floor** (missing /
  stale-epoch) `markSatisfied` is a **no-op + `markSatisfied_no_floor`
  diagnostic** — it must NOT establish a floor from an arbitrary satisfied seq
  (that would let the next resume start there, skipping every un-received seq
  below it — that hole re-opened). Only the `subscribed` ack and
  `commitSnapshotBaseline` may establish a floor (they reflect the server head);
  the floor self-heals when the next ack / snapshot baselines it. The pending set
  is per-scope+epoch, cleared on connection reset (replay rebuilds it), on any
  floor reposition, and on last-unsubscribe, with a bounded
  `satisfied_pending_overflow` diagnostic.
- **Satisfaction disposition — what "satisfied" means per frame kind** (the §4.1
  caller contract). The ingestor computes, per delivered
  frame, the full set of per-target effects and satisfies the seq once they all
  **commit** (`Promise.allSettled` all-fulfilled), never on dispatch:
  - *content write* (mainline append, cluster append) → satisfied after the
    `setQueryData`/reconcile writes;
  - *derived-invalidate* (reply-count on mainline + thread-root) → satisfied only
    after the invalidate's refetch **commits** (a rejected refetch pins the floor
    — commit-gated, not dispatch-gated);
  - *warm-inactive target* (warm cache, no observer) → `removeQueries` then
    satisfied (next open cold-starts authoritatively);
  - *cold-absent* (no cache, no observer) → satisfied **vacuously** (cold-start is
    authoritative on next open; advancing past it can't strand a warm displayable
    cache);
  - *side-scope frames* → never `markSatisfied` (the side floor auto-advances).
  **Named exception — the hybrid gate.** `task_changed`
  and `reaction` keep the **synchronous boolean** content-apply gate rather than
  the async `allSettled` path, because they are pure idempotent patches (task sets
  fields; reaction sets the absolute count). The criterion that governs whether an
  effect joins the gated `allSettled` set is: **an effect is gated iff resume
  correctness depends on its settle — i.e. it accumulates resume-replay-dependent
  persistent state — NOT merely "it calls invalidate".** Reaction's cursor-inert
  sub-effect `reactors_list_refresh` (the who-reacted popover) is
  *authoritative-on-open* (a fresh REST fetch on hover) and accumulates **zero**
  ingestor state, so it is **not** gated — advancing the floor past a reaction
  frame strands nothing. Falsifier (test-locked): the ingestor must leave
  `messageReactorsKey` untouched (`undefined`) after a reaction frame. This guards
  against a future "unify everything onto the satisfaction path" refactor
  wrongly pulling authoritative-on-open effects into the gate.
- **`snapshot_required` re-cold-start is fully apply-gated** (pendingBaseline +
  buffer `> currentSeq` + `commitSnapshotBaseline(scope, epoch)`, epoch-checked,
  drains post-commit). **Cold-start (first subscribe) is NOT pendingBaseline-gated
  in v1** — the `subscribed` ack baselines both water marks immediately. This is
  safe because the REST snapshot is the authoritative pre-S coverage (§3.1): a
  resume-from-S that "skips" transport seqs `1..S` loses nothing, since the
  snapshot already reflects them. The live-vs-REST *ordering* at cold-start is the
  ingestor's concern (React Query), not a resume-floor correctness one.
- **Orphan-frame gate retained** (§4.1). It is complementary to the applied floor
  (pre-filters non-desired scopes before any water-mark/dispatch touch) and is
  load-bearing while `useConversationStream` still registers an `onWsFrame`.
- **Known v1 cost:** a snapshot reconcile that never commits (persistently
  rejected refetch) keeps `pendingBaseline` + buffer for the connection's
  lifetime (floor pinned, frames buffered). It self-heals on the next reconnect
  (`clearConnectionState` drops pending/buffer; resubscribe re-arms via a fresh
  `snapshot_required`). Matches §6 "floor stays pinned and the next resume
  retries."

