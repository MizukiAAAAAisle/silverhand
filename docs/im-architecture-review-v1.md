# IM Architecture Review (v1) — terminal-state health check + landing order

> Status: **index + sequencing only.** This doc does not define mechanism or
> invariants — every fact below is canonical in a linked doc and referenced here,
> never restated (single-source discipline, per the #task:1264 cleanup). If this
> doc and a linked canonical ever disagree, the linked canonical wins and this
> doc is the bug.
>
> Author: Norman (renderer). Companion to the three-way terminal-state review
> (2026-07-01, Norman + Cindy + Alice).

## Verdict

Reviewed as a mature IM server/client terminal state, the current architecture
is a **correct IM skeleton and should not be rebuilt.** The load-bearing
boundaries are already cut right (§1). The gap to terminal state is **not**
redesign — it is taking the boundaries currently held by *convention + docs* and
re-holding them by *type + structure* (§2). Landing order in §3.

## 1. Mainline already correct (do not touch the thesis)

The core thesis — **transport provides ordered, at-least-once delivery; the
renderer ingestor does idempotent, commit-gated satisfaction; the read model is
fully independent** — is the standard recoverable-ordered-event-stream model
(Slack / Linear / Matrix class). Each boundary below is already load-bearing:

| Boundary (already correct) | Canonical source |
|---|---|
| **delivery/resume ⊥ read/unread** — backfill/replay/snapshot never touch the read cursor; three cursors (transport frame ⊥ `conversation_reads` ⊥ `notifications.read_at`) stay separate. "补帧可得 ≠ 已读." | `docs/event-ws-transport-v1.md` §2; `docs/activity-lifecycle-v1.md` |
| **received-water ⊥ satisfied/applied-water** — socket receipt ≠ ack; resume floor advances only after per-frame effects commit (satisfaction queue). | `docs/event-ws-transport-v1.md` §9; #task:1261 |
| **message stream ⊥ side/self-healing projection** — message/reaction/task on the message stream (satisfaction-gated); activity/agent/members on side scope (cursor-inert). One cursor never mixes recovery classes. | `docs/renderer-event-ingestion-v1.md`; #task:1255 |
| **replay ⊥ delivery** — provenance wire deleted; a live frame and a backfill frame dispatch identically (idempotent apply makes them equivalent). | #task:1264; `docs/event-ws-transport-v1.md` §4.1 |
| **tombstone → forced snapshot, never silent skip** — stale/evicted cursor forces full snapshot (Matrix `M_UNKNOWN_TOKEN → re-sync`), not a silent jump. | `docs/event-ws-transport-v1.md`; renderer `channels/hooks.ts` `snapshot_required` |
| **single fanout seq source is *why* the cursor model is correct today** — `EventFrame.seq ≡ per-scope publish-log seq`, single-writer WAL gives full order for free. | `docs/architecture-principles.md` §10.1 (named non-goal: multi-node) |

## 2. Terminal-state gap = discipline → structure

Every remaining item is the same shape: a property that is **true today but
guarded by review/convention**, to be re-guarded so illegal states are
unrepresentable.

- **Subscription = bandwidth optimization, not a correctness boundary.** True
  since #1255/#1251 (correctness is cursor+resume, not mount state), but held by
  scattered conversation-reader subscribe effects + discipline. → **#task:1260** consolidates
  interest into one authority + a static fence. *Structural, not a correctness
  fix.* Detail: `docs/renderer-interest-registry-v1.md`.
- **seq id-spaces must not be conflated.** transport/message/read seqs are all
  `number` today; `stream_head_seq`-seeds-transport-cursor bugs are caught by
  eyes. → **S2 brand-typed `TransportSeq` ⊥ `MessageSeq` ⊥ `ReadSeq`** makes the
  conflation not compile. Principle: `docs/architecture-principles.md` §10.2;
  brand types are the mechanism.
- **Projection recovery is coarse.** reply-count uses authoritative-invalidate —
  **correct-first, but a transition state**: each cursor-inert frame triggers a
  *whole-window refetch*, an N-frame → N-refetch amplification at IM scale
  (high-frequency reactions / reply-count). → **S1 projection-level recovery**
  (versioned projection event / per-projection snapshot) retires the
  amplification. Correctness is already fine; this is latency/bandwidth.
- **(later / lower priority)** side-scope finer split
  (`conversation-side:<id>` → activity/members/agent_status) to cut unrelated
  replay/bandwidth; **capability bucket governance** — buckets map to
  coordination action *categories*, not endpoints (`architecture-principles.md`
  §10.3); human typing indicator (agent side already covered by
  AgentRunState/Activity Bubble).

## 3. Landing order

**#1260 (interest registry) → S2 (brand-typed seq) → S1 (projection recovery).**

Rationale (three-way agreed):
- **#1260 first**: the registry is where the three typed seqs get a clean
  structural home; establishing the interest boundary before typing the seqs
  avoids rework. #1260 is scoped **behavior-preserving** (centralize + fence +
  migrate); app-level subscription-lifetime policy is deferred so its blast
  radius stays small.
- **S2 next**: brand types land on top of the settled registry/transport seam.
- **S1 orthogonal**: projection-level recovery depends on neither and can slot
  in independently whenever latency/bandwidth warrants; it is not a correctness
  blocker.

Parallelizable now (per the lane plan): #1260 draft (Norman), the two structural
guardrails in `architecture-principles.md` §10 (Alice, landed `74d245e`), and
this review (Norman). Code for #1260 is gated on its draft passing the transport
(Alice) + correctness (Cindy) gates.
