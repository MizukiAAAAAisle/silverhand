# Projection-level recovery (S1) — viewer unread badge projection patch

Contract for the *viewer-scope* unread-badge recovery path: the backend attaches
authoritative absolute unread counts to the `unread_updated` message-variant
frame; the client idempotently writes the absolute value into the badge caches.

Related: `docs/projection-recovery-s1-v1.md` (S1 on the *conversation* scope —
reply_count / threads_list), `docs/event-ws-transport-v1.md` (three-state
cursor). This is a **different transport scope** (`viewer:<id>`, not
`conversation:<id>`) and a **different projection family** (unread badges, not
message-derived lists).

---

## 0. TL;DR

The **highest-frequency** viewer-scope frame, `unread_updated` (message
variant), carries the **authoritative absolute unread counts** (per read-model
boundary) alongside `{ conversation_id, workspace_id }`. A **single**
viewer-scope dispatcher validates the frame once and fans the absolute values
into the displayed badge caches, which **idempotently write the absolute value**
in place — never invalidate→whole-list refetch. Three projections are patched:
the workspace channel-badge query, the global message-unread summary, and the
favorites list. Absence is **not** a refetch condition (a sparse-map key absence
== 0, a whole-query absence == no-op / cold-start on next mount, a favorites row
absence == no-op — §6). Invalidate→refetch fires **only** for a legacy /
malformed payload (a pre-enrichment backend or field-shape mismatch).

- Authority never moves — the backend stays the sole computer of unread, from
  the **same canonical read model** (`ConversationReadRepo`) the REST queries use.
- The client never aggregates — it writes backend-sent absolute values by key.
  No client-side delta, no client-side workspace rollup (that would be a second
  read model).
- Absolute values cover **arrival / read / clear** in one payload shape and one
  merge.
- This frame is already **per-viewer** (`viewer:<id>`), so per-viewer counts ride
  it with **no broadcast-invariant obstacle** — the barrier that deferred
  followers (on the broadcast `conversation:<id>` scope) does not exist here.

## 1. Activity is excluded

Activity is **excluded** from this patch path (see §7): it is a salience-sorted,
`enter()`-filtered list where a new unread changes list **membership + order**,
not a badge value — that is the off-page-insert class, not a badge patch.

## 2. The three granularities (why one count is not enough)

The consumers read **three different read-model shapes**:

| shape | key granularity | fields |
|---|---|---|
| `MessageUnreadByConversationDto` | per **conversation** (within a workspace) | `by_conversation`, `latest_by_conversation` (pointer), `total` (ws rollup) |
| `MessageUnreadSummaryDto` | per **workspace** | `by_workspace` |
| `FavoriteRowDto.unread_count` | per **workspace** rollup (same canonical source as the home badge) | `unread_count` |

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
   double-count on replay (the delta-double-count falsifier, same reason as the
   conversation-scope S1).
3. **One shape covers increment / decrement / clear** — **at the
   payload layer**. Arrival raises, `observe`/read lowers or zeroes — all are
   "the frame carries this authoritative absolute value". No half-model where
   arrival patches but read refetches. **But the merge landing diverges by cache
   shape**: on a **sparse map**, clear (`== 0`) = **delete key**; on a
   **favorites row**, clear = **write 0** (the row persists). Same payload, two
   correct merges — so equivalence to a refetch is a **structural** property, not
   a numeric one (see §8).
4. **Per-read-model-boundary absolutes, no client aggregation.**
5. **Message variant only.** The badge/notification variant (`unread_updated`
   with **no** `conversation_id`) is untouched; Activity/notification badge paths
   must not consume the new fields.
6. **Floor / cursor untouched.** `unread_updated` is a viewer-scope frame and is
   **not** on the message-stream resume floor (that floor is the
   conversation-scope content seam). This frame carries no cursor semantics.

## 4. Wire contract (backend)

The `unread_updated` **message variant** payload carries authoritative absolutes:

