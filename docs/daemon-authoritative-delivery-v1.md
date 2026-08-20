# Daemon-authoritative message delivery

This document owns the daemon-authoritative
delivery boundary and its failure semantics.

## 1. Problem this fixes at the root

Backend decides *how* to deliver an inbox row (spawn vs wake vs defer) by reading
its own `RunStateCache` — a projection of daemon state that can desync from
reality. When it desyncs (entry absent / not `ready`) for a runtime that is in
fact alive, backend routes to `runtime_start`; the daemon idempotently answers
"handle already alive, I won't consume a startup_delivery" and a backend that
routes this way orphans the row.

The bug class is structural: **backend is guessing runtime-lifecycle truth that
only the daemon owns.** The fix is to stop guessing — hand the daemon the
*delivery intent* and let it act on the real handle state.

Falsifier for "this is the right root cause": if after this change any
`(conversation, agent)` with a live daemon handle + a desynced backend cache +
a pending row can still orphan that row, the model is wrong.

## 2. Responsibility boundary (ubiquitous split — do not blur)

| Concern | Owner | Notes |
| --- | --- | --- |
| Durable inbox: claim, ordering, dedupe (`delivery_id`), `delivered_at` | **backend / DB** | daemon never touches the DB. |
| User-message create stale/conflict (HTTP) | **backend** | pre-delivery layer, untouched by this work. |
| Runtime lifecycle truth (spawning/startup_pending/ready/draining/exited) | **daemon** | single authority. |
| Delivery *action* (spawn-with-batch / write stdin / enqueue mid-turn / refuse) | **daemon** | decided from real handle state. |
| Safe-boundary gating (hold gated-driver bytes until `turn_end`) | **daemon** | daemon holds the mid-turn batch and self-flushes at `turn_end` (§11). |
| `RunStateCache` | **backend** | demoted to UI projection + *optional* routing hint. **Never** the delivery-decision authority. |

The load-bearing invariant: **"sent to daemon" ≠ ack.** DB
`delivered_at` is written **only** on an explicit daemon *consumed* signal, never
on "command accepted". A daemon crash/disconnect with bytes still in its volatile
queue must leave the DB row pending/in-flight and recoverable.

## 10. The unified `runtime_deliver` command

Three tightenings hold: `deferred` custody is taken narrowly (see §11.2, not by
the command-unification layer itself); the synchronous disposition NEVER acks the
DB; the ack-timeout covers only real custody states. **`runtime_deliver` unifies
the start/wake *command*, not queue *custody*.**

### 10.1 Ownership split (the load-bearing line)

- **The daemon does lifecycle-authoritative routing + mechanical delivery**, and
  (per §11) owns the gated mid-turn hold: it holds the batch and self-flushes at
  its own `turn_end`.
- **The backend `RuntimeDeliveryCoordinator` is reduced to claim / submit /
  projection** — it never decides a delivery action and never holds a mid-turn
  queue (§11.8).

### 10.2 Command: `runtime_deliver` (replaces the backend start/wake surface)

```
runtime_deliver {
  conversation_id, agent_id,
  delivery_ids[], deliveries[], text,   // #task:2106: `deliveries[]` REQUIRED (non-empty);
                                        // the wire scalar `delivered_up_to_seq` is REMOVED —
                                        // the daemon derives the disk sidecar from max(deliveries[].seq).
  spawn_options,            // consulted ONLY if the daemon must spawn
}
```

Backend claims the batch in-flight (`owner=connectionId`) before sending, exactly
as `startDeliveryBacked` does. `runtime_wake` is **removed entirely** from
the backend command surface (all ready-state message delivery goes through
`runtime_deliver`). `runtime_start` is **narrowed, not removed** — see §10.2.1.

#### 10.2.1 `runtime_start` narrows to a pure lifecycle command

`runtime_start` is NOT delivery-only: `startDirect` uses it for an explicit
message-less spawn (start button / provision), and `runtime_deliver.delivery_ids`
is `min(1)` so it cannot carry an empty start. So the two commands split cleanly
onto orthogonal planes:

