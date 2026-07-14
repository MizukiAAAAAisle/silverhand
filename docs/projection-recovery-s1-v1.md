# Projection-level recovery (S1) — authoritative projection patches

Contract for the *conversation-scope* S1 recovery path (reply_count /
threads_list): the backend attaches a minimal authoritative projection delta to
the message frame; the client idempotently merges the absolute value.

Related: `docs/event-ws-transport-v1.md` (three-state cursor), the message-row
patch seam (`patchMessageInActiveProjections`), and the
`im-architecture-explainer.html` §05⑤ framing (铁律 vs 落法 vs 终态).

---

## 0. TL;DR

The **normal path** for a derived aggregate (reply-count / threads-list /
followers) is: the backend attaches the **minimal authoritative projection
delta** to the same message frame that caused the change, and the client
**idempotently merges the absolute value** into the displayed projection.
Invalidate → whole-window refetch is retained as the **failure / absence
fallback**, not the hot path.

- Authority never moves — backend stays the sole computer of derived values.
- The client never invents truth — it only *applies* backend-sent absolute
  values or authoritative ordering-key values. No local `+1`, no local sort
  invention.
- The resume floor still advances **only on authoritative settle**.

## 1. Projections and their fallbacks

| projection | patch merge (normal path) | refetch fallback |
|---|---|---|
| thread-root reply_count | set the absolute on the open root row | invalidate that one root row |
| mainline root reply_count | same absolute merge on the mainline-displayed root | invalidate on the mainline-displayed root |
| channel threads-list | merge invariant fields + re-sort the held page (§6) | refetch the whole list |
| thread followers | — (per-viewer; not carried on this frame, §5) | invalidate on every reply |

The whole-list threads refetch is the dominant **amplification** the patch path
kills: one reply changes one integer, but the integer is embedded in a list
query, so a fallback refetches the entire list.

## 2. Non-negotiable invariants (铁律)

1. **Backend is the sole authority** for every derived value. The client caches
   / displays / idempotently applies; it never derives truth from a local delta.
2. **All projection deltas are absolute values or authoritative ordering-key
   values** (`reply_count = N`, full entry incl. `root_seq`) — never `+1` /
   added-delta / a client-invented position. Absolute writes are
   replay-idempotent; deltas double-count on replay (the delta-double-count falsifier).
3. **Floor advances only on authoritative settle**. A synchronous merge
   settles immediately; a fallback refetch settles on its commit; a rejected
   fallback **pins** the floor.
4. **No second source of truth.** Deltas merge *into the existing projection
   caches* (the thread-root, channel-threads-list, and thread-followers caches).
   S1 adds no parallel scorer / cache.
5. **A reply-triggered patch is correlated to `msg.thread_root_id`; the client
   validates, never trusts, the patch's self-declared target.** Every
   reply-triggered projection is *about the one root the frame's message replies
   to* — so `msg.thread_root_id` is the client's authoritative correlation key,
   and a patch's own `root_id` is a **redundant, derivable** field. The client
   MUST gate patch-validity on `patch.root_id === msg.thread_root_id` (and
   `msg.thread_root_id !== null`). A divergence is a **corrupt sidecar**
   (anti-corruption boundary): treat it as **patch-absent** for that root — the
   old invalidate→refetch fallback runs, the mismatched patch is **discarded, not
   merged**. This gate must cover BOTH the fallback-suppression decision AND the
   registry dispatch; suppressing fallback while still merging the stray patch
   would strand the real root (neither refetched nor merged) and silently advance
   the floor past its update — a lost update. The backend upholds the
   equality by construction (§4); the client never depends on that — it enforces
   it defensively so a backend/fixture/future-code bug can't corrupt the floor.

## 3. The broadcast-frame 铁律: viewer-invariant only

This is enforced by the **existing scope architecture**, not a new rule:

- `conversation:{id}` — the MESSAGE-STREAM scope — is **broadcast**: one payload
  fans to every subscriber of that conversation.
- viewer-private facts have their own scope, `viewer:{userId}`.

