# List sort v1 — per-user workspace rail & channel sidebar ordering

Status: backend landed (#task:1147); renderer (#task:1146, Norman) consumes this
contract. Design converged with @Cindy (review) + @Norman (renderer) and
approved by shiki 2026-06-16.

**Revision — pin → personal star (#task:1209, 2026-06-24, shiki-approved).** The
hard-top group flipped from a SHARED admin-gated **pin** to a per-viewer
personal **star**. This is a deliberate model revision, not a typo fix: pin was a
shared aggregate field on the workspace / conversation (`pinned_at`, admin-gated,
one value for everyone — documented as such in the original L57); it is now
per-viewer view state (`user_sort_entry.starred_at`), gated by **can-view**, in
the same viewer-scoped read model as rank / recent. The old global `pinned_at`
columns become **vestigial** (no data seed — decided by shiki: few users, a
one-time re-star is cheaper than carrying migration dirty-code as debt; the
columns physically remain because migrations are append-only, but are never
read/written). Ubiquitous language: **Star / Starred ⭐** = the personal axis;
**Pin / Pinned 📌** is reserved for a future SHARED concept, kept distinct so the
two never alias. Group keys flipped `pinned→starred` / `unpinned→unstarred`. The
sections below are updated in place to describe the as-built star model; "pin"
survives only where this note explains the migration.

## Model

Ordering is **personal view state**, not an aggregate field — "how THIS viewer
arranged the list". It never lives on the workspace / conversation aggregate; it
is its own viewer-scoped read model with its own tables. The **backend persists
preferences and exposes them; it does not order**. The renderer composes the
final order with a pure helper.

Two concerns, two scopes:

- **mode** — per *scope* (#task:1146). A scope is one independently toggleable
  `[recent | manual]` axis. Default `recent` (recently-**opened** by this
  viewer). A manual reorder (drag) also switches that scope to `manual`
  atomically (`order ⟹ manual`, see API), so drag works from any mode. How many
  scopes a list has depends on the list kind (see hard groups below):
  - **workspace rail** — mode is **per hard-group**: the `dm` and `regular`
    sections each carry their own toggle. Scope = the group key. Star is NOT a
    rail group (it is the global Favorites overlay, #task:1252), so it has no rail
    mode scope.
  - **channel sidebar** — mode is **list-wide** (one toggle for the whole list),
    unchanged. Scope = the sentinel `''`.
- **per-entity state** — `rank` (manual order) + `last_accessed_at`
  (recent-opened), per entity per list. **Not** keyed by group/scope — a single
  value per `(user, list, entity)`; grouping is a sort-time partition.

`list_key` namespaces a list:

- `workspaces` — the workspace rail (one per viewer).
- `channels:<ws_id>` — one workspace's channel sidebar.

### "Recently used" = recently **opened**, not recently **active**

Recent order is driven by the viewer's own open/select action, **not** by message
activity. In an agent-heavy product, autonomous agent messages perturb activity
constantly — activity ≠ the viewer's usage. So `last_accessed_at` is stamped only
on selection (see touch discipline), never on message arrival / unread change /
archive restore.

### Single-value rank, live hard-grouping

`rank` is a **single value** per `(user, list, entity)`. Hard groups are
partitioned **live at sort time** from the viewer's own star state — never
baked into a storage bucket key. This keeps star/unstar from having to migrate
ranks across buckets.

Hard groups (sort-time partition; manual drag is within a group, never across).
The two lists partition on **different axes**:

- workspace rail: `dm` / `regular` — by **kind** only. **Star is NOT a rail
  group** (#task:1252): it is the global Favorites overlay (see *Favorites*), so
  a starred workspace OR DM stays in its kind group and is reorderable there. DM
  (agent_home) workspaces are starrable (`canStar = (regular || agent_home) &&
  !archived`) — star is per-viewer view state (`user_sort_entry.starred_at`),
  gated by can-view, never a shared aggregate field. Archived workspaces are out
  of sorting scope entirely.
- channel sidebar: `starred` / `unstarred`. Still hard-partitions by THIS
  viewer's star. Threads are out of sorting scope.

Crossing a star boundary **clears THIS viewer's manual rank** for the entity
(`SortRepo.setStarred`, same write) **only where the list partitions by star** —
the channel sidebar (`unstarred ↔ starred`), so the entity falls to the new
group's manual tail and the groups' dense rank numbering can't collide. The
**workspace rail does NOT partition by star**, so star/unstar there **preserves**
the entity's `dm`/`regular` rank — clearing it would silently corrupt the viewer's
manual order of that kind group (#task:1252). Star is personal, so any clear is
**scoped to the acting viewer** (the old global pin cleared all viewers' ranks via
the now-removed `clearEntityRank`).

### Renderer composition (pure helper)

`live partition (rail: agent_home→dm / regular→regular — by KIND only, star is
the Favorites overlay not a rail group; channel→star tier)` → within each group
by **that scope's** mode (`sortModeOf(state, group?)` — group omitted ⇒ scope
`''`):

- `recent` → `last_accessed_at DESC` (NULLs last).
- `manual` → `rank ASC` (NULLs last, then `created_at`, then id tiebreak).

`entries` is sparse (only entities with a rank or a last_accessed). An entity
absent from `entries` joins as both-null.

#### Drop-frame sync invariant (drag reorder)

The drag-reorder UI must hold one frame-level invariant, learned the hard way
via CDP (see `apps/desktop/.../ChannelsSidebar.tsx`). Code that conflicts with
it is the bug.

**Reorder in the same React commit as dnd's drag-reset.** On drop, dnd-kit
clears the active row's transform synchronously (frame N). If the new list order
is sourced from the React Query cache, the reorder lands a frame later (frame
N+1) — RQ's observer notify is microtask-batched — so for one frame the row snaps
back to its OLD slot, then jumps to the new one (CDP "B-type" desync). Fix:
`onDragEnd` sets a synchronous component-local override (`pendingDrop`) that
batches with dnd's reset into one commit; the cache write + mutation are **pure
persistence**, and the override self-clears once the cache catches up (≈1–2
frames). **Do NOT** drive the drop reorder from pure `setQueryData` or any
async-store notification — `flushSync` can't save it (nothing is pending to
flush), the desync just returns. This is a **position** invariant, independent of
color — it holds regardless of whether rows animate their colors.

> **Historical note — color-freeze apparatus removed (#task:1162).** Sidebar
> rows once carried a 150ms `transition-colors` hover-fade. That fade forced a
> second, color-level apparatus *only during drag* (`deriveRowFreeze` →
> `freezeColorTransition` all-rows + `freezeColorValue` siblings-only) to stop a
> row sliding under the cursor from flickering its hover bg at the drop frame,
> and the same fade caused a flicker on selection change. shiki cut the hover-fade
> outright — rows are now instant on hover **and** selection, since the affordance
> polish wasn't worth the structural cost (instant-hover sidebars are standard,
> cf. VS Code). So that whole color-freeze apparatus was **deleted**: with no row
> color transition, the drop color-flicker class is gone by construction, and only
> `pendingDrop` (the position invariant above) remains. **Re-introducing any row
> color transition would bring the color-freeze requirement back** — recover the
> removed apparatus from git history rather than re-deriving it.

#### Recent visible order is a frozen read model (#task:1161)

`recent` is an **MRU axis** (the ⌘Tab / editor-switcher family, *not* Slack/Discord
activity-order). The naive form — sort live by each row's `last_accessed_at` — has a
dogfood-fatal flaw: opening a row stamps its key (touch), the next `viewer_sort`
refetch lands the fresh key, and the row you just clicked reflows to the top **under
your pointer**. The MRU family's standard answer is a snapshot: freeze the order
during use, re-materialize only on re-entry.

So the visible recent order is composed as a **read model**, single-sourced in
`useListDragSort` (`lib/recent-order-snapshot.ts`):

- **Touch stays pure persistence.** `POST /api/sort/touch` writes `last_accessed_at`
  and nothing else — it never reorders the visible list. This is the same
  persistence-vs-presentation split as the `pendingDrop` drop override above.
- **Freeze the key, admit additions/removals.** Each id's recent sort key is frozen
  to its value at *entry*. An id that appears after entry (new / restored row) is
  **admitted and frozen on first sight**: it orders by its live key that frame
  (landing at its natural recent slot) *and* that key is written into the snapshot,
  so a later open of that row can't reflow it either. This is "admit and freeze",
  **not** "unknown id ⇒ forever live" — the latter just relocates the click-jump
  from entry-list rows to post-mount rows. Admission is **per-new-id**: never
  recapture the *whole* snapshot on a membership change — that re-freezes
  already-clicked rows at their bumped keys and reintroduces the original jump.
  Removed ids drop out. Manual scopes never consult the snapshot (rank-ordered).
- **Re-snapshot trigger is decoupled from selection/touch — load-bearing.** The
  snapshot recaptures *only* on `recentSnapshotToken` change: the list changes
  (`listKey`), or a scope toggles into/out of recent (the recent-scope set,
  order-independent), plus the first real load. The token **must not** encode
  `last_accessed_at` / entry values. Re-snapshotting *at the selection moment* would
  re-eat the just-written key and the jump returns — the decoupling **is** the fix.
- Captured synchronously in render via a ref compare (not an effect), so the first
  painted frame is already frozen — no live-then-freeze flash.

## Storage (migrations v47, v48, v50)

```sql
-- v47 created this table keyed (user_id, list_key); v48 adds `scope` to the key
-- so the rail can hold a per-section mode while channels stay list-wide.
CREATE TABLE user_list_sort_mode (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key   TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '',  -- '' = list-wide (channels); 'dm'|'regular' = a rail section
  mode       TEXT NOT NULL CHECK (mode IN ('recent', 'manual')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_key, scope)
);

CREATE TABLE user_sort_entry (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key         TEXT NOT NULL,
  entity_id        TEXT NOT NULL,   -- soft ref to workspaces|conversations by list_key (no FK, polymorphic)
  rank             INTEGER,         -- NULL = not manually arranged
  last_accessed_at INTEGER,         -- NULL = never opened
  starred_at       INTEGER,         -- v50: NULL = not starred; non-null = personal ⭐ (PRESENCE marker, not a sort key)
  PRIMARY KEY (user_id, list_key, entity_id)  -- NOT keyed by scope: rank/star are one value per entity, group is a live partition
);
```

The v48 rebuild folds every pre-existing mode row into `scope = ''`. Channel rows
were already list-wide (correct); any pre-existing `workspaces` row becomes a
harmless orphan at `''` (the rail now reads its modes at the group scopes, so it
falls back to the default `recent` — an accepted reset, since the rail's group
taxonomy changed in the same change). The v48 note still holds verbatim under the
#task:1209 rename: the rail's old `pinned` mode-scope rows become orphans and fall
back to `recent` (another accepted reset). #task:1252 removed the rail's star
mode-scope entirely — the rail's only scopes are now `dm` / `regular`, so any
stray rail star-scope row is likewise an orphan that resets to `recent`.

**v50 — `user_sort_entry.starred_at` (#task:1209).** Star is per-(user, list,
entity) view state, the same grain as `rank` / `last_accessed_at`, so it joins
this table rather than a new one (one cohesive "viewer's list view state"
aggregate). `SortRepo.setStarred` upserts it; in the same write it clears the
acting viewer's `rank` for that entity **only on the channel sidebar**
(`channels:<ws>`), where star crosses the `unstarred ↔ starred` boundary — on the
workspace rail (kind-partitioned; star = Favorites overlay, #task:1252) the rank
is **preserved**. **No seed:** the old global `workspaces.pinned_at` /
`conversations.pinned_at` columns are NOT migrated into per-user stars — they go
vestigial (still present, append-only; no longer read or written; stripped from
every DTO so they never reach the wire).

**`starred_at` is presence, not a sort key (#task:1209).** Non-null marks the
entity as starred (which hard group it partitions into, on the channel sidebar);
it does **not** order the `starred` group. Within-group order is governed by that
group's mode like every other hard group — `recent` → `last_accessed_at`,
`manual` → `rank` — and each channel-sidebar group carries the list's one
list-wide mode (the rail's `dm` / `regular` sections each carry their own). Letting
`starred_at` silently drive order would make that sort menu a lie and add a third
axis with undefined precedence vs recent/manual. The timestamp is retained only for
future/debug use (e.g. a possible explicit "recently starred" mode later), never
as an implicit override.

Orphan `user_sort_entry` rows after a delete / membership-removal / archive are
kept in storage but **filtered out of every wire response**: `getState` takes the
live **sortable** id set and drops any entry not in it. That set is the channel
list's active channels, the workspace rail's visible **non-archived** workspaces
(archived shows in its own rail group, never sorted), or `resolveListGroups`'s
live set for mutation responses. The storage keeps the orphan; the read model
never exposes a stale or out-of-scope entity_id.

## API (all viewer-scoped)

Read state is carried **inline** on the list responses — no separate GET:

- `GET /api/workspaces` → `{ workspaces, viewer_sort }`, `viewer_sort.list_key = 'workspaces'`.
- `GET /api/workspaces/:id/channels` → `{ channels, threads, viewer_sort }`,
  `viewer_sort.list_key = 'channels:<ws_id>'`.

`viewer_sort.modes` is a **per-scope map** (`Record<scope, 'recent'|'manual'>`,
sparse — an absent scope means `recent`). Channel lists carry the single scope
`''`; the rail carries up to `dm` / `regular` (star is the Favorites overlay, not
a rail scope). Read with the renderer helper `sortModeOf(state, group?)` — group
omitted ⇒ scope `''` (so channel call sites are unchanged), rail passes its
section group.

`viewer_sort.entries[]` carries the per-entity state `{ entity_id, rank,
last_accessed_at, starred_at }` (#task:1209). `starred_at` is the **only** source
of an entity's starred state — the entity DTOs no longer carry `pinned_at`, so the
renderer reads star straight off these entries (no fallback to any aggregate
field). On the **channel sidebar** `starred_at` drives the `starred|unstarred`
hard partition; on the **workspace rail** it does NOT partition (rail is `dm|regular`
by kind) — it only feeds the global Favorites overlay (#task:1252).

Mutations return the authoritative `{ viewer_sort }` for optimistic reconcile
(touch excepted):

- `PUT /api/sort/mode { list_key, group?, mode }` → `{ viewer_sort }`. Validates
  list scope (existence + visibility) like order/touch. `group` selects the mode
  scope: `list_key 'workspaces'` **requires** a legal rail group (`dm|regular`);
  `channels:<ws>` **forbids** `group` (list-wide, scope `''`). A
  mismatch is a 400 (don't guess).
- `PUT /api/sort/order { list_key, group, ordered_ids }` → `{ viewer_sort }`.
  `ordered_ids` must be **exactly** the live members of `group` (any order, no
  missing / extra / duplicate / cross-group id). `group` must be a legal hard
  group for the list kind (rail: `dm|regular`; channel:
  `starred|unstarred`) — an illegal group is rejected even with empty
  `ordered_ids`. The backend validates against live star/kind state and rejects
  otherwise (400) — a partial submission would leave other members' ranks stale
  and collide within the group, so it is not a patch. On success it rewrites
  dense ranks (0..n) for the group **and sets the relevant scope's mode to
  `manual` in the same transaction** — `order ⟹ manual` is an invariant. The
  scope a drag flips is derived from `list_key + group` exactly as `mode` is
  (rail: the dragged group; channel: `''`), so dragging the rail's `dm`
  section leaves the `regular` mode untouched, and a channel drag flips its
  one list-wide mode. The response's `viewer_sort.modes[scope]` comes back
  `manual`.
- `POST /api/sort/touch { list_key, entity_id }` → `{ ok: true }`. Idempotent
  upsert of `last_accessed_at`. Called **only on selection**. Renderer sends it
  fire-and-forget (non-blocking) and dedups/throttles per `(viewer, target)`;
  the upsert is idempotent as a backstop. **Persistence only** — it never reorders
  the visible recent list (see *Recent visible order is a frozen read model*).

Personal ⭐ star (#task:1209) — entity-scoped, can-view gated, viewer-scoped
write. Star is sort-context state, so these routes live in the sort app (not the
entity files), reusing `resolveListGroups` as the can-view + non-archived +
sortable gate. The old admin-gated `/pin` routes were **deleted** (no alias):

- `POST  /api/workspaces/:id/star` / `DELETE /api/workspaces/:id/star`
- `POST  /api/channels/:id/star`   / `DELETE /api/channels/:id/star`
  → all return the FULL `{ viewer_sort }` for the affected list (same shape
  mode/order return, never a single entry) so the renderer reconciles star
  alongside rank/mode in one state. `setStarred` also clears the acting viewer's
  rank for the entity (crosses a hard-group boundary). A target not in the live
  visible set ⇒ 404 (not found / archived); a list the viewer can't see ⇒ 403.

`ViewerSortStateDto = { list_key, modes: Record<scope, 'recent'|'manual'>, entries: { entity_id, rank, last_accessed_at, starred_at }[] }`
(exported from `@silverhand/shared`; `modes` is the per-scope map — sparse, absent
scope ⇒ default `recent`; channel lists use the single sentinel scope `''`).

## Favorites — the rail STARRED section as a global entry (#task:1252)

The left rail's `STARRED` section is the viewer's **global Favorites**: a flat
list that surfaces everything they have starred, regardless of which list the
star was set in. **Membership** is a read-side projection — the single
`user_sort_entry.starred_at` fact is the one source of star truth, UNIONed across
every home `list_key`; there is no "favorites membership" storage. **Ordering**,
by contrast, Favorites owns: a first-class viewer-scoped sort state under
`list_key='favorites'` (#task:1252 C — see *Sortable* below).

- `GET /api/favorites` → `ListFavoritesDto { items: FavoriteRowDto[], viewer_sort }`.
  Read-only, human viewer-scoped, **global** (no workspace filter, mirroring
  Activity). The backend does **not** pre-sort `items`; the renderer composes the
  order from `viewer_sort` with the shared list-sort helper, exactly like the rail
  / channel sidebar.
- **Sortable (#task:1252 C).** Favorites is a first-class sortable list reusing the
  whole `sort` bounded context, NOT the rail's old `workspaces`/`starred` scope
  (that one only ordered workspaces/DMs and made star a rail hard group). Its state
  lives under `list_key='favorites'`:
  - **flat, single group** `'favorites'` — sortable but not sub-partitioned;
  - **list-wide [recent | manual]** mode (scope `''`, like the channel sidebar) +
    **manual drag** reorder, via `PUT /api/sort/order|mode` with `list_key='favorites'`;
  - **`recent` = recently-OPENED**: it reads each entity's HOME-list
    `last_accessed_at` (so opening a workspace from the rail updates its Favorites
    recency too), NULLs last → `created_at` → `favorite_key`. **NOT** `starred_at`
    ("recently starred" would silently diverge from every other list's `recent`).
  - **`manual` = the favorites `rank`**, written by the reorder under `list_key='favorites'`.
  - This **reverses** the v1 "Favorites owns no storage" stance: storing per-viewer
    *ordering* (rank + the list-wide mode) is the explicit cost of C. It still stores
    no *membership* — `starred_at` in the home list remains the sole star truth.
- **`favorite_key = <kind>:<entity_id>`** (`workspace:`/`dm:`/`channel:`) is the
  list's stable sort identity: the renderer row/drag key, the reorder `ordered_ids`
  element, AND the `entity_id` under `user_sort_entry.list_key='favorites'` and the
  matching `viewer_sort.entries[].entity_id`. Kind-qualified — never a bare id — so
  the cross-kind flat list cannot collide a workspace with a channel, and a DM
  (kind `dm`) is distinct from a same-id regular workspace.
- `viewer_sort` (`list_key='favorites'`) carries the list-wide mode (`modes['']`)
  and one entry per `favorite_key` with the sort triple the renderer's
  `sortEntryLookup` reads: `rank` (from `favorites`) + `last_accessed_at` (from the
  entity's HOME list) + `starred_at` (home, the recent NULL tiebreak). The
  read-model **synthesizes** these — joining favorites-rank with home-last_accessed
  — so the renderer treats Favorites like any other list (no special-casing).
- Each row carries **server-resolved** display identity (Activity `preview_sender`
  precedent) so the renderer does **zero** local workspace/agent-cache join — a
  starred channel whose parent workspace is not loaded still renders a name +
  subtitle. Fields:
  `{ kind, favorite_key, entity_id, workspace_id, channel_id|null, title,
  workspace_name|null, icon_url|null, runtime|null, starred_at, created_at,
  unread_count|null }` (`unread_count` reserved, always `null` in v1; `entity_id`
  is the HOME id / unstar path param, distinct from the sort key `favorite_key`).
- **kind ⇒ source + unstar endpoint** (renderer never builds a `list_key`):
  - `workspace` — a starred `workspace_kind='regular'` workspace (`list_key='workspaces'`).
    Regular workspaces have no icon storage ⇒ `icon_url` always null ⇒ renderer
    monogram/`W`. Unstar: `DELETE /api/workspaces/:entity_id/star`.
  - `dm` — a starred `workspace_kind='agent_home'` workspace; `title`/`icon_url`/
    `runtime` resolved from the bound `owner_agent_id`. Unstar:
    `DELETE /api/workspaces/:entity_id/star`.
  - `channel` — a starred `conversations.kind='channel'` under a
    `workspace_kind='regular'` parent (`list_key='channels:<ws>'`); `workspace_name`
    = parent name (muted subtitle + same-name disambiguator). Unstar:
    `DELETE /api/channels/:entity_id/star`. **v1 narrows out `dm_channel` stars**:
    a DM surfaces only as a `dm` row, never twice; a `channels:<agent_home>` /
    `dm_channel` star is hidden (storage preserved), and mapping a DM *conversation*
    to a favorite is a separate future decision.
- **Membership contract** (read-model enforces; written here, not hidden in SQL):
  a row appears **iff the viewer can still access the entity AND it is not
  archived** — exactly the set the per-entity star endpoints accept, so Favorites
  membership ≡ the viewer's star-toggleable set (one source of truth). workspace/dm
  → `workspace_users` member ∧ `workspaces.archived_at IS NULL`; channel →
  `conversation_users` member ∧ both the conversation and parent workspace
  non-archived. An inaccessible/archived favorite is **hidden, not deleted**: the
  `starred_at` row persists, so the favorite reappears on restore/re-share (same
  orphan-hide philosophy as `getState(visibleEntityIds)`). A leftover `favorites`
  *ordering* row for an unstarred entity is likewise a harmless orphan: unprojected
  while not a member (reorder validates against the live membership set), its rank
  restored if re-starred. **Why hide archived rather than keep+flag:** the star
  routes already 404 archived entities, so a retained archived row's unstar button
  would 404 — keeping it would be a false affordance unless the star routes were
  also loosened (out of v1 scope).
- **Additive overlay, NOT a hard partition.** A starred entity appears in
  Favorites **and** still appears in its home list (the WORKSPACES/DMS rail groups,
  the channel sidebar). STARRED is an entry/shortcut layer, not a move — it must
  **not** be implemented by filtering starred entities out of their home list (the
  pre-Favorites rail's `isWorkspaceStarred` hard group did that; this supersedes
  it). The favorites ordering axis is **independent**: a Favorites reorder writes
  only `list_key='favorites'` ranks and never disturbs the entity's home-list rank
  (and vice versa). `/api/favorites` is otherwise orthogonal to the unchanged list
  endpoints.

## Decisions / non-goals

- Server-side per-user (viewer-scope), not localStorage — Silverhand is
  multi-surface (desktop + web + standalone), same human across surfaces; local
  storage would split per surface. localStorage v0 and recent-**active** were
  considered and rejected as fallbacks only.
- Star is a personal hard top group **on the channel sidebar** (#task:1209); on
  the workspace rail star is the global Favorites overlay, not a group (#task:1252).
  Sort mode only orders *within* a group. Cross-group drag is not an implicit star
  change. "Pin/Pinned 📌" is reserved for a future SHARED axis and must not reuse
  the star storage/routes.
- Favorites ordering is its OWN axis (`list_key='favorites'`, #task:1252 C), not the
  home-list rank and not a revival of the old rail `starred` hard group. Storing
  membership for Favorites is still a non-goal — `starred_at` in the home list is the
  sole star truth; `favorites` stores only how the list is arranged.
- Threads and the archived recovery index are out of the sorting model.
  - `workspace` — a starred `workspace_kind='regular'` workspace (`list_key='workspaces'`).
    Regular workspaces have no icon storage ⇒ `icon_url` always null ⇒ renderer
    monogram/`W`. Unstar: `DELETE /api/workspaces/:entity_id/star`.
  - `dm` — a starred `workspace_kind='agent_home'` workspace; `title`/`icon_url`/
    `runtime` resolved from the bound `owner_agent_id`. Unstar:
    `DELETE /api/workspaces/:entity_id/star`.
  - `channel` — a starred `conversations.kind='channel'` under a
    `workspace_kind='regular'` parent (`list_key='channels:<ws>'`); `workspace_name`
    = parent name (muted subtitle + same-name disambiguator). Unstar:
    `DELETE /api/channels/:entity_id/star`. **v1 narrows out `dm_channel` stars**:
    a DM surfaces only as a `dm` row, never twice; a `channels:<agent_home>` /
    `dm_channel` star is hidden (storage preserved), and mapping a DM *conversation*
    to a favorite is a separate future decision.
- **Membership contract** (read-model enforces; written here, not hidden in SQL):
  a row appears **iff the viewer can still access the entity AND it is not
  archived** — exactly the set the per-entity star endpoints accept, so Favorites
  membership ≡ the viewer's star-toggleable set (one source of truth). workspace/dm
  → `workspace_users` member ∧ `workspaces.archived_at IS NULL`; channel →
  `conversation_users` member ∧ both the conversation and parent workspace
  non-archived. An inaccessible/archived favorite is **hidden, not deleted**: the
  `starred_at` row persists, so the favorite reappears on restore/re-share (same
  orphan-hide philosophy as `getState(visibleEntityIds)`). **Why hide archived
  rather than keep+flag:** the star routes already 404 archived entities, so a
  retained archived row's unstar button would 404 — keeping it would be a false
  affordance unless the star routes were also loosened (out of v1 scope).
- **Additive overlay, NOT a hard partition.** A starred entity appears in
  Favorites **and** still appears in its home list (the WORKSPACES/DMS rail groups,
  the channel sidebar). STARRED is an entry/shortcut layer, not a move — it must
  **not** be implemented by filtering starred entities out of their home list (the
  pre-Favorites rail's `isWorkspaceStarred` hard group did that; this supersedes
  it). The backend is orthogonal: `/api/favorites` is independent of the unchanged
  list endpoints.

## Decisions / non-goals

- Server-side per-user (viewer-scope), not localStorage — Silverhand is
  multi-surface (desktop + web + standalone), same human across surfaces; local
  storage would split per surface. localStorage v0 and recent-**active** were
  considered and rejected as fallbacks only.
- Star is a personal hard top group **on the channel sidebar** (#task:1209); on
  the workspace rail star is the global Favorites overlay, not a group (#task:1252).
  Sort mode only orders *within* a group. Cross-group drag is not an implicit star
  change. "Pin/Pinned 📌" is reserved for a future SHARED axis and must not reuse
  the star storage/routes.
- Threads and the archived recovery index are out of the sorting model.
