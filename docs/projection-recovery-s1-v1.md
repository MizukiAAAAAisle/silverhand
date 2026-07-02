# Projection-level recovery (S1) — authoritative projection patches — v1

**Status:** DRAFT for review (#task:1276). Doc-first: this contract is reviewed
before code (Cindy's process gate). **Rev per Cindy review (2026-07-02):** P1
signed; P2 revised — no insert in v1, documented-keyset reposition replaces
`placement:'top'`, `patch absent ≠ projection absent` precision.
**Owners:** Alice — backend delta contract + this doc. Norman — renderer
projection consumption (registry, merge, disposition type). Cindy — correctness
gate.

Related: `docs/renderer-event-ingestion-v1.md` (#1261 satisfaction model),
`docs/event-ws-transport-v1.md` (three-state cursor), the #1270 message-row
patch seam (`patchMessageInActiveProjections`), and the
`im-architecture-explainer.html` §05⑤ framing (铁律 vs 落法 vs 终态).

---

## 0. TL;DR

Today a derived aggregate (reply-count / threads-list / followers) is recovered
by **invalidate → whole-window refetch** on every triggering frame. S1 replaces
the *normal path* with: the backend attaches the **minimal authoritative
projection delta** to the same message frame that caused the change, and the
client **idempotently merges the absolute value** into the displayed projection.
Refetch is retained as the **failure / absence fallback**, not the hot path.

- Authority never moves — backend stays the sole computer of derived values.
- The client never invents truth — it only *applies* backend-sent absolute
  values or authoritative ordering-key values. No local `+1`, no local sort
  invention.
- The resume floor still advances **only on authoritative settle** (#1261).

## 1. What S1 replaces (grounded)

| projection | current effect | file |
|---|---|---|
| thread-root reply_count | `invalidateQueries(threadRootKey)` → refetch one root row | `hooks.ts:1069` `applyThreadRootReplyBump` |
| mainline root reply_count | same invalidate on the mainline-displayed root | `hooks.ts:795` `applyMainlineMessageToChannelCaches` (reply branch) |
| channel threads-list | `invalidateQueries(channelThreadsKey)` → **refetch the whole list** | `useChannelThreads.ts:46` `invalidateChannelThreadsList` |
| thread followers | `invalidateQueries(threadFollowersKey)` → refetch on **every** reply | `hooks.ts:1087` `applyThreadFollowersMessage` |

The whole-list threads refetch is the dominant **amplification**: one reply
changes one integer, but the integer is embedded in a list query, so the entire
list is refetched. S1's biggest win is killing that.

The #1270 seam already reserved the hook: `patchMessageInActiveProjections`'s
`threadRootId` is documented (`hooks.ts:698-703`) as *"a FUTURE RESOLVER HINT …
so an S1 per-projection recovery can key off it without a signature change."*
S1 is that landing.

## 2. Non-negotiable invariants (铁律)

1. **Backend is the sole authority** for every derived value. The client caches
   / displays / idempotently applies; it never derives truth from a local delta.
2. **All projection deltas are absolute values or authoritative ordering-key
   values** (`reply_count = N`, full entry incl. `root_seq`) — never `+1` /
   added-delta / a client-invented position. Absolute writes are
   replay-idempotent; deltas double-count on replay (the #1263 falsifier).
3. **Floor advances only on authoritative settle** (#1261). A synchronous merge
   settles immediately; a fallback refetch settles on its commit; a rejected
   fallback **pins** the floor.
4. **No second source of truth.** Deltas merge *into the existing projection
   caches* (`threadRootKey`, `channelThreadsKey`, `threadFollowersKey`). S1 adds
   no parallel scorer / cache.
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
   the floor past its update — a lost update (Cindy #6). The backend upholds the
   equality by construction (§4); the client never depends on that — it enforces
   it defensively so a backend/fixture/future-code bug can't corrupt the floor.

## 3. The broadcast-frame 铁律: viewer-invariant only

This is enforced by the **existing scope architecture**, not a new rule
(`ws-frames.ts:13-25`):

- `conversation:{id}` — the MESSAGE-STREAM scope — is **broadcast**: one payload
  fans to every subscriber of that conversation.
- viewer-private facts have their own scope, `viewer:{userId}`.

Therefore the `projections` block on a `conversation:{id}` message frame **can
carry only viewer-invariant authoritative facts, by construction.** Any
per-viewer derived value (e.g. `viewer_following`, a per-viewer sort position, a
permission-filtered set) is architecturally barred from this frame — it would
have to ride `viewer:{userId}` (out of S1's message-frame scope) or stay
refetch. **This is the gate every projection below is classified against.**

## 4. Wire contract (backend — Alice)

The `EventFrame` envelope is unchanged (`ws-frames.ts:115-125`,
`payload: unknown`). Only the `message` payload shape grows, additively:

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
    // thread_followers: DEFERRED — see §5 / §8 (P3)
  }
}
```

`ThreadSummaryInvariant` = `ThreadSummary` minus the per-viewer `viewer_following`,
plus `root_seq` (additive DTO field, §6). The client keeps its own
`viewer_following` for a row it already holds.

Two backend invariants:

- **Computed in the same write transaction** as the message insert (Cindy #1):
  `reply_count` is the `COUNT(*)` *as of this insert* (`message-repo.ts:437`),
  never a later/future-seq value. Emit point: `conversation-message-service.ts:603`.
- **Additive / optional**: a client that doesn't understand `projections`
  ignores it and falls back to today's refetch. Backward compatible; also the
  natural rollout ordering (backend can ship first).
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
| **reply_count** | `COUNT(*)` non-system replies (`message-repo.ts:437`) | invariant | ✅ | set absolute on the displayed root row (threadRootKey and/or mainline root), membership-gated | no (root either displayed or not) | no active reader / row not in cache → vacuous settle; **active but no patch → fallback invalidate**; reject → pin |
| **threads_list_entry** | `ThreadSummary` **invariant subset + `root_seq`** (`thread-summary.ts:38`, `message-repo.ts:578`) | data invariant; **`viewer_following` EXCLUDED (per-viewer, line 57-60)** | ✅ (invariant subset + root_seq) | **root in client's page** → merge invariant fields into the held row (keep local `viewer_following`), reposition the page by the documented keyset (§6) | **NO insert in P2 v1** — root not in page → fallback refetch (also the off-page-activity case; insert deferred to P2.5, §6) | not in page / no active reader → fallback or vacuous per §7; reject → pin |
| **followers** | `thread_followers` | **`viewer_following` is per-viewer** | ❌ | — | — | stays current refetch (P3 / deferred) |

Notes grounded in source:

- `ThreadSummary` invariant fields: `reply_count`, `last_reply_at`,
  `last_reply_message_id`, `repliers`, `replier_total`, `root_*`. The **only**
  per-viewer field is `viewer_following` (`thread-summary.ts:57-67`). The
  `threads_list_entry` patch carries the invariant subset; the client keeps its
  own `viewer_following` (it already has it in cache).
- **Per-thread unread is NOT carried** — it lives in a separate read-model
  (`ConversationStreamUnreadDto`, `GET …/unread`, #1226: "the same fact never
  sits in two payloads"). S1 must not smuggle it into the entry.

## 6. threads_list ordering: documented keyset, not a placement instruction

The channel threads-list order is **viewer-invariant**: the server keyset is
`ORDER BY lr.created_at DESC, root.seq DESC` (`message-repo.ts:578`), paginated
over the same tuple (`message-repo.ts:573-577`). The renderer displays server
order **verbatim — no client-side re-sort** (`useChannelThreads.ts:66-97`) and
loads **only the first page** (`useChannelThreads.ts:61-64`).

Two facts force the design (both from Cindy's review):

- **A new reply does NOT unconditionally go to `top`.** `last_reply_at` can tie
  to the millisecond across roots; the server breaks the tie by `root.seq DESC`.
  A hardcoded `placement:'top'` is therefore wrong.
- **The tie-break key is not on the wire today.** `root.seq` is selected in the
  query (`root_seq`, `message-repo.ts:552`) but **dropped from the `ThreadSummary`
  DTO** (`message-repo.ts:614-628`) — the client has no tie-break key.

**Design: one documented keyset, applied to authoritative values.**

- The sort keyset `(last_reply_at DESC, root_seq DESC)` is a **single documented
  contract** shared by server and client.
- `root_seq` is added to `ThreadSummary` (additive; the value is already computed,
  just not exposed) and carried in the `threads_list_entry` patch.
- On a reply to a root **already in the client's page**, the client merges the
  invariant fields into the held row (keeping its local `viewer_following`) and
  **re-sorts its held page** by the documented keyset.

This is not a "second source of order truth" (Cindy review #1, point 3): there is
exactly one keyset definition; the client applies it to backend-authoritative key
values, so its order is a pure deterministic function of authority and is equal
to the server's order **by construction** — it cannot drift. And it is not a
wrong hardcoded `top` (Blocker 2): position is derived from the real keys,
including the tie-break, so ties resolve exactly as the server does.

**No insert, no trim in P2 v1** (Blocker 1). The client only re-orders rows it
already holds — the set is unchanged, so no trim is needed and consistency with a
refetch of the same set is provable. A root **not** in the page cannot be
inserted from the broadcast frame (its per-viewer `viewer_following` is absent —
defaulting it would be the client inventing a viewer fact, breaking §3), and it
also signals possible off-page activity — so it **falls back to refetch**. Insert
of an off-page root is deferred to P2.5 (a per-viewer `viewer:{userId}` side
patch carrying the full row, or a client-side authoritative `viewer_following`
source), out of P2 v1 scope.

Replay-safety: merge + re-sort keyed by `root_message_id` over absolute values is
idempotent, and resume replays frames in seq order, so replaying seq 1..N leaves
the page in the authoritative order.

## 7. Registry disposition — 4 states (renderer — Norman owns the type)

The #1270 seam's synchronous content-patch `boolean` is unchanged. The **derived
projection** path must NOT flatten to a boolean — S1's whole correctness rests on
the authoritative-settle state machine (#1261). Each projection merge returns a
disposition distinguishing at least:

- `merged` — a displayed projection was written synchronously (settled now);
- `cold-absent-vacuous` — **no active projection reader / the target row is not
  in cache** (`null`, settled vacuously — must NOT refetch);
- `pending-fallback` — the projection **is active** but the frame carried no
  usable patch, OR the patch is unmergeable → refetch Promise (settles on
  commit). **An active projection with a missing/expected patch is NEVER vacuous**
  (Cindy clarification): vacuously settling it would let the floor advance over a
  real update the client never applied;
- `rejected` — fallback refetch failed → **pins the floor**.

The distinction `patch absent ≠ projection absent` is load-bearing: `vacuous`
requires the *projection* to be absent (no reader / not cached), not merely the
*patch* to be absent.

These map onto the existing `Promise.allSettled` join in the ingestor
(`conversation-ingestor.ts:621-627`). Norman owns the concrete type shape;
backend only guarantees "the frame carries an invariant absolute value keyed by
projection."

## 8. Phasing (de-risk + early proof)

- **P1 — reply_count.** Simplest: invariant, single-row, no insert. Proves the
  whole skeleton end-to-end (backend in-tx delta → wire → registry → 4-state
  settle → floor). First proof point / falsifier: dogfood a rapid reply burst on
  an open thread-root and confirm zero `threadRootKey` refetches while the count
  stays authoritative across a restart replay.
- **P2 — threads_list_entry (merge + reposition only).** The real amplification
  kill for the hot path (reply to an in-page root, §6). Requires the additive
  `root_seq` DTO field. **No insert** — an off-page root falls back to refetch.
  Ship only after P1's settle machine is proven.
- **P2.5 — off-page insert (deferred).** Insert of a not-in-page root needs a
  per-viewer `viewer_following` source (a `viewer:{userId}` side patch carrying
  the full row, or a client-held authoritative source). Out of P2 v1 scope.
- **P3 — followers.** Deferred. `viewer_following` is per-viewer (§3), and it's a
  small conditional refetch. Revisit only if profiling justifies; at most carry
  an invariant follower *count*, never the per-viewer follow state.

## 9. Scope boundaries (deliberately narrow)

- **`snapshot_required` cold recovery stays refetch reconcile** (rare; the
  amplification there is acceptable). S1 optimizes only the live/normal path.
- **No follow/unfollow explicit-action path** — it has its own event flow; S1
  only treats message-frame-induced derived changes.
- **#1260 InterestRegistry is orthogonal** (a bandwidth axis, not correctness) —
  not mixed into this contract.

## 10. Correctness gates (Cindy) — mapped

1. same-tx / same-snapshot compute, no future-seq value → §4.
2. viewer-invariant-only on the broadcast frame → §3, enforced by scope model.
3. threads-list is not a naive upsert: P2 v1 merges + repositions in-page rows by
   a documented keyset (no second sort source), and does **no insert** — off-page
   roots fall back → §6.
4. followers minimal / no permission-sensitive broadcast → §5, §8 (deferred).
5. registry keeps the 4-state disposition, not a boolean → §7.
6. patch↔message correlation: patch-validity gated on
   `patch.root_id === msg.thread_root_id`; a divergent (or null-root) patch is
   discarded, not merged — fallback runs for the message's real root. The gate
   covers BOTH fallback-suppression AND registry dispatch → §2 #5. Regression:
   active mainline/thread-root holds rootA, frame message is rootA's reply but
   `projection.root_id = rootB` ⇒ rootA takes the invalidate fallback,
   `markSatisfied` awaits the refetch commit, rootB is NOT merged.

## 11. Risks / open

- **`root_seq` additive DTO change**: `ThreadSummary` gains `root_seq` (already
  computed at `message-repo.ts:552`, currently dropped at 614-628). Additive and
  viewer-invariant; must be exposed before P2 so the client can apply the
  documented keyset. Verify no consumer assumes the current field set exhaustively.
- **No insert in P2 v1** is a deliberate scope cut, not an oversight: off-page
  roots fall back to refetch (§6). Log/flag that P2 does not eliminate the
  off-page-activity refetch — P2.5 does.
- **auto-follow on reply is per-viewer**: a reply auto-follows only the sender's
  viewer, so `viewer_following` changes are inherently per-viewer → confirms P3
  deferral and why off-page insert (which needs `viewer_following`) is P2.5.
- The `threadRootId` seam hint (`hooks.ts:698-703`) is finally consumed by the
  P1/P2 resolver; if P2 is descoped, keep the hint (P1 still uses it) — do not
  re-delete it.