Therefore the `projections` block on a `conversation:{id}` message frame **can
carry only viewer-invariant authoritative facts, by construction.** Any
per-viewer derived value (e.g. `viewer_following`, a per-viewer sort position, a
permission-filtered set) is architecturally barred from this frame — it would
have to ride `viewer:{userId}` (out of S1's message-frame scope) or stay
refetch. **This is the gate every projection below is classified against.**

## 4. Wire contract (backend)

The `EventFrame` envelope is unchanged (`payload: unknown`). Only the `message`
payload shape grows, additively:

```text
// kind: 'message'
payload: {
  message: MessageDto,              // unchanged
  projections?: {                   // NEW, optional, additive
    thread_root_reply_count?: { root_id: string; reply_count: number },
    threads_list_entry?: {
      entry: ThreadSummaryInvariant, // ThreadSummary MINUS viewer_following,
                                     // PLUS root_seq (the keyset tie-break, §6)
    },
    // thread_followers: DEFERRED — see §5 / §9 (per-viewer, not on this frame)
  }
}
```

`ThreadSummaryInvariant` = `ThreadSummary` minus the per-viewer `viewer_following`,
plus `root_seq` (additive DTO field, §6). The client keeps its own
`viewer_following` for a row it already holds.

Two backend invariants:

- **Computed in the same write transaction** as the message insert:
  `reply_count` is the `COUNT(*)` *as of this insert*, never a later/future-seq
  value.
- **Additive / optional**: a client that doesn't understand `projections`
  ignores it and falls back to refetch. Backward compatible.
- **`root_id === msg.thread_root_id` by construction** (§2 #5): the backend
  derives `thread_root_reply_count.root_id` from the SAME `threadRootId` it
  stamps on the inserted reply — they cannot diverge on the wire. This is the
  backend half of the correlation invariant; the client validates it anyway
  (anti-corruption) and falls back on any divergence.

## 5. Per-projection classification (the core table)

Two axes decide everything: **viewer-scope** (invariant vs per-viewer) and
**windowed** (single-row vs ordered-list).

| projection | authority source | viewer-scope | rides frame? | merge rule | insert? | floor on failure |
|---|---|---|---|---|---|---|
| **reply_count** | `COUNT(*)` non-system replies | invariant | ✅ | set absolute on the displayed root row (thread-root and/or mainline root), membership-gated | no (root either displayed or not) | no active reader / row not in cache → vacuous settle; **active but no patch → fallback invalidate**; reject → pin |
| **threads_list_entry** | `ThreadSummary` **invariant subset + `root_seq`** | data invariant; **`viewer_following` EXCLUDED (per-viewer)** | ✅ (invariant subset + root_seq) | **root in client's page** → merge invariant fields into the held row (keep local `viewer_following`), reposition the page by the documented keyset (§6) | **NO insert** — root not in page → fallback refetch (also the off-page-activity case; insert deferred, §6) | not in page / no active reader → fallback or vacuous per §7; reject → pin |
| **followers** | `thread_followers` | **`viewer_following` is per-viewer** | ❌ | — | — | stays current refetch (deferred) |

Notes:

- `ThreadSummary` invariant fields: `reply_count`, `last_reply_at`,
  `last_reply_message_id`, `repliers`, `replier_total`, `root_*`. The **only**
  per-viewer field is `viewer_following`. The
  `threads_list_entry` patch carries the invariant subset; the client keeps its
  own `viewer_following` (it already has it in cache).
- **Per-thread unread is NOT carried** — it lives in a separate read-model
  (`ConversationStreamUnreadDto`, `GET …/unread`: "the same fact never
  sits in two payloads"). S1 must not smuggle it into the entry.

## 6. threads_list ordering: documented keyset, not a placement instruction

The channel threads-list order is **viewer-invariant**: the server keyset is
`ORDER BY lr.created_at DESC, root.seq DESC`, paginated over the same tuple. The
renderer displays server order **verbatim — no client-side re-sort** and loads
**only the first page**.

Two facts force the design:

- **A new reply does NOT unconditionally go to `top`.** `last_reply_at` can tie
  to the millisecond across roots; the server breaks the tie by `root.seq DESC`.
  A hardcoded `placement:'top'` is therefore wrong.
- **The tie-break key must be on the wire.** The server selects `root.seq`
  (`root_seq`); the client needs it to resolve same-`last_reply_at` ties the way
  the server does, so `ThreadSummary` carries `root_seq`.

**Design: one documented keyset, applied to authoritative values.**

- The sort keyset `(last_reply_at DESC, root_seq DESC)` is a **single documented
  contract** shared by server and client.
- `root_seq` is a viewer-invariant `ThreadSummary` field carried in the
  `threads_list_entry` patch.
- On a reply to a root **already in the client's page**, the client merges the
  invariant fields into the held row (keeping its local `viewer_following`) and
  **re-sorts its held page** by the documented keyset.

This is not a "second source of order truth": there is
exactly one keyset definition; the client applies it to backend-authoritative key
values, so its order is a pure deterministic function of authority and is equal
to the server's order **by construction** — it cannot drift. And it is not a
wrong hardcoded `top`: position is derived from the real keys,
including the tie-break, so ties resolve exactly as the server does.

**No insert, no trim in the merge path.** The client only re-orders rows it
already holds — the set is unchanged, so no trim is needed and consistency with a
refetch of the same set is provable. A root **not** in the page cannot be
inserted from the broadcast frame (its per-viewer `viewer_following` is absent —
defaulting it would be the client inventing a viewer fact, breaking §3), and it
also signals possible off-page activity — so it **falls back to refetch**. Insert
of an off-page root is deferred (it needs a per-viewer `viewer:{userId}` side
patch carrying the full row, or a client-side authoritative `viewer_following`
source).

Replay-safety: merge + re-sort keyed by `root_message_id` over absolute values is
idempotent, and resume replays frames in seq order, so replaying seq 1..N leaves
the page in the authoritative order.

## 7. Registry disposition — 4 states

The message-row seam's synchronous content-patch `boolean` is unchanged. The **derived
projection** path must NOT flatten to a boolean — S1's whole correctness rests on
the authoritative-settle state machine. Each projection merge returns a
disposition distinguishing at least:

- `merged` — a displayed projection was written synchronously (settled now);
- `cold-absent-vacuous` — **no active projection reader / the target row is not
  in cache** (`null`, settled vacuously — must NOT refetch);
- `pending-fallback` — the projection **is active** but the frame carried no
  usable patch, OR the patch is unmergeable → refetch Promise (settles on
  commit). **An active projection with a missing/expected patch is NEVER vacuous**:
  vacuously settling it would let the floor advance over a
  real update the client never applied;
- `rejected` — fallback refetch failed → **pins the floor**.

The distinction `patch absent ≠ projection absent` is load-bearing: `vacuous`
requires the *projection* to be absent (no reader / not cached), not merely the
*patch* to be absent.

These map onto the existing `Promise.allSettled` join in the ingestor. The
renderer owns the concrete type shape; backend only guarantees "the frame
carries an invariant absolute value keyed by projection."

## 8. Scope boundaries (deliberately narrow)

- **`snapshot_required` cold recovery stays refetch reconcile** (rare; the
  amplification there is acceptable). S1 optimizes only the live/normal path.
- **No follow/unfollow explicit-action path** — it has its own event flow; S1
  only treats message-frame-induced derived changes.
- **InterestRegistry is orthogonal** (a bandwidth axis, not correctness) —
  not mixed into this contract.

## 9. Notes

- **`root_seq` DTO field**: `ThreadSummary` carries `root_seq`. Viewer-invariant;
  the client needs it to apply the documented keyset (§6).
- **No off-page insert** is a deliberate scope cut: off-page roots fall back to
  refetch (§6); the off-page-activity refetch is not eliminated by the merge +
  reposition path (an off-page insert phase would need a per-viewer
  `viewer_following` source).
- **auto-follow on reply is per-viewer**: a reply auto-follows only the sender's
  viewer, so `viewer_following` changes are inherently per-viewer → confirms the
  followers deferral and why off-page insert (which needs `viewer_following`) is
  a later phase.
- The `threadRootId` seam hint is consumed by the reply_count/threads_list
  resolver; do not re-delete it.
