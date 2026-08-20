# Freshness Boundary Authority (whole-runtime EXISTS-guard, scheme C)

> Architecture contract for outbound-send freshness. This document is the
> **contract + invariants** (runtime-agnostic). It supersedes the earlier
> "held-draft CAS / Plan B" design in which the daemon owned a per-stream
> observed boundary and stamped `seen_up_to_seq` — that model was **rejected**
> (shiki, 2026-08-19/08-20) and its whole apparatus is deleted, not deferred.
> The prior slock-style `observedSeqByStream` / per-target seen-set / rich-seen
> roadmap does **not** exist and is not planned here.

## 1. What freshness is (and is not)

Freshness is a property of **the whole runtime's field-of-view**, not of a
single stream, conversation, or thread. One runtime = one context. Anything
routed to that runtime — in any conversation, any thread, or a mainline — that
it has **not yet consumed** makes **all** of its pending sends stale, regardless
of which conversation the send targets.

Rationale (shiki, 2026-08-19): an agent-scoped agent exists to collaborate
across channels. If a human primes agent A in a DM, A's about-to-send line in
channel B is genuinely out of date until A has consumed that DM. Thread vs.
mainline is the same argument — no isolation. The conversation-scoped runtime is
the degenerate N=1 case; its behavior is unchanged.

This replaces the old "did *this stream's* seq advance past what the model
observed" question. There is no per-stream observed boundary, no `seen_up_to_seq`
transported from a CLI-read file, no daemon-stamped boundary.

## 2. Authority: the backend, from the runtime's inbox

- **Carrier** = "does this runtime still have an **undelivered inbox row**?"
  (a boolean EXISTS over `conversation_inboxes` with `delivered_at IS NULL`,
  including in-flight rows and hanging leases swept by the outbound fan-out).
  A message the runtime sends does **not** create an inbox row for itself, so
  the whole legacy per-stream "don't self-stale" compensation is structurally
  unnecessary — it is deleted, not reimplemented.
- **Authority = the backend**, evaluated at `message send` against a
  `RuntimeScope` guard: `hasUndeliveredForAgent` (agent-scoped) /
  `hasUndeliveredForPair` (conversation-scoped). The guard key is the
  `RuntimeScope`, never `agent_id` (an agent-scoped agent serving N conversations
  is one runtime; a conversation-scoped pair is its own scope).
- **The daemon does NOT participate in freshness.** No daemon-side cursor, no
  CAS stamp, no observed boundary, no held-draft preflight. The former daemon
  symbols `observedSeqByStream` / `pendingAdmissionSeqByStream` /
  `pendingSkippedCasMergeByStream` / `drainSkippedCasMerges` / `streamStorageKey`
  and the `stream_head_before` wire field are all removed.

## 3. Invariants

1. **Guard ⊇ drain; the difference is exactly the in-flight set.** The drain
   side (`listPending` / `listPendingConversationIdsForAgent`) carries an extra
   `in_flight_owner IS NULL`; the guard does not. So the guard can still fire
   while the only undelivered rows are in-flight (owner = a connection),
   bounded above by ack or the start/disconnect sweep. That difference is the
   accepted **worst-case one self-healing 409** — it is NOT `≡`. Prose that
   writes the relation as `≡` is wrong: it denies the one live window the design
   keeps.
2. **The 409 carries no seq and no count.** `code = 'message_stale'` is the wire
   discriminant (a frozen literal, hard-compared downstream); details =
   `{ subkind, stale_event_id, hint }`. Unread *count* is structurally an
   over-count (the predicate includes in-flight) and never rides the 409; it
   appears only in the reject-path WARN log.
3. **The guard is the only authority; human-typed `--anyway` is the only
   bypass producer.** `freshness_bypass` stays a boolean — it is not widened,
   and there is no daemon "queue-empty ⇒ arm bypass" state machine (that was
   rejected: an empty daemon queue does not prove the runtime consumed the
   backend's field-of-view, so it would silently drop a stale in the in-flight
   window).
4. **Convergence, not a lock.** A rejected send converges by: the bounded-prefix
   `stale-receive` handoff strictly shrinking the undelivered set, failed
   handoffs `unshift`-restoring it, and the existing settlement-before-send
   barrier serializing the retry. Residual = the one self-healing 409 of
   invariant 1; there is no distributed lock and no protocol handshake.
5. **`delivered_at` means "written to that process's stdin", not "in context".**
   A window judged fresh after clear-session / restart / compaction is a known,
   accepted boundary — not a regression of this contract.

## 4. Sidecar file is not a freshness source

The `last-delivered-seq` sidecar (`spawn-prep.ts`) is a bare `<seq>\n` scalar —
the **last** value written, not a monotonic cursor and not a per-stream ledger.
It has **no in-tree reader** (the CLI forwards its path but never parses it), and
per-origin delivery-ack authority lives on the `runtime_delivery_consumed`
event, not this file. No send path derives freshness from it.

## 5. Accepted product degradations

Recorded and accepted (shiki), not defects to fix here:

1. A stale loop costs at worst one extra send round-trip (ack in flight, or a new
   row lands during the loop).
2. The 409 no longer says how far behind or where — intentional; triage detail
   is recovered from the reject-path COUNT in the WARN log.
3. Interruption is more frequent: any undelivered row in any of an agent-scoped
   runtime's conversations blocks its sends, so the gate can grind toward noise.
   No lever is built to soften this.
4. A non-follower's first line in a thread is "spoke without reading" — it may
   conflict with concurrent replies it has not seen (ruled acceptable for
   experience reasons).
5. Coupling shifts from "did the stream advance" to "was anything routed to me":
   anything that flowed but was **not** routed to this runtime is judged fresh.
   A fan-out/participation miss that the old independent-seq comparison would
   have incidentally caught, this model will not.

**No degradation** on the human side (never 409s), no delivery loss, no deadlock,
no protocol version bump, and no change to the freshness model's own persisted
state.

## 6. The refusal is a recorded fact (#task:2099)

The reject path writes ONE marker-only activity row so the agent's own Activity
log carries the verdict:

1. **Producer**: the daemon emits `runtime_message_stale` from the SAME branch
   that arms `pendingStaleEvent` — i.e. gated on `extractStaleConflict`, so an
   unactionable "stale" 409 (no `stale_event_id` / no `target_conversation_id`)
   arms nothing and records nothing. One row per refusal; a superseding 409 is a
   second refusal and gets its own row.
2. **Coordinate**: the conversation the command was issued FROM, snapshotted
   before the HTTP await (`handle.conversationId` is the agent-scoped session's
   mutable focus), never the refused send's target.
3. **Content**: identity + `ts` only — `payload IS NULL`. The `stale_event_id`,
   the over-count, and the refused target stay where §3.2 put them: the
   reject-path WARN log. Triage is an operator concern, not a timeline row. The
   row's own write path logs NOTHING: one refusal still means exactly one WARN,
   at the guard that minted the verdict. A log after the insert would also be a
   lie on the two arms where the insert silently does not happen (no activity
   sink configured; the write threw and was caught).
4. **Why a fact and not a guess**: the renderer used to infer staleness from
   `--stale-resolution` / `--anyway` in the agent's captured command text. That
   proxy missed flagless retries, false-positived a pre-emptive `--anyway` with
   nothing pending, and saw nothing at all on runtimes whose tool-call capture
   carries no command (OpenCode via ACP persists `{cwd}` alone). It is deleted.

This adds persisted rows on the reject path — the only persistence this contract
grows — and projects NOTHING onto run state.