- **`runtime_start` = lifecycle plane.** "Ensure a runtime handle exists for
  (conv, agent)." Carries NO inbox row and NO delivery semantics. Its wire shape:
  - `RuntimeStartParams = { conversation_id, agent_id, options }` — no
    `startup_delivery` block.
  - `RuntimeStartResult = { started:true, pid, started_at } | { started:false,
    reason:'init_cooldown', cooldown_until }` — no `startup_delivery_accepted`
    and no `phase` field (below).
  - Success means only "daemon has/created the handle" — it does **not** promise
    ready, deliverable, or safe-boundary. Deliverability is expressed only by a
    `runtime_deliver` disposition + consumed/failed events; state observation is
    only via `runtime_status` / `runtime_state`. lifecycle plane ⊥ delivery plane.
- **`runtime_deliver` = delivery plane.** The sole message-delivery command;
  spawns-with-batch when no handle exists (the `spawning` disposition).

Both commands share the daemon's internal spawn machinery (one path with a
startup batch, one without) — that is implementation, not a second backend
delivery surface. **`RuntimeStartResult` carries no `phase` field**: a `phase`
would be a zero-consumer wire field once delivery-on-start is gone, and would
become a *third* state-query surface that drifts from
`runtime_status`/`runtime_state`.

### 10.3 Synchronous disposition — transfers or refuses custody, never acks

