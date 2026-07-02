# Projection-level recovery (S1) — viewer unread badge projection patch — v1

**Status:** DRAFT for review (#task:1283). Doc-first: this contract is reviewed
before code (Cindy's process gate). Derived from the refetch census (#task:1282)
and Cindy's contract-tightening review (2026-07-02).
**Owners:** Alice — backend payload enrich + frame contract + this doc. Norman —
renderer viewer-scope patch dispatcher + badge consumption. Cindy — correctness
gate.

Related: `docs/projection-recovery-s1-v1.md` (S1 P1/P2 on the *conversation*
scope — reply_count / threads_list), `docs/renderer-event-ingestion-v1.md`
(#1261 satisfaction model), `docs/event-ws-transport-v1.md` (three-state
cursor). This is the **next S1 phase**, on a **different transport scope**
(`viewer:<id>`, not `conversation:<id>`) and a **different projection family**
(unread badges, not message-derived lists).

---

## 0. TL;DR

Today the **highest-frequency** viewer-scope frame, `unread_updated`, carries
only `{ conversation_id }` — no count. Every consumer must therefore
**invalidate → whole-list refetch** to learn the new number. Three consumers do
this: the workspace channel-badge query, the global message-unread summary, and
the favorites list. This phase attaches the **authoritative absolute unread
counts** (per read-model boundary) to the same frame, and the client
**idempotently writes the absolute value** into the displayed badge caches.
Absence is **not** a refetch condition (a sparse-map key absence == 0, a
whole-query absence == no-op / cold-start on next mount, a favorites row absence
== no-op — §6). The existing invalidate→refetch path is retained **only** for a
legacy / malformed payload or an un-migrated old consumer.

- Authority never moves — the backend stays the sole computer of unread, from
  the **same canonical read model** (`ConversationReadRepo`) the REST queries use.
- The client never aggregates — it writes backend-sent absolute values by key.
  No client-side delta, no client-side workspace rollup (that would be a second
  read model — Cindy #1/#2).
- Absolute values cover **arrival / read / clear** in one payload shape and one
  merge (Cindy #4).
- This frame is already **per-viewer** (`viewer:<id>`), so per-viewer counts ride
  it with **no broadcast-invariant obstacle** — the barrier that deferred S1 P3
  (followers, on the broadcast `conversation:<id>` scope) does not exist here.

## 1. What this replaces (grounded)

| consumer | current effect | site |
|---|---|---|
| Activity global list | `invalidateQueries(['activity','all'])` → refetch whole list | `attention/hooks.ts:147` |
| message-unread summary (sidebar per-channel + global badges) | `invalidateMessageUnreadQueries` → refetch every `…message-unread` query + `['message-unread','summary']` (debounced 100ms) | `channels/hooks.ts:184` |
| favorites list (starred rail, per-row unread badge) | `invalidateQueries(favoritesKey)` → refetch whole list (not debounced) | `favorites/hooks.ts:81` |

Activity is **excluded** from this phase (see §7): it is a salience-sorted,
`enter()`-filtered list where a new unread changes list **membership + order**,
not a badge value — that is the P2.5 off-page-insert class, not a badge patch.

## 2. The three granularities (why one count is not enough — Cindy #1)

The consumers read **three different read-model shapes**, confirmed by source:

| shape | key granularity | fields | file |
|---|---|---|---|
| `MessageUnreadByConversationDto` | per **conversation** (within a workspace) | `by_conversation`, `latest_by_conversation` (pointer), `total` (ws rollup) | `shared/src/api/message.ts:256` |
| `MessageUnreadSummaryDto` | per **workspace** | `by_workspace` | `shared/src/api/message.ts:265` |
| `FavoriteRowDto.unread_count` | per **workspace** rollup (same canonical source as the home badge) | `unread_count` | `shared/src/api/favorites.ts:99` |

A single `conversation_unread_count` patches only `by_conversation`. To patch
`total` / `by_workspace` / favorites the client would have to push a delta or
re-roll the workspace sum locally — **reconstructing a second read model**. And
`latest_by_conversation` is a **pointer** (message_id / seq / thread_root_id),
not derivable from any count. So the frame must carry authoritative absolute
values at **each read-model boundary it touches**, never make the renderer
derive.

## 3. Non-negotiable invariants (铁律)

1. **Backend is the sole authority.** Counts come from `ConversationReadRepo`
   (the same read model REST serves), computed per viewer at emit. The client
   caches / displays / idempotently writes; it never derives truth locally.
2. **All patched values are absolute** (`conversation_unread_count = N`,
   `workspace_unread_count = M`, full pointer or null) — never a delta, never a
   client-side rollup. Absolute writes are replay-idempotent; deltas
   double-count on replay (the #1263 falsifier, same reason as P1/P2).
3. **One shape covers increment / decrement / clear** (Cindy #4) — **at the
   payload layer**. Arrival raises, `observe`/read lowers or zeroes — all are
   "the frame carries this authoritative absolute value". No half-model where
   arrival patches but read refetches. **But the merge landing diverges by cache
   shape** (Norman): on a **sparse map**, clear (`== 0`) = **delete key**; on a
   **favorites row**, clear = **write 0** (the row persists). Same payload, two
   correct merges — so equivalence to a refetch is a **structural** property, not
   a numeric one (see §8 dogfood).
4. **Per-read-model-boundary absolutes, no client aggregation** (Cindy #1/#2).
5. **Message variant only.** The badge/notification variant (`unread_updated`
   with **no** `conversation_id`) is untouched; Activity/notification badge paths
   must not consume the new fields (Cindy #3).
6. **Floor / cursor untouched.** `unread_updated` is a viewer-scope frame and is
   **not** on the message-stream resume floor (that floor is the
   conversation-scope content seam). This phase adds no cursor semantics.

## 4. Wire contract (backend — Alice)

The `unread_updated` **message variant** payload gains authoritative absolutes:

```ts
// message.ts — the message variant of the unread_updated frame payload.
// (The badge variant stays {} — no conversation_id, unchanged.)
export const UnreadUpdatedMessagePayloadSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  // Authoritative ABSOLUTE unread for THIS viewer, at each read-model boundary
  // a consumer keys on. Never a delta.
  conversation_unread_count: z.number(),   // → by_conversation[conversation_id]
  workspace_unread_count: z.number(),      // → by_workspace[workspace_id], total, favorites row
  // LATEST-unread POINTER (not a count; not "first"). The read model is
  // `latestUnreadForConversation` (`ORDER BY m.seq DESC LIMIT 1`), surfaced in
  // REST as `latest_by_conversation`. Present → authoritative; the
  // by_conversation query's latest_by_conversation[conversation_id] is written
  // absolutely. null → this conversation has no unread (cleared → delete key).
  latest_unread: MessageUnreadPointerDtoSchema.nullable(),
});
```

- **Additive / back-compat.** Existing consumers that ignore the new fields keep
  the invalidate→refetch fallback (same additive discipline as S1 P1). New
  consumers key off the absolutes.
- **`workspace_id`** lets the workspace-rollup consumers (`by_workspace`, `total`,
  favorites) locate their row without a second lookup.
- **Pointer decision (Cindy #2).** We carry `latest_unread` authoritatively so
  the `by_conversation` query's `latest_by_conversation` is patched, not guessed.
  If a future variant omits it, that query alone falls back to refetch — the
  renderer never invents the latest-unread pointer. (v1: always carry it; it is
  one indexed read, `latestUnreadForConversation`, already on the read path.)

## 5. Emit-side design (both paths, grounded)

Both existing emit paths carry the same enriched payload; both reuse
`ConversationReadRepo` — **no new aggregation, no new read model**:

| read-model need | method | file |
|---|---|---|
| `conversation_unread_count` | `unreadCountForConversation(convId, viewerId)` | `conversation-read-repo.ts:302` |
| `latest_unread` | `latestUnreadForConversation(convId, viewerId)` (`ORDER BY m.seq DESC LIMIT 1`) | `conversation-read-repo.ts:317` |
| `workspace_unread_count` | **NEW** `unreadCountForWorkspace(wsId, viewerId)` — single-workspace rollup (see §10 B4) | `conversation-read-repo.ts` (to add) |

**Do NOT** source `workspace_unread_count` from `unreadCountsByWorkspace(viewer)`
(367) or `unreadCountsByWorkspaceSidebar(viewer)` (385): both scan **all**
workspaces and today only coincidentally agree (name-drift risk). The hot path
needs a single-conversation count + a **single**-workspace rollup + the pointer
— never an all-workspaces scan (Cindy B4 / cost gate).

**Arrival path** (`publishUnreadUpdatedToConversationViewers`,
`viewer-scope.ts:31`): currently computes **one** payload and loops it to every
viewer. Enrich moves the compute **inside** the per-viewer loop (counts are
per-viewer) — so it needs the `ConversationReadRepo` injected. `workspace_id`
comes from the conversation.

**Read path** (`observe.ts:255`): already per-viewer with the changed
conversation set — compute the absolutes for `input.viewerUserId` per changed
conversation. The badge variant (`{}`) is unchanged.

**Mention path** (`mention-cc.ts:278`): same message variant → same enrich.

### Pricing (honest — refines the census note)

The census said "one single-viewer × single-conversation recount". Precisely:

- **Arrival** fans to **every human member** of the conversation, so the cost is
  **K recounts per arrival** (K = human members), each = 1 conversation count
  (`unreadCountForConversation`) + 1 **single-workspace** rollup
  (`unreadCountForWorkspace`, §10 B4) + 1 pointer lookup
  (`latestUnreadForConversation`), all indexed `ConversationReadRepo` reads.
  **No all-workspaces scan** — a per-viewer all-ws rollup under K would let the
  backend amplification cancel the client win (Cindy cost gate). Cost is bounded
  by member count, not message volume.
- **Read** is 1 viewer × the changed-conversation set — already scoped.

Net: emit-time indexed reads replace, on the client, **whole-list refetches of
the summary + favorites on every unread change**. Win, but the K-per-arrival
factor is the real dependency to price, not a flat "one".

## 6. Consumer classification (renderer — Norman owns the dispatcher)

| consumer | cache key | write on message-variant frame |
|---|---|---|
| workspace channel badges | `['workspaces', wsId, kind, 'message-unread']` (`MessageUnreadByConversationDto`) | `by_conversation[cid]`: `conversation_unread_count > 0` → set, `== 0` → **delete** key; `latest_by_conversation[cid]`: `latest_unread` non-null → set, null → **delete**; `total` ← `workspace_unread_count` (absolute, written directly — never re-summed from the sparse `by_conversation`) |
| global summary | `['message-unread','summary']` (`MessageUnreadSummaryDto`) | `by_workspace[wsId]`: `workspace_unread_count > 0` → set, `== 0` → **delete** key |
| favorites | `favoritesKey` | matching row's `unread_count ← workspace_unread_count` (write 0 as 0); **no matching row → no-op** |

**Disposition (Cindy B2 / B3 — sparse-map semantics, corrected).** These are two
*different* membership models, so the "no-insert" rule from S1 P2 does **not**
apply uniformly:

- **Sparse maps** (`by_conversation`, `by_workspace`): REST builds them by
  GROUP-BY over rows with unread > 0, so **absent key ⟺ 0 unread**, NOT "not
  loaded". The map is a *complete* read model whose key membership is
  authoritatively given by the frame's `conversation_id` / `workspace_id`.
  Therefore **inserting/deleting a key is legal and required**: `> 0` sets the
  key, `== 0` deletes it. This is *not* the P2.5 list-insert (which invents list
  membership / order the server owns) — a map key is authoritative payload data.
  - If the **whole query is not loaded** (no cache entry) → **no-op** (it
    cold-starts authoritatively on next mount), never a forced refetch.
- **Favorites list** (row membership): a row exists **iff** the entity is
  starred, and starring is **independent of unread**. So: row present → write its
  `unread_count` (0 too); **row absent → no-op** (nothing is starred to update);
  query not loaded → no-op. **Never refetch on a missing row** — that would turn
  a badge-number change back into a whole-list refetch (Cindy B3). No-insert
  holds *here* (don't fabricate a favorites row).

**Single dispatch (Norman #2 / #1269 lesson).** All three consumers read the one
frame → a **single viewer-scope patch dispatcher** validates the frame once and
fans to each present projection, exactly as the #1270 message-row seam does for
conversation scope. Do **not** wire three independent `onWsFrame` handlers (the
#1269 "handler forgot a projection dimension → live patch dropped" trap).
**Note (mechanism, not the same seam):** #1270's seam patches *message rows* in
*conversation-scope* caches; this patches *badge/list caches* keyed by
conversation/workspace on the *viewer* scope — same **pattern** (validate-once →
per-projection disposition), a **new small dispatcher**, not a literal reuse.

## 7. Scope boundaries (deliberately narrow)

- **Activity list excluded.** It is list membership + salience order, not a badge
  number (Cindy #5). Reusing this payload to mutate the Activity list locally
  would re-derive ordering the server owns — that is the P2.5 off-page-insert
  class, deferred.
- **Badge variant untouched.** No `conversation_id` → notification-badge path,
  no new fields consumed there (Cindy #3).
- **No cursor / floor change** (§3.6).
- **Seed builds the boundary, this cut does not migrate** (Norman guardrail).
  The viewer-scope dispatcher is introduced here but **wires only
  `unread_updated`** and solves only the summary + favorites badges. The other
  scattered viewer-scope `onWsFrame` consumers (`notification`, `saved_changed`,
  `viewer_workspaces_changed`) stay where they are, with an **explicit
  future-convergence TODO** — the seed is structured so they can fold in later,
  but folding them is **not** in this cut (it would balloon the seed into a
  viewer-scope refactor). Endgame (one viewer-scope ingestor, views as pure
  readers) is the direction; this cut only seeds it.
- **Per-thread unread** (`ConversationStreamUnreadDto`, mainline/threads split)
  is **out of v1** — it is a separate read model on a separate query; if wanted,
  a later phase carries `thread_root_id` + a per-cluster absolute, same pattern.

## 8. Phasing / first proof

- **P-a (backend):** enrich the message variant on all three emit paths; add the
  frame contract in `shared`. Ship additive (consumers still on fallback).
- **P-b (renderer):** the viewer-scope dispatcher + the two badge consumers
  (message-unread summary + favorites) — the first-proof surfaces.
- **First proof (dogfood):** open the app with a starred channel + sidebar
  badges; have another member post to a channel; verify the summary badge and
  favorites badge update with **zero** `['…message-unread']` / `favoritesKey`
  refetch (queryFn `console.log` ground-truth instrument — **not** Electron
  DevTools Network, which only shows event-WS). Then read the channel; verify the
  badge zeroes via the **same** patch path (no refetch) — proves the one-shape
  arrival/read/clear invariant (§3.3).
- **Structural equivalence (Norman), not numeric.** On clear, assert the cleared
  conversation's key is **absent** from `by_conversation` / `by_workspace` after
  the patch (delete-key), matching a refetch — a set-0-instead-of-delete would
  leave a ghost key that silently diverges from the refetched shape. Compare
  patched map ≡ refetched map (deep), not just the visible badge number. For
  favorites, assert the row's `unread_count === 0` (row persists).
- **Absence proof (structural, not a refetch — Cindy).** Absence never triggers
  a refetch:
  - **whole query unloaded** → no-op; it cold-starts authoritatively via REST on
    next mount;
  - **sparse map loaded, key absent** → `count > 0` inserts the key, `count == 0`
    leaves it absent (or deletes, idempotent) — no refetch;
  - **favorites missing row** → no-op (membership is starring, not unread);
  - the existing invalidate→refetch path fires **only** for a legacy / malformed
    payload or a frame with no enriched fields (un-migrated consumer).

## 9. Correctness gates (Cindy) — mapped

1. **Three granularities** → §2 + §4: absolute values at each read-model
   boundary (`conversation_unread_count` + `workspace_unread_count` + pointer);
   no client rollup.
2. **Payload by read-model boundary, not renderer-derived** → §4 fields; pointer
   carried authoritatively or that path fallbacks (§4 pointer decision).
3. **Two variants stay clean** → §3.5 / §7: new fields on message variant only.
4. **arrival / read / clear one shape** → §3.3: absolute value expresses all
   three; §5 read path emits the same payload.
5. **Activity excluded** → §7.

## 10. Blocker resolutions (Cindy review 2026-07-02) + open

**B1 — pointer is LATEST, not first.** Fixed throughout: the field `latest_unread`
maps to `latestUnreadForConversation` (`ORDER BY m.seq DESC LIMIT 1`, repo:317) /
REST `latest_by_conversation`. No `firstUnreadForConversation` exists (§4/§5).

**B2 — sparse-map absent ⟺ 0, insert legal.** §6 disposition rewritten: maps are
complete read models keyed authoritatively by the payload; `> 0` sets, `== 0`
deletes; whole-query-unloaded → no-op (not refetch). Map key insert ≠ P2.5 list
insert.

**B3 — favorites no-op on missing row.** §6: favorites membership is starring,
independent of unread; missing row → no-op, never refetch.

**B4 — single-workspace rollup, single-point + test (REQUIRED, not minor).** Add
`unreadCountForWorkspace(wsId, viewerId)` to `ConversationReadRepo`: one
`COUNT(m.id) … WHERE c.workspace_id=@ws AND cu.user_id=@viewer AND ROLLUP_UNREAD`
(mirrors `unreadCountsByWorkspace`'s per-row body without the all-ws GROUP BY).
**Lock equivalence by test**: for a given (viewer, workspace),
`unreadCountForWorkspace == unreadCountsByWorkspace(viewer)[ws] ==
unreadCountsByWorkspaceSidebar(viewer)[ws]` — so the emitted
`workspace_unread_count` is provably the same authoritative value the summary
route and the favorites row serve (defeats the name-drift, satisfies "one
authoritative value solves #1/#2"). The hot path calls only the single-ws helper.

**Open:**
- **`total` semantics** — `MessageUnreadByConversationDto.total` is the workspace
  rollup (repo:284 sums `by_conversation` for that one workspace); it equals
  `unreadCountForWorkspace(wsId, viewer)` by construction, so writing
  `total ← workspace_unread_count` is exact. Confirmed against repo:263-296.
- **K-per-arrival recount** (§5) — bounded by human member count; acceptable v1,
  revisit for many-human channels.