```ts
// The message variant of the unread_updated frame payload.
// (The badge variant stays {} — no conversation_id, unchanged.)
export const UnreadUpdatedMessagePayloadSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  // Authoritative ABSOLUTE unread for THIS viewer, at each read-model boundary
  // a consumer keys on. Never a delta.
  conversation_unread_count: z.number(),   // → by_conversation[conversation_id]
  workspace_unread_count: z.number(),      // → by_workspace[workspace_id], total, favorites row
  // LATEST-unread POINTER (not a count; not "first") for this conversation,
  // surfaced in REST as `latest_by_conversation`. Present → authoritative; the
  // by_conversation query's latest_by_conversation[conversation_id] is written
  // absolutely. null → this conversation has no unread (cleared → delete key).
  latest_unread: MessageUnreadPointerDtoSchema.nullable(),
});
```

- **Additive / back-compat.** A consumer that ignores the new fields falls back
  to invalidate→refetch (the same additive discipline as the conversation-scope
  S1). Present consumers key off the absolutes.
- **`workspace_id`** lets the workspace-rollup consumers (`by_workspace`, `total`,
  favorites) locate their row without a second lookup.
- **Pointer decision.** We carry `latest_unread` authoritatively so
  the `by_conversation` query's `latest_by_conversation` is patched, not guessed.
  If a future variant omits it, that query alone falls back to refetch — the
  renderer never invents the latest-unread pointer. (v1: always carry it; it is
  one indexed read already on the read path.)

## 5. Emit-side design (both paths, grounded)

Both emit paths carry the same enriched payload; both reuse the canonical
`ConversationReadRepo` read model — **no separate aggregation, no second read
model**. The three authoritative values come from that repo:

- `conversation_unread_count` — the single-conversation unread count for the
  viewer;
- `latest_unread` — the latest-unread pointer for the conversation (`ORDER BY
  m.seq DESC LIMIT 1`);
- `workspace_unread_count` — the **single-workspace** rollup for the viewer (see
  §9).

**Do NOT** source `workspace_unread_count` from an all-workspaces rollup: the
all-ws variants scan **every** workspace and only coincidentally agree with the
single-ws value (name-drift risk). The hot path needs a single-conversation
count + a **single**-workspace rollup + the pointer — never an all-workspaces
scan (cost gate).

**Arrival path** computes the payload **inside** the per-viewer loop (counts are
per-viewer), reusing the injected `ConversationReadRepo`; `workspace_id` comes
from the conversation.

**Read path** (`observe`) is already per-viewer with the changed-conversation
set — it computes the absolutes for the viewer per changed conversation. The
badge variant (`{}`) is unchanged.

**Mention path** uses the same message variant → same enrich.

### Pricing

- **Arrival** fans to **every human member** of the conversation, so the cost is
  **K recounts per arrival** (K = human members), each = 1 conversation count +
  1 **single-workspace** rollup (§9) + 1 pointer lookup, all indexed
  `ConversationReadRepo` reads. **No all-workspaces scan** — a per-viewer all-ws
  rollup under K would let the backend amplification cancel the client win (cost
  gate). Cost is bounded by member count, not message volume.
- **Read** is 1 viewer × the changed-conversation set — already scoped.

Net: emit-time indexed reads replace, on the client, **whole-list refetches of
the summary + favorites on every unread change**. The K-per-arrival factor is the
real dependency to price, not a flat "one".

## 6. Consumer classification

Three projections consume the one message-variant frame, each writing the
absolute value at its own read-model boundary:

- **Workspace channel badges** (`MessageUnreadByConversationDto`):
  `by_conversation[cid]` — `conversation_unread_count > 0` → set, `== 0` →
  **delete** key; `latest_by_conversation[cid]` — `latest_unread` non-null →
  set, null → **delete**; `total` ← `workspace_unread_count` (absolute, written
  directly — never re-summed from the sparse `by_conversation`).
- **Global summary** (`MessageUnreadSummaryDto`): `by_workspace[wsId]` —
  `workspace_unread_count > 0` → set, `== 0` → **delete** key.