| Real handle state | Daemon action | Disposition | DB effect |
| --- | --- | --- | --- |
| no handle / exited | spawn; this batch = startup delivery | `spawning` | stays in-flight (owner=conn) |
| ready | encode + write stdin | `admitted` | stays in-flight (owner=conn) |
| live oneShot (can't take stdin) | **refuse** (drains only at spawn time) | `refused{reason: startup_pending}` | rollback to pending; drains on exit→respawn-with-batch |
| spawning / startup_pending | **refuse** (no 2nd custody) | `refused{reason: startup_pending}` | backend rolls back to pending; resubmit on `ready_for_drain` |
| draining | refuse | `refused{reason: draining}` | rollback to pending; recovered on exit→respawn |
| init cooldown | refuse | `refused{reason: cooldown, cooldown_until}` | rollback to pending; respect backoff |

- The base disposition set is **`spawning | admitted | refused`**; §11 adds
  `deferred` for the daemon-side gated mid-turn queue.
- `spawning` custody is the **existing** startup-delivery mechanism (not a new
  queue): the daemon already holds a spawn's startup batch until init proof.
- The disposition is a **custody signal, not an ack.** It never touches
  `delivered_at`.

### 10.4 Ack model — `delivered_at` moves only on async events

- `runtime_delivery_consumed { delivery_ids }` → backend `markDelivered`. Sources:
  (a) startup-delivery consumed via init proof (`session_init` for
  `requires_first_message`, preserving the B3 gate; write success for
  `self_inits`); (b) ready-write success on the `admitted` path.
- `runtime_delivery_failed { delivery_ids, reason }` → rollback to pending
  (retriable) or mark failed (fatal, e.g. `driver_refused` programming error).
- The `runtime_delivery_consumed`/`_failed` family is the single delivery-ack
  surface, keyed by `delivery_ids`, regardless of spawn-vs-write. **The
  at-least-once tradeoff**: a disconnect between a successful write and its
  consumed event redrives the row (duplicate, never loss) — the same window the
  async ack path accepts.

### 10.5 Crash / disconnect / in-flight

- `spawning`/`admitted` rows stay `in_flight owner=connectionId`; only `consumed`
  flips them. `refused` rolls back to pending immediately.
- Disconnect → `rollbackInFlightForOwner` → pending. Reconnect + `runtime_status`
  hydrate resubmits pending for handles the snapshot reports alive (live-delivery-only
  re-drive; **never** batch-spawn DB backlog — the cold-hydrate invariant holds).
- `ready_for_drain` is a backend-driven replay nudge (it re-submits the rows
  refused with `startup_pending`, and post-reconnect pending). The daemon-owned
  gated mid-turn queue is separate (§11).

### 10.6 ack-timeout (narrow)

Implement only the two custody states of this layer: reuse the init watchdog / B3
proof for `spawning`; a short bug-catcher guard for `admitted`. No global constant
for the mid-turn queue (§11.7 rejects a wall-clock turn timer entirely).

### 10.7 Behavioral invariants

The daemon owns the **`delivered_at` proof** and the **B3 init-gate**: it emits
`runtime_delivery_consumed` on the proof point (write success for `self_inits`;
`session_init` for `requires_first_message` spawn). A ready handle on the
`admitted` path is already inited, so its consumed = write success. The backend
never writes `delivered_at` synchronously.

Behavioral rules:

- Explicit `start()` does a **message-less** `runtime_start` only — it must NOT
  route through `startDeliveryBacked` or opportunistically drain pending. Pending
  rows are (re)submitted as `runtime_deliver` by the spawn's `ready_for_drain` /
  pending replay, never smuggled through `start`.
- **respawn split**: a respawn *with* pending rows goes through
  `runtime_deliver`'s spawn-with-batch; a truly empty start goes through
  `runtime_start`. "respawn-to-empty" must never become an implicit delivery.

**Three hard "no residue" invariants:** no `runtime_start` carrying a message, no
`runtime_wake` delivering a message, no synchronous result writing `delivered_at`.

## 11. The daemon-side gated queue

§11 is the authoritative spec of the daemon-side queue sink (§11.8).

### 11.0 The decisive as-built fact

**The daemon already maintains the identical busy tracker.** `handle.busy =
{ outstandingToolUses, compacting }` (`packages/host/src/daemon/supervisor/handle.ts`)
is updated in `updateRunStateFromParsed` with byte-for-byte the same transitions
the backend coordinator applies in `onParsedEvent` (`tool_call +1`,
`tool_output −1` clamped, `turn_end → 0`, `compaction_started/finished`). The
daemon also owns `handle.driver` with the full classification surface
(`releaseProfile`（#task:1558 起取代三值 `busyDeliveryMode`，见
[`runtime-input-design.md`](./runtime-input-design.md) §3.2）, `oneShot`, `kickoffMode`,
`readyToEncode()`), and already flushes startup batches through
`consumeStartupDelivery` (encode → write stdin → emit `runtime_delivery_consumed`,
deferring the ack to `session_init` for `requires_first_message`).

So the daemon does **not** *move* the busy tracker — it **collapses a duplicate**.
The coordinator's `busy` tracking, `isSafeBoundary`, `enqueue`/`flush`, and
`combineText`/`combineGated` become the daemon's, sitting on top of state the
daemon already computes on every parsed event. This is why the daemon is the
correct home: it is the one process that both *sees* `turn_end` and *acts* on it,
with zero round-trip.

### 11.1 The one delivery case the daemon queue owns

Only **ready-handle-mid-turn-gated** delivery is owned by the daemon-side queue;
every other case is handled by the base disposition arms:

| Case | Behavior |
| --- | --- |
| ready + safe boundary (or `direct` driver) | `admitted`, write now |
| **ready + mid-turn (`gated`)** | **daemon** holds it → `deferred`, daemon flushes at its own `turn_end` |
| no handle / exited | `spawning` (spawn-with-batch) |
| spawning / startup_pending / not-ready-to-encode / live oneShot | `refused{startup_pending}` → backend durable-pending → `ready_for_drain` replay (§11.2 — deliberately NOT folded into `deferred`) |
| draining / cooldown | `refused{draining\|cooldown}` |

### 11.2 `deferred` scope — the load-bearing rule

`deferred` custody is taken **only** when there is no lossless DB-backed re-drive
already available:

- **Daemon volatile custody is a liability** (lost on crash). Take it only when
  necessary.
- **Startup-phase deliveries already have a lossless path**: refuse →
  durable-`pending` → `runtime_ready_for_drain` fires once the handle becomes
  ready + its startup batch is consumed → backend replays. The DB is the queue;
  nothing to lose. Giving the daemon a second batch chained behind init would add
  volatile custody for **zero** benefit and strictly worse crash-safety.
- **Ready-mid-turn is the *only* case with no repeatable DB-backed re-drive**:
  `ready_for_drain` latches once (`readyForDrainEmitted`), a live-arrival re-drive
  needs a *new* message, and nothing else signals "the turn just ended, re-drive
  pending." The turn-end signal lives *only* in the daemon. Therefore the daemon
  must hold this batch and self-flush at `turn_end`.

**Rule: `deferred` ⇔ a ready, encode-ready, inited handle that cannot take the
write *right now* — because it is mid-turn (gated) or a prior write is still
in flight (§11.4 collision).** Nothing startup-phase ever becomes `deferred`.
This is minimal-custody: no backend second queue, DB spine, least volatile
custody.

If replay re-submits a startup-refused row and by then the handle is ready but
mid-turn, *that* deliver flows into the `deferred` path — the two compose
cleanly, no row is stranded.

### 11.3 Daemon admission logic (unified)

For a batch arriving at `deliver()` on a **ready, encode-ready, inited** handle,
let `boundaryOpen = outstandingToolUses === 0 && !compacting` and
`writeInFlight = handle.startupDelivery !== null` (a batch already being
consumed):

```
direct driver:  writeInFlight ? enqueue → deferred : write → admitted
gated  driver:  (boundaryOpen && !writeInFlight) ? write → admitted
                                                  : enqueue → deferred
```

All not-ready/lifecycle states (spawning, startup_pending, not-ready-to-encode,
draining, cooldown, live oneShot) keep their base `spawning`/`refused` arms
verbatim. `deferred` is a **custody signal, not an ack** — it never touches
`delivered_at`; the row stays `in_flight owner=connectionId`, identical to
`admitted`/`spawning`.

### 11.4 The daemon deferred queue

- **Shape.** A new per-handle `deferredQueue: DeferredEntry[]` (distinct from the
  single `startupDelivery` slot), each entry carrying `{ deliveryIds, deliveries,
  text, owner }` — the batch payload the WRITE arm places on `startupDelivery`,
  **plus a delivery-owner token** (§11.4.1). `deliveries` is required and non-empty
  (#task:2106); the disk sidecar high-water is derived `max(deliveries[].seq)`, not
  carried as a separate scalar. Dedup by delivery-id set (idempotent re-submit),
  mirroring the coordinator's `dedupKey`.
- **Flush triggers (two, both re-check `boundaryOpen`):**
  1. **Turn-end / boundary reopen.** In `updateRunStateFromParsed`, after the
     `turn_end`/`tool_output`/`compaction_finished` transition recomputes the
     boundary, if `deferredQueue` is non-empty and the boundary just reopened,
     schedule `void flushDeferred(handle)`. Symmetric to the coordinator's
     `if (!wasSafe && nowSafe && pending.length) flush()`.
  2. **Post-write re-drive.** When a write settles (`consumeStartupDelivery`
     clears `startupDelivery` and emits `consumed`/`failed`), if `deferredQueue`
     is non-empty and admissible, flush again. This closes the *consecutive-
     delivery window*: a second `deliver` landing during a
     write-in-flight is enqueued (`deferred`), not refused, and re-driven after
     the in-flight write consumes.
- **Flush mechanics — split by driver mode.** `flushDeferred` runs
  under `withLifecycleLock` (so it can't race a concurrent `deliver`/`stop`/exit),
  re-checks the boundary, and dispatches through the WRITE-arm path
  (`startupDelivery` slot → `consumeStartupDelivery`), but drains differently:
  - **`gated`:** drain the **whole** queue at boundary reopen, **combine** all
    entries' texts (§11.9) into **one** write → **one** `consumed` covering every
    delivery_id. Preserves the existing one-turn-per-safe-boundary semantics.
  - **`direct`:** flush **one** entry **FIFO**, and re-drive the next only after
    the current write's `consumed` clears the `startupDelivery` slot. **No
    combine.** A direct entry is queued *solely* because the single
    `startupDelivery` slot is busy (write-in-flight serialization), never because
    the messages should merge — combining independent direct deliveries into one
    turn would change delivery semantics. FIFO-one-at-a-time solves only the
    serialization.

  A ready+inited handle at a safe boundary encodes and writes immediately,
  emitting `consumed` on write success (`requires_first_message` is already
  inited here, so no init-defer). A `flushing` re-entrancy guard prevents a
  double `turn_end → tool_output` cascade from racing.

#### 11.4.1 Delivery-owner token + owner-context API — the load-bearing half of crash-safety

Deferred custody is **not** safe without an explicit owner. If the daemon holds a
`deferredQueue` and the backend connection drops, the backend has already
`rollbackInFlightForOwner`'d those rows to `pending`; a daemon that later flushes
them **double-delivers**. A daemon that instead blindly clears *all* queues would
discard custody belonging to other connections (multi-connection embedded, future
local helpers). So the owner must be explicit and cleanup owner-scoped — and
because owner injection is **not** an existing seam, it is written here as an
enumerated API change so no transport is missed:

- **Daemon-internal delivery context.** `DeliveryOwnerContext { owner: string }`
  — daemon-internal only, **never** added to `RuntimeDeliverParamsSchema` (the
  wire schema stays owner-free; a self-declared owner is spoofable).
- **`SupervisorContract.deliver` grows a context arg** —
  `deliver(params: RuntimeDeliverParams, ctx: DeliveryOwnerContext)`.
  `Supervisor.deliver` stamps each `deferredQueue` entry with `ctx.owner` and
  **never mints or guesses** it. `deliver` is the only contract method that takes
  `ctx` (the others are custody-free). Add a sibling contract method
  `cleanupDeferredForOwner(owner: string): void` — owner-scoped discard that
  **emits nothing**.
- **Both dispatch seams thread the context (not the wire):**
  - `IntentDispatcher.dispatch(requestId, intent, rawParams)` →
    `dispatch(requestId, intent, rawParams, ctx)` — the local control-socket path.
  - `OutboundCommandDispatcher = (command) => Promise<…>` →
    `(command, ctx) => Promise<…>` — the embedded + standalone frame path.
- **Three ingresses each mint an owner and wire close → cleanup:**
  - `DaemonServer` (local control Unix socket, `handleConnection(socket)`):
    per-socket owner; socket `close` → `cleanupDeferredForOwner(owner)`.
  - `LocalOutboundFrameServer` (embedded): per-socket owner passed through
    `dispatchCommand(command, ctx)`; socket close → cleanup.
  - `OutboundDaemonClient` (standalone WS): owner **per active WS generation** —
    a fresh owner each `ws.on('open')`; `ws.on('close')` / reconnect / stop →
    cleanup for that generation's owner. Minting fresh on reconnect guarantees a
    stale generation's late flush can never be attributed to the new connection.
- **Tests are wiring-level, not just unit:** owner A's drop clears only A's
  deferred (a co-resident owner B survives); **plus** at least one owner-cleanup
  wiring test on *each* transport (local control socket + outbound frame path), so
  a future ingress that forgets the close hook fails a test rather than silently
  leaking custody.

This makes owner-scoped cleanup a **verifiable contract**, not a prose promise.

### 11.5 Ack model — unchanged

`delivered_at` still moves **only** on async `runtime_delivery_consumed`, and rolls
back on `runtime_delivery_failed` / disconnect. `deferred` joins `admitted`/
`spawning` as an in-flight-retaining, non-acking custody transfer. No new event
family; the deferred flush emits the same unified `runtime_delivery_consumed`
keyed by `delivery_ids`.

### 11.6 Crash / disconnect / runtime-exit

- **Runtime exit while queued** → daemon emits `runtime_delivery_failed
  { delivery_ids, reason: 'child_exit' }` for every `deferredQueue` entry (as
  `consumeStartupDelivery` already does for the in-flight batch) → backend rolls
  the rows back to `pending` → oneShot respawn-with-batch or `ready_for_drain`
  replay re-drives. **No orphan.**
- **Backend-connection disconnect** → **owner-scoped discard (§11.4.1)**: the
  daemon drops only the deferred entries owned by the dropped connection via
  `cleanupDeferredForOwner`, emitting no `consumed`/`failed`. Because nothing was
  written yet, this is *duplicate-free* — cleaner than the `admitted` window. The
  backend's existing `rollbackInFlightForOwner(connectionId)` returns that owner's
  DB rows to `pending`; on reconnect + `runtime_status` hydrate the backend replays
  pending for handles reported alive (live-delivery-only re-drive; never batch-spawn the
  backlog — the cold-hydrate invariant holds). The dispatcher per-connection close
  hook that drives this is a **required deliverable**, not a deferred integration
  point.
- **Daemon volatile queue is bounded and non-durable by contract.** Losing it is
  safe precisely because the DB row was never acked.

### 11.7 Timeout / lease

The custody-loss guard is **event-driven, not wall-clock** — which is exactly
what "protect against lost custody without misfiring on long turns" demands:

- **Dead daemon / dropped transport** → disconnect → immediate rollback (§11.6).
- **Dead runtime** → `runtime_exit` → immediate `failed` (§11.6).

Both are zero-false-positive on a long, healthy turn. A wall-clock "turn too long"
timer is **rejected** — it cannot be sized (no magic constant). The one residual
case — daemon alive, transport alive, but the turn **never** ends (a wedged
runtime that emits no `turn_end`) — is **not** a delivery custody bug; it is the
bad-model observability hold (a wedged runtime must surface an error +
`turn_end`), tracked separately. This model adds **no** timer of any kind: no
turn-length timeout **and no idle-output watchdog** — an idle-output watchdog
degrades into an implicit turn timeout and is not built absent a measured case
that proves it necessary. Custody loss is disconnect + `runtime_exit`, full stop.

### 11.8 Backend `RuntimeDeliveryCoordinator`

Reduced to **claim / submit / projection** — no second queue, no
busy tracking:

- **Not present:** `BusyState` + `isSafeBoundary`; `PerAgentState.{busy,pending,
  flushing}`; `enqueue`/`flush`/`combineText`; the busy-transition half of
  `onParsedEvent`; the `combineGated` callback.
- **Present (all submit/projection, not custody):** the claim-then-`runtime_deliver`
  submit path (`submitLiveDeliveryBatch` now *always* dispatches — the daemon
  decides `admitted`/`deferred`/`refused`, backend never gates on busy);
  `ready_for_drain` replay (`submitReadyForDrainDeliveryBatch`); the oneShot
  respawn-**submit** on `runtime_exit` (a DB-pending check + resubmit, not a
  queue); disconnect rollback (`rollbackInFlightForOwner`, backend/DB); the
  delivery-stuck **UI** watchdog (synthetic "thinking" bubble — pure projection,
  armed on `admitted`/`spawning`, cleared on first parsed event).
- Backend treats a `deferred` disposition like `admitted` for CUSTODY — rows
  stay in-flight, no ack (`delivered_at` moves only on `runtime_delivery_consumed`)
  — but it does **NOT** arm the delivery-stuck UI watchdog for `deferred`. The
  stdin write is deferred to the daemon's flush, which the backend cannot time,
  so a watchdog armed now would fire spuriously during a legitimate long turn;
  stuck-turn observability for deferred writes is the daemon's (custody-loss =
  disconnect + `runtime_exit`).

The coordinator is a slimmed submit/projection class (it
is not dissolved into the fanout); the invariant it upholds is that no delivery
*decision* remains backend-side.

### 11.9 `combineGatedBatch` lives in `host` (bounded context)

The gated-text combine (`packages/host/src/daemon/supervisor/gated-combine.ts`)
runs daemon-side at flush. It is runtime/driver-layer text assembly, so it lives
in `packages/host` — `host` owns runtime, and the daemon is the one combining
deliveries before encode. The backend does not perform this assembly.

### 11.10 Wire + versions

- `RuntimeDeliverResultSchema` carries a `deferred` arm: `{ disposition:
  'deferred', pid, started_at }` (custody-on-daemon; backend keeps rows
  in-flight).
- `refused` reasons are `startup_pending`/`draining`/`cooldown` (used by the
  startup-phase arms).
- No new async events (`consumed`/`failed` already unified).
- Wire-version handling is fail-loud, **no shim** (standalone daemon
  unreleased, embedded is version-matched in-build).
