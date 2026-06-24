# Freshness Boundary Authority v1 (held-draft CAS, Plan B)

> Architecture contract for moving the outbound-send freshness boundary from a
> CLI-read sidecar file to **daemon-owned authority**. This document is the
> **contract + invariants** (runtime-agnostic). The daemon-internal mechanism
> (coordinator storage, IPC shape, per-runtime input-admission signals, file
> migration mechanics) is owned by the implementation task (#task:945, Cindy).
>
> Status: Phase 1 implemented (#task:945, Cindy) and reviewed against this
> contract (Alice) — in_review, uncommitted, awaiting shiki dogfood. Author:
> Alice (architecture). Reviewer: Cindy (boundary / implementability).
> Decision owner: shiki.
> Redline: no push / no merge-main until bugs fixed AND dogfood passes.

## 1. Why this exists

`#task:940` shipped send-side optimistic concurrency (CAS) on conversation seq:
each `message send` carries `seen_up_to_seq`; the server rejects the insert
(`MessageFreshnessError` → 409 `message_stale`) when the conversation advanced
past it. The DB layer is correct — `conversations.latest_message_seq` single-row
CAS + `UNIQUE(conversation_id, seq)` backstop (v42), verified on real data
(`latest_message_seq == MAX(seq)`).

But the gaming-workspace counting game (`@all count upward from 1`) still
collided: agents emitted `1,1,1,2,2` instead of `1,2,3,4,5`. Root cause is **not**
the lock — it is the *source* of `seen_up_to_seq`.

### 1.1 The divergence (grounded)

Today `seen_up_to_seq` is read by the CLI from a host-written sidecar file
(`last-delivered-seq`). The host writes that file **unconditionally, immediately
after every stdin write**, on both delivery paths:

- startup delivery — `packages/host/src/daemon/supervisor/index.ts:779-780`
  (`writeStdinPayload` then `writeLastDeliveredSeq(batch.deliveredUpToSeq)`).
- live wake/deliver — `:1266-1267` (same pattern, `params.delivered_up_to_seq`).

There is **zero turn-boundary gating**. So the file tracks *"bytes pushed to
this agent's stdin"*, not *"content the model actually reasoned over."* Under
`claude --input-format stream-json`, a message written mid-turn is queued and
processed at the **next** turn — but the file advances **now**.

Counting-game trace:

1. Turn starts with context up to seq 12 (`@all count…`). Agent A drafts `1`.
2. Concurrently Judy's `1` lands at seq 13; the host delivers it to A's stdin →
   `last-delivered-seq` advances to 13 (A has **not** reasoned about it).
3. A's CLI POSTs `1` with `seen_up_to_seq = 13`. Server CAS: `current == 13`,
   `seen == 13` → **passes** → a stale `1` lands at seq 14.

The CAS validated the **delivery boundary**, not the **boundary the model
observed when forming the draft**. This is exactly the `#task:940` known
semantics ("delivered" ≠ "absorbed"); the counting game proves "delivered" is
too loose for the CAS use case.

## 2. Decision: Plan B (daemon as freshness authority)

Two repair shapes were considered (chat decision 2026-06-08, shiki: *"长期正确、
收益大优先于开发简单"* → **B**):

- **A (light patch):** host keeps writing the sidecar file but with corrected
  *input-admission* semantics; CLI keeps reading it and transports
  `seen_up_to_seq`; server enforces. Fixes gaming, smallest diff.
- **B (authority):** the **daemon/host is the single authority** on the
  model-seen boundary. The CLI returns to a dumb shim; at send time the daemon
  performs a preflight against its own coordinator state (observed boundary +,
  later, pending/read state) and injects/validates `seen_up_to_seq` before the
  server side-effect. Server CAS remains the final backstop.

### 2.1 Why B (fundamental differences, not dev-cost)

1. **Freshness semantic ceiling.** A's boundary is a scalar high-water seq —
   structurally it can express **only** the *widest* freshness scope ("any new
   seq in target" — the crudest / highest-false-positive band of the
   freshness-scope spectrum). B owns the boundary internally and can evolve
   it to a `message-id` seen-set / pending-unread set / per-target boundary,
   which is the prerequisite for **relevance-scoped** freshness later. A welds us
   to the crudest band permanently.
2. **Substrate for the deferred read-model roadmap.** count-only delivery,
   glance card, three-tier read primitive, structural relevance flags all
   require a daemon-side pending/read coordinator. slock blocks the counting
   game precisely via that coordinator's local preflight hold. A is a dead-end
   patch w.r.t. that roadmap; B's Phase 1 lays its foundation.
3. **Single source of truth (`architecture-principles.md`).** A splits "what an
   agent has seen" across three places (host file + CLI transport + server
   seq) — the state-split anti-pattern. B consolidates it into one authority
   (the daemon coordinator); the server only does final CAS.
4. **"Exists-but-unread" expressiveness.** B can hold a send *before* the server
   round-trip when the target has pending messages whose **bodies the model has
   not read** — semantically tighter than "seq moved". A (scalar + server CAS)
   cannot make that distinction.

### 2.2 Honest counterweight

- A is not *wrong*, it is *fragile-correct*: correctness holds only while every
  send path reads the file, every runtime's admission judgement stays tight, and
  the file is never polluted by a stale/concurrent write or a different runtime.
- **Server-side CAS is identical under A and B** (allocator + `UNIQUE`
  unchanged); the divergence is purely client/daemon-side boundary computation.
- B's real cost is more logic in the spawn/delivery-critical daemon path. This
  is mitigated by phasing (§6): Phase 1 both fixes gaming **and** establishes the
  authority — it is not a big-bang rewrite.

### 2.3 Reference: slock already does B

`@slock-ai/daemon@0.56.1` (read from local npx cache,
`dist/chunk-RIBO24KM.js`): the freshness boundary is the daemon-tracked
`modelSeenSeq` / `getVisibleBoundary` (`:2823`, `:8506`), injected into the send
body (`:2826`, `:2858`), **not** read from a delivery pointer. The boundary
advances only when a body is *explicitly exposed* to the model (events/check,
history, held/preflight context, server held response, send commit, genuine
full-text deliver). Busy-state delivery is a **content-free inbox notice** whose
stdin write records `cursors_advanced: "none"` (`:11428` / `:11475` / `:11503`)
— i.e. a notice does **not** advance the seen boundary. This is structurally the
boundary B introduces.

## 3. Core model: the input-admission boundary

The freshness boundary for a send is the **input-admission boundary**: the seq
high-water of content the host has confirmed will serve as **precedent context
for the model's next generation action** — not the seq of bytes merely written
to stdin.

### 3.1 Admission points (the boundary advances here)

`observed` advances **immediately, by batch high-water**, at each input
admission:

- spawn / wake initial input delivered to start a turn.
- idle delivery that opens a new turn.
- a previously-queued (busy-time) batch admitted at the **next turn-input
  start** (driven by a runtime turn-input-start signal — see §3.3).
- the agent explicitly reads bodies: `check` / `history` returning message
  bodies.
- a `409 message_stale` body that displays newer messages to the agent (the
  agent has now genuinely observed them — preserves `#task:940`'s
  409-advances-seen).
- a successful `send` commit advancing the agent past its own message.

### 3.2 Mid-turn red line (the boundary does NOT advance here)

A message delivered **mid-turn** (written to stdin while the model is already
generating) does **not** advance `observed`, even though the bytes are in
stdin. It is queued for the next model action; it is admitted only when it
becomes precedent context (§3.1), i.e. at the next turn-input start. This is the
exact pollution that caused the counting collision — it is a **red line**.

### 3.3 Not lost, only deferred

The mid-turn red line does **not** drop a message from `observed` forever: the
queued batch is admitted when it becomes the next turn's input. In the push
model this requires a reliable **"new turn input start"** runtime signal,
especially when the runtime self-consumes queued stdin without a new host
delivery. The spec pins admission to that signal; otherwise queued messages
would stall in `delivered` and never reach `observed` — the inverse failure
(systematic false 409). Sourcing this signal per runtime is an implementation
concern (#task:945).

### 3.4 Commit timing: admission-time, not turn-end

`observed` is committed **at admission time** (immediately), not at turn-end.
Rationale: the agent's `message send` runs **mid-turn**, so the boundary the
send reads must already equal *this* turn's input high-water before the send
fires. Committing at turn-end would lag a full turn and systematically false-409
the agent on its own turn input. (Converged with Cindy 2026-06-08; superseded
the earlier turn-end-commit proposal.)

## 4. Authority contract (Plan B)

### 4.1 The daemon is the single freshness-boundary authority

The daemon/host owns `observed` per (agent, target). No other layer computes or
caches the freshness boundary. The CLI MUST NOT read or derive the boundary.

### 4.2 Send preflight protocol

`message send` becomes: CLI submits the send intent (content, target, optional
explicit overrides) to the daemon; the **daemon** stamps `seen_up_to_seq` from
its `observed` authority (and, Phase 2+, may locally hold before the server when
the target has unread pending) and then performs the server side-effect. The CLI
does not supply `seen_up_to_seq` from a file.

- `--anyway` (freshness bypass) remains an explicit agent affordance and stays
  observable (`freshness_bypass_explicit`); it instructs the daemon to skip the
  CAS stamp/hold, not the CLI.
- Stale-resolution reason enum (`#task:941`) is unchanged and remains telemetry,
  never a gate.

### 4.3 Server CAS role (concurrent-race backstop, not observed truthfulness)

The server keeps the v42 allocator + `UNIQUE(conversation_id, seq)` CAS. Its
invariants do not change under B. But its job is **narrow**: it is the final
backstop for **concurrent-race / allocator integrity** — no two inserts can
share a seq, and a send whose *truthful* `seen` has been overtaken by a
concurrent insert is rejected. It is **not** a backstop for the truthfulness of
`observed`: if a buggy daemon over-advances `observed` to `current`, the CAS
`WHERE latest_message_seq = :seen` still matches and the stale send lands (see
§5 invariant 4). So the daemon makes the *client-side* boundary correct and
rich; the server guarantees seq integrity under concurrency — it does **not**,
and cannot, rescue an untruthful boundary.

### 4.4 CLI demotion + file-contract migration

The `last-delivered-seq` sidecar file is **retired as a freshness source**. Any
residual use of it for intervention/awareness, if kept, MUST NOT feed
`seen_up_to_seq`. Migration sequencing (so no window regresses correctness) is an
implementation detail of #task:945, but the contract requires: after Phase 1, no
send path derives freshness from the file.

## 5. Invariants (fail-loud)

1. `seen_up_to_seq` on any agent send originates from the daemon `observed`
   authority — never from a CLI-read file, never from a server "current seq"
   query.
2. Mid-turn delivery never advances `observed` (§3.2).
3. Every admission point (§3.1) advances `observed` by the admitted batch's
   high-water, immediately.
4. **Server CAS is a backstop for concurrent advance, not for an untruthful
   boundary.** The server CAS (`MessageRepo.reserveNextSeqIfFresh`:
   `UPDATE conversations SET latest_message_seq = latest_message_seq + 1 WHERE
   id = ? AND latest_message_seq = :seen`) only verifies that the submitted
   `seen` *equals the conversation's current seq*. It therefore catches a
   **concurrent insert** that raced ahead of a *truthful* `seen` (→ safe 409).
   It **cannot** detect an `observed` the daemon over-advanced past what the
   model actually absorbed: an inflated `seen == current` satisfies the `WHERE`
   clause and the stale send lands. Consequently the daemon's
   `observed`/admission discipline (§3.2, invariant 2) is itself
   **correctness-critical**, not merely a freshness-quality optimization — the
   server CAS narrows the concurrent-race window but is **not** a substitute for
   a correct boundary. (Caught by Cindy 2026-06-08; the earlier "a daemon bug
   can only cause extra false-409s, never let a stale send pass" wording was
   wrong — it holds only for *under*-advance.)
5. **Fail conservative, both directions.** A daemon that *under*-advances
   `observed` (e.g. an unavailable turn-input-start signal, §3.3) only causes
   safe false-409s and must always be preferred over advancing on bare
   delivery. A daemon that *over*-advances has no lower backstop (invariant 4),
   so every admission point must be provably tied to genuine model precedent
   context; when in doubt, do not admit.

## 6. Phasing

- **Phase 1 — authority + bug fix (this contract).** Move boundary ownership
  into the daemon; CLI send asks the daemon to stamp/validate `observed`; daemon
  maintains `observed` via input-admission (§3). This alone fixes the counting
  game and demotes the CLI to a dumb shim. Server CAS unchanged.
- **Phase 2 — local preflight + pending coordinator.** Daemon holds a send
  before the server when the target has unread pending bodies (slock-style
  `getPendingMessages` local hold). Enables "exists-but-unread" freshness.
- **Phase 3 — rich seen model.** Evolve `observed` from scalar high-water toward
  per-target boundary / message-id seen-set / read-source provenance, in service
  of count-only delivery, glance card, and relevance-scoped freshness.

## 7. Open questions / Cindy review targets

- Exact per-runtime "turn-input-start" signal for §3.3 (claude stream events vs
  codex thread events) — does each give a reliable admission anchor, or do we
  need a conservative fallback?
- Where `observed` lives in the daemon coordinator and how it survives
  respawn/resume without re-admitting un-absorbed batches.
- Migration ordering off the file contract with zero correctness window (§4.4).
- Whether Phase 1 keeps any file for intervention-awareness or removes it
  entirely.
- Interaction with idle-reap respawn (`#task:928`): does a reaped+rewoken agent
  re-admit its last input correctly?

## 8. References

- `#task:940` — send-side CAS + v42 allocator (server backstop).
- `#task:941` — stale-resolution reason enum (telemetry).
- `#task:943` — gaming counting repro + root cause.
- `#task:944` — slock daemon investigation (model-seen boundary).
- `packages/host/src/daemon/supervisor/index.ts:779-780, 1266-1267` — current
  unconditional `last-delivered-seq` writes.
- `@slock-ai/daemon@0.56.1` `dist/chunk-RIBO24KM.js` — reference daemon-authority
  implementation (`getVisibleBoundary`, `modelSeenSeq`, `consumeVisibleMessages`,
  `cursors_advanced:"none"`).