- **Favorites** (`FavoriteRowDto`): matching row's `unread_count ←
  workspace_unread_count` (write 0 as 0); **no matching row → no-op**.

**Disposition — sparse-map semantics.** These are two
*different* membership models, so the "no-insert" rule from the conversation-scope
S1 threads_list does **not** apply uniformly:

- **Sparse maps** (`by_conversation`, `by_workspace`): REST builds them by
  GROUP-BY over rows with unread > 0, so **absent key ⟺ 0 unread**, NOT "not
  loaded". The map is a *complete* read model whose key membership is
  authoritatively given by the frame's `conversation_id` / `workspace_id`.
  Therefore **inserting/deleting a key is legal and required**: `> 0` sets the
  key, `== 0` deletes it. This is *not* the list-insert (which invents list
  membership / order the server owns) — a map key is authoritative payload data.
  - If the **whole query is not loaded** (no cache entry) → **no-op** (it
    cold-starts authoritatively on next mount), never a forced refetch.
- **Favorites list** (row membership): a row exists **iff** the entity is
  starred, and starring is **independent of unread**. So: row present → write its
  `unread_count` (0 too); **row absent → no-op** (nothing is starred to update);
  query not loaded → no-op. **Never refetch on a missing row** — that would turn
  a badge-number change back into a whole-list refetch. No-insert
  holds *here* (don't fabricate a favorites row).

**Single dispatch.** All three consumers read the one
frame → a **single viewer-scope patch dispatcher** validates the frame once and
fans to each present projection, exactly as the message-row seam does for
conversation scope. Do **not** wire three independent `onWsFrame` handlers (the
"handler forgot a projection dimension → live patch dropped" trap).
**Note (mechanism, not the same seam):** the message-row seam patches *message rows* in
*conversation-scope* caches; this patches *badge/list caches* keyed by
conversation/workspace on the *viewer* scope — same **pattern** (validate-once →
per-projection disposition), a distinct small dispatcher, not a literal reuse.

## 7. Scope boundaries (deliberately narrow)

- **Activity list excluded.** It is list membership + salience order, not a badge
  number. This payload does not mutate the Activity list — doing so would
  re-derive ordering the server owns (the off-page-insert class).
- **Badge variant untouched.** No `conversation_id` → notification-badge path,
  no new fields consumed there.
- **No cursor / floor change** (§3 invariant 6).
- **The viewer-scope dispatcher wires only `unread_updated`** and solves only the
  summary + favorites badges. The other scattered viewer-scope `onWsFrame`
  consumers (`notification`, `saved_changed`, `viewer_workspaces_changed`) keep
  their own handlers; they are not folded into this dispatcher.
- **Per-thread unread** (`ConversationStreamUnreadDto`, mainline/threads split)
  is **not part of this patch contract** — it is a separate read model on a
  separate query.

## 8. Merge-equivalence and absence semantics (load-bearing)

- **Structural equivalence, not numeric.** On clear, the cleared
  conversation's key must be **absent** from `by_conversation` / `by_workspace` after
  the patch (delete-key), matching a refetch — a set-0-instead-of-delete would
  leave a ghost key that silently diverges from the refetched shape. The
  correctness assertion is patched map ≡ refetched map (deep), not just the
  visible badge number. For favorites, the row's `unread_count === 0` (row
  persists).
- **Absence is structural, never a refetch.** Absence never triggers
  a refetch:
  - **whole query unloaded** → no-op; it cold-starts authoritatively via REST on
    next mount;
  - **sparse map loaded, key absent** → `count > 0` inserts the key, `count == 0`
    leaves it absent (or deletes, idempotent) — no refetch;
  - **favorites missing row** → no-op (membership is starring, not unread);
  - the existing invalidate→refetch path fires **only** for a legacy / malformed
    payload or a frame with no enriched fields (un-migrated consumer).

## 9. Single-workspace rollup + `total`

- **Single-workspace rollup helper.** A single-workspace unread rollup on
  `ConversationReadRepo` counts unread for one `(viewer, workspace)` pair
  (mirroring the all-ws rollup's per-row body without the all-ws GROUP BY).
  **Equivalence is locked by test**: for a given (viewer, workspace), the
  single-workspace rollup equals the per-workspace value produced by both
  all-workspaces rollups — so the emitted `workspace_unread_count` is provably
  the same authoritative value the summary route and the favorites row serve
  (defeats name-drift). The hot path calls only the single-ws helper — never an
  all-workspaces scan.
- **`total` semantics.** `MessageUnreadByConversationDto.total` is the workspace
  rollup (sum of `by_conversation` for that one workspace); it equals the
  single-workspace rollup by construction, so writing `total ←
  workspace_unread_count` is exact.
- **K-per-arrival recount** (§5) — bounded by human member count; acceptable,
  revisit for many-human channels.
