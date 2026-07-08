# Daemon-authoritative message delivery (v1, #task:1417)

Status: **shipped (all stages), review-clean, in_review.** Owner: Alice. Review:
Cindy (review-clean). Approved direction by shiki (thread
#conv:FPx_VgJiuxhDKtya). Stages 1 / 2 / 2c / 3a / 3b landed locally
(`f9cc380` → `106a3d3` → `903dfee`, plus earlier stage commits); awaiting shiki
validation + push. This doc remains the authoritative spec of the shipped
design.

## 1. Problem this fixes at the root

Backend decides *how* to deliver an inbox row (spawn vs wake vs defer) by reading
its own `RunStateCache` — a projection of daemon state that can desync from
reality. When it desyncs (entry absent / not `ready`) for a runtime that is in
fact alive, backend routes to `runtime_start`; the daemon idempotently answers
"handle already alive, I won't consume a startup_delivery" and the old backend
orphaned the row (#task:1416, now bounded-fixed with a tactical cache heal).

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
| Safe-boundary gating (hold gated-driver bytes until `turn_end`) | **daemon (target)** / backend (today) | see §7 staging — moves last. |
| `RunStateCache` | **backend** | demoted to UI projection + *optional* routing hint. **Never** the delivery-decision authority. |

The load-bearing invariant shiki set: **"sent to daemon" ≠ ack.** DB
`delivered_at` is written **only** on an explicit daemon *consumed* signal, never
on "command accepted". A daemon crash/disconnect with bytes still in its volatile
queue must leave the DB row pending/in-flight and recoverable.

## 3. Target command: `runtime_deliver`

> **§3–§5 describe the end-state model (after Stage 3).** They include daemon
> `deferred` custody and the long mid-turn ack-timeout, which Stage 2 does **not**
> ship. For what Stage 2 actually builds — `deferred` not introduced, the daemon
> holds no mid-turn queue, timeout only over `spawning`/`admitted` — read §10,
> which is authoritative for Stage 2 and overrides any end-state detail here.

One command subsumes the start-vs-wake fork. Backend claims the pending batch
(in-flight, `owner=connectionId`), then:

```
runtime_deliver {
  conversation_id, agent_id,
  delivery_ids[], delivered_up_to_seq, deliveries[], text,
  spawn_options,           // used ONLY if the daemon must spawn
}
```

Daemon inspects the real handle and picks the action — backend prescribes none:

| Real handle state | Daemon action | Synchronous disposition |
| --- | --- | --- |
| not_running / exited | spawn; this batch = startup delivery | `spawning` |
| spawning / startup_pending | enqueue behind init | `deferred` |
| ready + safe boundary (or `direct` driver) | encode + write stdin now | `admitted` |
| ready + mid-turn (`gated` driver) | enqueue in volatile queue, flush at `turn_end` | `deferred` |
| draining | refuse | `refused` (reason=`draining`) |
| init cooldown | refuse | `refused` (reason=`cooldown`) |

## 4. Ack model — disposition vs consumed (Cindy pts 1 & 2)

**Synchronous disposition** = "what the daemon decided to do with the intent." It
transfers *ownership*, it does **not** ack the DB:

- `admitted` — daemon took the bytes toward stdin. DB stays **in-flight** (owner=conn). Not acked.
- `deferred` — daemon queued it (init or mid-turn). DB stays **in-flight**. Not acked.
- `spawning` — daemon spawned with this as the startup batch. DB stays **in-flight**. Not acked.
- `refused` — daemon cannot take it now. Backend **rolls back to pending** immediately (retriable).

**Asynchronous events** are the *only* things that move `delivered_at`:

- `runtime_delivery_consumed { delivery_ids }` → backend `markDelivered`. Emitted when the bytes are *proven* delivered:
  - `self_inits` drivers (codex/cursor/opencode): on successful stdin/ACP write.
  - `requires_first_message` drivers (claude): after `session_init` proves consumption (preserves today's B3 init-ack gate).
- `runtime_delivery_failed { delivery_ids, reason }` → backend rolls back to pending (retriable) or marks failed (fatal, e.g. `driver_refused` programming error).
- daemon disconnect → backend rolls back all in-flight rows owned by that connection to pending (existing `rollbackInFlightForOwner`).

This collapses today's `runtime_startup_delivery_consumed/_failed` + the
`runtime_wake` `{delivered:true}` reply + the requires_first_message deferred ack
into **one** consumed/failed event family, keyed by `delivery_ids`, regardless of
whether the delivery was via spawn, live delivery/ready write, or queued flush.

## 5. Crash / disconnect / in-flight / watchdog (Cindy pt 3)

- **In-flight ownership stays the crash-safety spine.** A row admitted/deferred by
  the daemon is `in_flight owner=connectionId` in the DB, **not** `delivered`.
  Only a `consumed` event flips it.
- **Disconnect while queued** → backend rolls owner's in-flight rows back to
  pending. On reconnect + `runtime_status` hydrate, backend resubmits pending for
  handles the snapshot reports alive (live-delivery-only re-drive; never batch-spawn DB
  backlog — the existing cold-hydrate invariant is preserved).
- **Watchdog/timeout.** Each `runtime_deliver` carries a bounded ack timeout. If
  no `consumed`/`failed` arrives before the deadline (daemon wedged mid-turn far
  too long, or lost the event), backend rolls the in-flight rows back to pending
  and lets the next lifecycle nudge re-drive. The timeout must be > the longest
  legitimate mid-turn hold; this is the one genuinely new tuning knob and needs
  empirical calibration (open item §9).
- **Daemon volatile queue is bounded and non-durable by contract.** Losing it on
  crash is *expected and safe* precisely because the DB row was never acked.

## 6. What `RunStateCache` becomes

Pure UI projection + a replay trigger — **never a delivery-action selector.**
Once Stage 2 retires the backend `runtime_wake` command surface there is no
"cache says ready → try wake first" path: every delivery goes through
`runtime_deliver`, and the daemon's authoritative handle state (not the cache)
picks spawn-vs-write-vs-refuse. The cache may still drive projection (renderer
run-state) and the `ready_for_drain` replay nudge, but it never decides a
delivery action. The #task:1416 tactical "heal cache to ready" bridge was
**deleted** in Stage 1.

## 7. Migration & retirement map (Cindy pt 4) + staging

Staged so DB-ack, safe-boundary, and start/wake are **never** changed in one
commit.

- **Stage 0 — done.** #task:1416 bounded bugfix (`156b478` + `9843438`). Stops
  the bleed. No architecture change.
- **Stage 1 — daemon-authoritative start-vs-wake, queue stays in backend. DONE
  (mechanism SUPERSEDED by Stage 2 — see below).**
  `runtime_start`'s idempotent reply now carries the handle's authoritative
  `phase` (required on the `started:true` arm); backend routes off the daemon's
  reply instead of the desyncable cache, and the #task:1416 blind cache-heal
  bridge is **deleted**. On a `started:true && startup_delivery_accepted !== true`
  reply (idempotent start that refused to consume the startup batch): roll the
  claimed rows back to pending, reconcile the projection with `result.phase`, then
  route by an **exhaustive** switch — `ready` → reroute to `runtime_wake`;
  `spawning`/`startup_pending` → keep pending (drains on `runtime_ready_for_drain`);
  `draining` → keep pending (recovered on exit→respawn); `idle`/`exited` →
  `logger.warn` invariant breach, rows kept pending; a new phase forces a
  compile error via `const _exhaustive: never = result.phase`. DB/ack semantics
  unchanged.

  > **SUPERSEDED-BY-STAGE-2.** Stage 1's `phase` on `RuntimeStartResult` and the
  > `startup_delivery`-on-start mechanism were a de-risking stepping stone, **not**
  > the end-state contract. Stage 2 removes delivery from `runtime_start` entirely
  > (§10.2.1): `phase`, `startup_delivery`, and `startup_delivery_accepted` are all
  > deleted in 2b, and the phase-switch reroute above is retired. Do not treat the
  > required `phase` as the final `runtime_start` contract.

  **Protocol version bump — fail-loud hygiene, not a migration.** `phase` is
  required (not optional), so a version-mismatched daemon must fail loud at
  hello/attach rather than send phase-less replies mid-command. Both wire
  versions bump: `HOST_PROTOCOL_VERSION 3 → 4` (local socket) and
  `OUTBOUND_PROTOCOL_VERSION 2 → 3` (standalone WS). There is **no external
  migration burden**: the embedded daemon ships in the same app build (always
  version-matched), and the standalone/outbound daemon is not yet released (zero
  deployed users). The bump exists only to catch dev-time / future-deployment
  version skew — not to migrate any existing external caller. A missing or unknown
  `phase` is rejected at the zod/type layer (no runtime fallback). This stage also
  converged the daemon-instance-key double-format smell (§9.2, precursor
  `ac0cf38` + `2e99aa6`).
- **Stage 2 — single `runtime_deliver` command (spec: §10).** Daemon owns
  spawn/write/refuse routing; the safe-boundary defer stays in the backend
  coordinator until Stage 3 (no daemon mid-turn queue, no `deferred`
  disposition). Backend submits and acks only on `runtime_delivery_consumed`.
  Retire backend's start-vs-wake branching in
  `deliverMessage`/`startDeliveryBacked` and the cache-as-delivery-selector.
  `runtime_start`/`runtime_wake` are removed from the backend command surface
  (the daemon may reuse them internally — implementation, not protocol).
- **Stage 3 — move the safe-boundary gated queue into the daemon.** Daemon is
  closest to parsed events / driver state, so it owns the hold-until-`turn_end`
  buffer. Retire backend `RuntimeDeliveryCoordinator`'s enqueue/flush. **Strict
  consumed=ack**: DB stays pending/in-flight until the daemon flushes and emits
  `consumed`. This stage has the subtlest crash-safety invariants and gets its
  own verification bar before merge.

Retirement once all stages land: `runtime_startup_delivery_consumed/_failed`
(→ unified `runtime_delivery_consumed/_failed`); `runtime_ready_for_drain` as a
*backend-driven replay trigger* (daemon owns its queue; a lightweight
"deliverable now, resubmit pending" nudge remains for post-refuse/reconnect
resubmission); backend start-vs-wake fork; cache-as-authority.

## 8. Test matrix (Cindy pt 5) — invariants, not opencode specials

Every case asserts: **no orphaned pending row; delivery failure keeps the row
pending & retriable; consumed=ack; no double-ack on replay.**

1. ready live + safe boundary → admitted → consumed → acked.
2. ready live + mid-turn gated → deferred → flush at `turn_end` → consumed.
3. startup_pending → deferred → consumed after init.
4. draining → refused → pending → recovered on exit→respawn.
5. not_running / exited → spawning → consumed at init settle.
6. **daemon disconnect while queued** → rollback to pending → resubmit, no dup, no loss.
7. driver refused (programming error) → failed(fatal) → surfaced, not silently acked.
8. `requires_first_message` init-ack gate → consumed only after `session_init`.
9. ack-timeout watchdog → rollback to pending → re-drive.
10. cold hydrate with DB backlog + no live handle → **no** batch-spawn (existing invariant holds).
11. runtime-agnostic desync repro (the #task:1416 scenario) across claude/codex/qoder/opencode → no orphan.

## 9. Open decisions

1. **Stage-1 shape — RESOLVED (shipped).** Extended the `runtime_start` reply
   with a required `phase` (smaller diff, keeps two commands) rather than jumping
   to `runtime_deliver`. Smallest correct step that killed the bug class, let us
   delete the cache-heal bridge, and de-risked before the Stage 2 command
   consolidation.
2. **daemon-instance-key single source — RESOLVED (shipped).** Converged
   `daemonKeyFromReady` (`123@ts`) and `makeDaemonInstanceKey` (`pid:123@ts`) into
   one `makeDaemonInstanceKey` mint (precursor `ac0cf38` + `2e99aa6`). Pure
   hygiene — the divergence was masked in every window by `onReadyForDrainEvent`
   reseeding off the cache's own latched key, so no behavioral bug, but the smell
   is gone.
3. **ack-timeout — RESOLVED for Stage 2 (Cindy).** No single global magic
   number. Stage 2's only daemon-custody states are `spawning` (reuse the
   existing init watchdog / B3 proof — missing consumed ⇒ init-timeout/failure →
   failed or rollback) and `admitted` (ready-write should emit consumed/failed
   fast; a short protective guard only, sized as a bug-catcher, NOT by "longest
   model turn"). The genuine "longest legitimate mid-turn hold" problem is
   Stage 3-only (daemon holds the gated queue awaiting `turn_end`) and wants a
   lease/heartbeat-extendable timeout, configurable — designed separately then,
   not pre-solved with a constant now. Stage 2 defines the timeout seam but
   implements only its two custody states.
4. **Stage 3 scope confirmation:** shiki asked for the "thorough" version
   (queue in daemon). **Resolved:** endgame is in scope (shiki: build to the
   correct end-state, no intermediate-state dogfood); Stage 3 still gets its own
   crash-safety design pass + verification bar before merge, sequenced after
   Stage 2 lands.
5. **Compatibility — RESOLVED (shiki + Cindy, 2026-07-08).** The standalone
   daemon is not yet released (zero deployed users) and shiki coordinates the
   backend-side upgrade, so there is **no external compatibility constraint**.
   Stage 2+ builds straight to the end-state: no optional fields, no dual
   command surface, no old-daemon fallback shim, no half-new/half-old protocol
   window. Old backend→daemon start/wake delivery branches are retired outright.
   The version bump stays purely as dev-time / future-deployment fail-loud
   hygiene. The only invariants that MUST be protected are the persistence
   semantics and no-message-loss: DB never acks on "sent to daemon," only on
   `runtime_delivery_consumed`; refuse / disconnect / crash all return rows to
   pending or explicit failed.

## 10. Stage 2 design increment (SHIPPED)

Adopts Cindy's three tightenings: `deferred` is NOT introduced (no premature
daemon-queue custody); the synchronous disposition NEVER acks the DB; the
ack-timeout covers only Stage 2's real custody states. **Stage 2 unifies the
start/wake *command*, not queue *custody*.**

### 10.1 Ownership split (the load-bearing line)

- **Backend `RuntimeDeliveryCoordinator` keeps the gated safe-boundary and the
  mid-turn hold.** When a `gated` driver is mid-turn, the coordinator holds the
  batch backend-side (as today) and does **not** call the daemon until the
  boundary opens. The volatile queue stays in the backend through Stage 2.
- **The daemon does lifecycle-authoritative routing + mechanical delivery
  only.** It never holds a batch waiting for a future `turn_end` in Stage 2.

### 10.2 Command: `runtime_deliver` (replaces the backend start/wake surface)

```
runtime_deliver {
  conversation_id, agent_id,
  delivery_ids[], delivered_up_to_seq, deliveries[], text,
  spawn_options,            // consulted ONLY if the daemon must spawn
}
```

Backend claims the batch in-flight (`owner=connectionId`) before sending, exactly
as `startDeliveryBacked` does today. `runtime_wake` is **removed entirely** from
the backend command surface (all ready-state message delivery goes through
`runtime_deliver`). `runtime_start` is **narrowed, not removed** — see §10.2.1.

#### 10.2.1 `runtime_start` narrows to a pure lifecycle command (Cindy-signed 2026-07-08)

`runtime_start` is NOT delivery-only: `startDirect` uses it for an explicit
message-less spawn (start button / provision), and `runtime_deliver.delivery_ids`
is `min(1)` so it cannot carry an empty start. So the two commands split cleanly
onto orthogonal planes:

- **`runtime_start` = lifecycle plane.** "Ensure a runtime handle exists for
  (conv, agent)." Carries NO inbox row and NO delivery semantics. Its 2b wire
  target — locked — is:
  - `RuntimeStartParams = { conversation_id, agent_id, options }` — the
    `startup_delivery` block is **deleted**.
  - `RuntimeStartResult = { started:true, pid, started_at } | { started:false,
    reason:'init_cooldown', cooldown_until }` — `startup_delivery_accepted` is
    **deleted**, and so is the Stage 1 `phase` (below).
  - Success means only "daemon has/created the handle" — it does **not** promise
    ready, deliverable, or safe-boundary. Deliverability is expressed only by a
    `runtime_deliver` disposition + consumed/failed events; state observation is
    only via `runtime_status` / `runtime_state`. lifecycle plane ⊥ delivery plane.
- **`runtime_deliver` = delivery plane.** The sole message-delivery command;
  spawns-with-batch when no handle exists (the `spawning` disposition).

Both commands share the daemon's internal spawn machinery (one path with a
startup batch, one without) — that is implementation, not a second backend
delivery surface. **`phase` is deleted from `RuntimeStartResult` in 2b**: it was
a Stage 1 protocol fact introduced solely for the delivery reroute
(`startDeliveryBacked` phase-switch); once delivery-on-start is gone its only
consumer disappears, and a zero-consumer wire field becomes a *third* state-query
surface that drifts from `runtime_status`/`runtime_state`. Delete it (Cindy).

### 10.3 Synchronous disposition — transfers or refuses custody, never acks

| Real handle state | Daemon action | Disposition | DB effect |
| --- | --- | --- | --- |
| no handle / exited | spawn; this batch = startup delivery | `spawning` | stays in-flight (owner=conn) |
| ready | encode + write stdin | `admitted` | stays in-flight (owner=conn) |
| live oneShot (can't take stdin) | **refuse** (drains only at spawn time) | `refused{reason: startup_pending}` | rollback to pending; drains on exit→respawn-with-batch |
| spawning / startup_pending | **refuse** (no 2nd custody) | `refused{reason: startup_pending}` | backend rolls back to pending; resubmit on `ready_for_drain` |
| draining | refuse | `refused{reason: draining}` | rollback to pending; recovered on exit→respawn |
| init cooldown | refuse | `refused{reason: cooldown, cooldown_until}` | rollback to pending; respect backoff |

- Disposition enum in Stage 2 is exactly **`spawning | admitted | refused`**.
  `deferred` is **not defined and not emitted** — it is Stage 3's daemon-queue
  custody and is added only when that queue actually moves into the daemon.
- `spawning` custody is the **existing** startup-delivery mechanism (not a new
  queue): the daemon already holds a spawn's startup batch until init proof.
- The disposition is a **custody signal, not an ack.** It never touches
  `delivered_at`.

### 10.4 Ack model — `delivered_at` moves only on async events

- `runtime_delivery_consumed { delivery_ids }` → backend `markDelivered`. Stage 2
  sources: (a) startup-delivery consumed via init proof (`session_init` for
  `requires_first_message`, preserving today's B3 gate; write success for
  `self_inits`); (b) ready-write success on the `admitted` path.
- `runtime_delivery_failed { delivery_ids, reason }` → rollback to pending
  (retriable) or mark failed (fatal, e.g. `driver_refused` programming error).
- This **unifies** today's `runtime_startup_delivery_consumed/_failed` *and* the
  `runtime_wake {delivered:true}` synchronous ack into one consumed/failed family
  keyed by `delivery_ids`, regardless of spawn-vs-write. The old
  startup-specific events retire. **The at-least-once tradeoff is unchanged**: a
  disconnect between a successful write and its consumed event redrives the row
  (duplicate, never loss) — the same window today's async startup ack already
  accepts.

### 10.5 Crash / disconnect / in-flight

- `spawning`/`admitted` rows stay `in_flight owner=connectionId`; only `consumed`
  flips them. `refused` rolls back to pending immediately.
- Disconnect → `rollbackInFlightForOwner` → pending. Reconnect + `runtime_status`
  hydrate resubmits pending for handles the snapshot reports alive (live-delivery-only
  re-drive; **never** batch-spawn DB backlog — the cold-hydrate invariant holds).
- `ready_for_drain` **remains** a backend-driven replay nudge in Stage 2 (it
  re-submits the rows refused with `startup_pending`, and post-reconnect
  pending). It only retires when Stage 3 gives the daemon its own queue.

### 10.6 ack-timeout (narrow — §9.3)

Define the seam; implement only the two Stage 2 custody states: reuse the init
watchdog / B3 proof for `spawning`; a short bug-catcher guard for `admitted`. No
global constant for a future mid-turn queue.

### 10.7 Retirement in Stage 2

Retired outright (no fallback beside them at the end of 2b):

- Backend **spawn-vs-wake fork** in `deliverMessage` / `startDeliveryBacked` (the
  cache-`phase` branch that chose start vs wake). The cache stops being a
  *decision* input → pure projection + optional fast-hint only.
- **`runtime_wake`** command surface — fully retired; all ready-state delivery is
  `runtime_deliver`.
- **`runtime_start`'s delivery role** — narrowed to pure lifecycle (§10.2.1):
  `startup_delivery` param, `startup_delivery_accepted` result, and the Stage 1
  `phase` result field are all deleted. `runtime_start` itself is **kept** for
  message-less explicit spawn.
- Coordinator **synchronous `delivered_at` ack** (`dispatchWake` markDelivered on
  `{delivered:true}`) and the **B3 init-gate** (`initPendingDeliveryIds` +
  `onParsedEvent` `session_init` → markDelivered): both move to the daemon, which
  emits `runtime_delivery_consumed` on the proof point (write success for
  `self_inits`; `session_init` for `requires_first_message` spawn). A ready
  handle on the `admitted` path is already inited, so its consumed = write
  success.
- **`runtime_startup_delivery_consumed`/`_failed`** events → unified
  `runtime_delivery_consumed`/`_failed` family.

Retained in the backend coordinator through Stage 2 (§10.1): busy tracking, the
gated mid-turn hold + flush-at-`turn_end` (flush now dispatches `runtime_deliver`,
not `runtime_wake`), and oneShot auto-respawn.

Behavioral rules locked with Cindy (2026-07-08):

- Explicit `start()` does a **message-less** `runtime_start` only — it must NOT
  route through `startDeliveryBacked` or opportunistically drain pending. Pending
  rows are (re)submitted as `runtime_deliver` by the spawn's `ready_for_drain` /
  pending replay, never smuggled through `start`.
- **respawn split**: a respawn *with* pending rows goes through
  `runtime_deliver`'s spawn-with-batch; a truly empty start goes through
  `runtime_start`. "respawn-to-empty" must never become an implicit delivery.
- **Naming/comment cleanup** ships with 2b: `OutboundAgentRuntimeProjection.start`
  ("uses pending inbox rows as startup_delivery"), `AgentRuntimeHost.deliverMessage`
  ("injects via runtime_wake"), and any comment implying the old model must go.

**2b end-state has three hard "no residue" invariants:** no `runtime_start`
carrying a message, no `runtime_wake` delivering a message, no synchronous result
writing `delivered_at`.

Version bump `HOST_PROTOCOL_VERSION 4→5` + `OUTBOUND_PROTOCOL_VERSION 3→4`,
fail-loud, no shim. **Staging note:** the version bump + `runtime_deliver`
registration + unified-event wiring land in **2a** (the wire surface changes
there); the backend cutover + all the retirements above land in **2b**. In 2a the
old start/wake delivery path is untouched and the new command/events are exercised
only by daemon-side tests.

### 10.8 Test-matrix mapping (§8)

Stage 2 owns cases **1** (ready+boundary → admitted → consumed), **3** (startup
→ consumed after init), **4** (draining → refused → recovered), **5** (spawn →
consumed at init settle), **7** (driver refused → failed, surfaced), **8**
(init-ack gate → consumed only after `session_init`), **10** (cold hydrate, no
batch-spawn), **11** (runtime-agnostic desync repro). Case **6** (disconnect
while queued): in Stage 2 the "queue" is the backend coordinator's gated hold
(backend rollback) plus daemon-custody `spawning`/`admitted` rows (owner
rollback). Case **2** (mid-turn gated → daemon `deferred` → flush at `turn_end`)
and case **9**'s long-hold form are **Stage 3** — in Stage 2 the mid-turn hold is
backend-internal and never reaches a daemon `deferred`.

## 11. Stage 3 design increment

Status: **Stage 3a shipped, review-clean** (`f9cc380` mechanism + `106a3d3`
owner-fix round; Cindy review-clean, thread #conv:FPx_VgJiuxhDKtya; local, not
pushed). §11 is the authoritative spec of the shipped design; the daemon-side
queue-sink end-state (§11.8) is realized. Stage 3b (retire dead backend
surfaces + docs) follows. Where §11 refines §3–§5's end-state sketch it
overrides them (§3 was written before Stage 2 nailed the refuse-and-replay
path; see §11.2).

### 11.0 The decisive as-built fact

**The daemon already maintains the identical busy tracker.** `handle.busy =
{ outstandingToolUses, compacting }` (`packages/host/src/daemon/supervisor/handle.ts`)
is updated in `updateRunStateFromParsed` with byte-for-byte the same transitions
the backend coordinator applies in `onParsedEvent` (`tool_call +1`,
`tool_output −1` clamped, `turn_end → 0`, `compaction_started/finished`). The
daemon also owns `handle.driver` with the full classification surface
(`busyDeliveryMode: gated|direct|none`, `oneShot`, `kickoffMode`,
`readyToEncode()`), and already flushes startup batches through
`consumeStartupDelivery` (encode → write stdin → emit `runtime_delivery_consumed`,
deferring the ack to `session_init` for `requires_first_message`).

So Stage 3 does **not** *move* the busy tracker — it **collapses a duplicate**.
The coordinator's `busy` tracking, `isSafeBoundary`, `enqueue`/`flush`, and
`combineText`/`combineGated` become the daemon's, sitting on top of state the
daemon already computes on every parsed event. This is why the daemon is the
correct home: it is the one process that both *sees* `turn_end` and *acts* on it,
with zero round-trip.

### 11.1 What Stage 3 changes — exactly one delivery case

Only **ready-handle-mid-turn-gated** delivery changes owner. Everything else is
untouched:

| Case | Stage 2 (today) | Stage 3 |
| --- | --- | --- |
| ready + safe boundary (or `direct` driver) | `admitted`, write now | **unchanged** — `admitted` |
| **ready + mid-turn (`gated`)** | backend coordinator holds the batch, flushes at `turn_end` | **daemon** holds it → `deferred`, daemon flushes at its own `turn_end` |
| no handle / exited | `spawning` (spawn-with-batch) | **unchanged** |
| spawning / startup_pending / not-ready-to-encode / live oneShot | `refused{startup_pending}` → backend durable-pending → `ready_for_drain` replay | **unchanged** (see §11.2 — deliberately NOT folded into `deferred`) |
| draining / cooldown | `refused{draining|cooldown}` | **unchanged** |

### 11.2 `deferred` scope — the load-bearing refinement (diverges from §3)

§3's end-state table folds `spawning`/`startup_pending` into `deferred`. **Stage 3
does not.** `deferred` custody is taken **only** when there is no lossless
DB-backed re-drive already available:

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
This is minimal-custody, satisfies Cindy pt 4 (no backend second queue) *and*
pts 1/3 (DB spine, least volatile custody), and is strictly safer than §3's
sketch.

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
draining, cooldown, live oneShot) keep their Stage-2 `spawning`/`refused` arms
verbatim. `deferred` is a **custody signal, not an ack** — it never touches
`delivered_at`; the row stays `in_flight owner=connectionId`, identical to
`admitted`/`spawning`.

### 11.4 The daemon deferred queue

- **Shape.** A new per-handle `deferredQueue: DeferredEntry[]` (distinct from the
  single `startupDelivery` slot), each entry carrying `{ deliveryIds,
  deliveredUpToSeq?, deliveries?, text, owner }` — the batch payload the WRITE arm
  places on `startupDelivery`, **plus a delivery-owner token** (§11.4.1). Dedup by
  delivery-id set (idempotent re-submit), mirroring the coordinator's `dedupKey`.
- **Flush triggers (two, both re-check `boundaryOpen`):**
  1. **Turn-end / boundary reopen.** In `updateRunStateFromParsed`, after the
     `turn_end`/`tool_output`/`compaction_finished` transition recomputes the
     boundary, if `deferredQueue` is non-empty and the boundary just reopened,
     schedule `void flushDeferred(handle)`. Symmetric to the coordinator's
     `if (!wasSafe && nowSafe && pending.length) flush()`.
  2. **Post-write re-drive.** When a write settles (`consumeStartupDelivery`
     clears `startupDelivery` and emits `consumed`/`failed`), if `deferredQueue`
     is non-empty and admissible, flush again. This closes the *consecutive-
     delivery window* Cindy flagged: a second `deliver` landing during a
     write-in-flight is enqueued (`deferred`), not refused, and re-driven after
     the in-flight write consumes.
- **Flush mechanics — split by driver mode (Cindy P1-2).** `flushDeferred` runs
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

#### 11.4.1 Delivery-owner token + owner-context API — the load-bearing half of crash-safety (Cindy P1-1)

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

### 11.6 Crash / disconnect / runtime-exit (Cindy pt 3)

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
  hook that drives this is a **hard 3a deliverable**, not a deferred integration
  point.
- **Daemon volatile queue is bounded and non-durable by contract.** Losing it is
  safe precisely because the DB row was never acked (Cindy pt 1).

### 11.7 Timeout / lease (Cindy pt 5)

The custody-loss guard is **event-driven, not wall-clock** — which is exactly
what "protect against lost custody without misfiring on long turns" demands:

- **Dead daemon / dropped transport** → disconnect → immediate rollback (§11.6).
- **Dead runtime** → `runtime_exit` → immediate `failed` (§11.6).

Both are zero-false-positive on a long, healthy turn. A wall-clock "turn too long"
timer is **rejected** — it cannot be sized (Cindy pt 5, shiki "no magic
constant"). The one residual case — daemon alive, transport alive, but the turn
**never** ends (a wedged runtime that emits no `turn_end`) — is **not** a delivery
custody bug; it is the #1416(b) bad-model observability hold (a wedged runtime
must surface an error + `turn_end`), tracked separately. Stage 3 adds **no**
timer of any kind: no turn-length timeout **and no idle-output watchdog** — an
idle-output watchdog degrades into an implicit turn timeout and is not built
absent a measured case that proves it necessary (Cindy, confirmed). Custody loss
is disconnect + `runtime_exit`, full stop.

### 11.8 Backend `RuntimeDeliveryCoordinator` after Stage 3

Reduced to **claim / submit / projection** (Cindy pt 4) — no second queue, no
busy tracking:

- **Retired:** `BusyState` + `isSafeBoundary`; `PerAgentState.{busy,pending,
  flushing}`; `enqueue`/`flush`/`combineText`; the busy-transition half of
  `onParsedEvent`; the `combineGated` callback.
- **Kept (all submit/projection, not custody):** the claim-then-`runtime_deliver`
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

As shipped, the coordinator survives as a slimmed submit/projection class (it
did not dissolve into the fanout); the invariant it upholds is that no delivery
*decision* remains backend-side.

### 11.9 `combineGatedBatch` moves to `host` (bounded context)

The gated-text combine (`packages/backend/src/runtime/stdin-format.ts:combineGatedBatch`)
must run daemon-side at flush. It is runtime/driver-layer text assembly, so it
belongs in `packages/host` (or `packages/shared` if the backend still needs it
transitionally). This is a bounded-context correction, not new logic — `host`
owns runtime, and the daemon is now the one combining before encode.

### 11.10 Wire + versions

- Add a fourth arm to `RuntimeDeliverResultSchema`: `{ disposition: 'deferred',
  pid, started_at }` (custody-on-daemon; backend keeps rows in-flight). Delete the
  "deliberately ABSENT `deferred`" comments in `protocol.ts` and supervisor
  `deliver()`.
- `refused` reasons **unchanged** (`startup_pending`/`draining`/`cooldown` still
  used by the startup-phase arms).
- No new async events (`consumed`/`failed` already unified).
- Bump `HOST_PROTOCOL_VERSION 6 → 7` and `OUTBOUND_PROTOCOL_VERSION 5 → 6`,
  fail-loud, **no shim** (standalone daemon unreleased, embedded is
  version-matched in-build).

### 11.11 Staging (staged COMMITs, no intermediate-state dogfood)

Delivery decision is singular, so the daemon-queue and the backend-cutover are
one functional change (cannot run both queues). Mirrors 2b/2c:

- **3a — mechanism + cutover (SHIPPED, `f9cc380` + owner-fix follow-up `106a3d3`).**
  Wire: `deferred` arm + version bumps. Daemon: `deferredQueue` (owner-tagged,
  §11.4.1), admission logic (§11.3), `flushDeferred` split by driver mode on the
  two triggers (§11.4), the owner-context API change (§11.4.1 —
  `DeliveryOwnerContext`, `deliver(params, ctx)`, `cleanupDeferredForOwner`,
  `dispatch`/`OutboundCommandDispatcher` ctx args, and all three ingress
  mint+close wirings), exit-`failed`, `combineGatedBatch` moved to host (§11.9).
  Backend: the coordinator was slimmed to submit/projection **in this commit** —
  busy tracker / second queue / `flush`/`combineGated`/`rollbackInFlight`
  callbacks / `queued_mid_turn` all removed, `submitLiveDeliveryBatch` always
  submits, `onRuntimeExit` no longer rolls back. It treats `deferred` like
  `admitted` for custody (in-flight, no ack) but does **not** arm the delivery-stuck
  watchdog for it (§11.8). Follow-up `106a3d3` (Cindy round-1): owner is a
  load-bearing custody key — a single `resolveDeliveryOwner` fail-loud chokepoint
  (no `*:unknown` sentinel) across all three ingresses, and owner-aware deferred
  dedup (same-id-set under a new owner rebinds to the current owner, closing the
  reconnect/reclaim orphan race).
- **3b — retire dead backend combiner + docs (SHIPPED, `903dfee`).** The
  coordinator slimming already happened in 3a, so 3b only deletes the now-dead
  backend `combineGatedBatch` (authoritative copy lives in host `gated-combine.ts`;
  the backend copy had zero code callers) and finishes the docs: flips this §11
  status and the top-of-doc status to shipped, and adds the `docs/progress.md`
  Stage 3 section. (`docs/daemon-outbound-protocol.md` / `docs/silverhand-daemon.md`
  were already updated in Stage 2c; §3–§5's end-state prose is left as the design
  narrative, with §11 authoritative where they diverge.)

### 11.12 Test matrix (Stage 3's cases)

Owns §8 cases **2** (mid-turn gated → `deferred` → flush at `turn_end` →
`consumed`) and **9**'s long-hold form (no false-positive timeout on a long turn).
New Stage-3-specific invariants:

- **`gated` flush combines** N queued batches into ONE write (gated one-turn
  invariant) → one `consumed` covering all delivery_ids.
- **`direct` flush is FIFO, one entry per write, NO combine** (Cindy P1-2):
  write-in-flight collision serializes N direct deliveries into N separate writes,
  each its own `consumed`; delivery semantics unchanged. Gated-combine and
  direct-FIFO are covered by **separate** tests.
- consecutive-delivery window: a `deliver` during a write-in-flight → `deferred`,
  re-driven after the in-flight `consumed`, no refuse, no loss.
- runtime exit with a non-empty deferred queue → `failed{child_exit}` for all
  queued ids → rows pending, no orphan.
- **owner-scoped disconnect** (Cindy P1-1): connection A's drop discards **only**
  A's deferred entries (a co-resident owner B's entries survive) → backend
  `rollbackInFlightForOwner(A)` → pending → reconnect replay, **no duplicate**
  (nothing was written), no loss, B untouched.
- no double-ack on replay; `deferred` never writes `delivered_at`.
