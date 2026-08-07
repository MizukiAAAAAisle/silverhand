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

**Revision — star scope flip: Favorites holds CONVERSATIONS (#task:1888,
2026-08-07, shiki-approved).** The single-column sidebar makes the star's target
the CONVERSATION, not its container. Two changes, both model-level:

- **Favorites/STARRED is now a flat global list of CONVERSATIONS** (`channel` /
  `dm_channel`, projected from `list_key='channels:<ws_id>'`). A starred
  conversation MOVES out of its workspace's list into Favorites; each row carries
  its **PARENT's** identity (`workspace_id`, `parent_title`, `parent_icon_url`,
  `parent_runtime`) so a global short list stays identifiable and the renderer
  joins nothing.
- **A workspace / DM container star is demoted to an in-group PIN.** It no longer
  moves anything: the container stays a live, reorderable member of its rail kind
  group and is merely pinned to the top of it. Containers are outside the
  Favorites bounded context — mixing granularities would put parents in a short
  list whose row count then grows with their children.

Consequences carried through the sections below: the channel sidebar's
`starred | unstarred` hard groups are GONE (one group `channels`; the star is an
exclusion, not a partition), no list hard-partitions by star any more, so
`SortRepo.clearRank` lost its only caller and was **deleted** — every home rank
now survives a star toggle. Pre-#1888 `favorites` ordering rows keyed
`workspace:`/`dm:` are unreachable orphans, deliberately neither migrated nor
deleted (the population changed, so an old arrangement of containers has no
meaning to preserve).

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
    rail group (#task:1888: a container's star only PINS it at the top of its own
    kind group), so it has no rail mode scope.
  - **conversation list** — mode is **list-wide** (one toggle for the whole list),
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
partitioned **live at sort time** — never baked into a storage bucket key.

Hard groups (sort-time partition; manual drag is within a group, never across).
The lists partition on **different axes**, and **star is not a hard group in any
list** (#task:1888) — it is either an EXCLUSION (the entity lives in another list)
or a within-group PIN:

- workspace rail: `dm` / `regular` — by **kind** only. A starred workspace/DM
  stays a live, reorderable member of its kind group and is merely **pinned** to
  the top of it (#task:1888) — it is neither excluded nor a group of its own. DM
  (agent_home) workspaces are starrable (`canStar = (regular || agent_home) &&
  !archived`) — star is per-viewer view state (`user_sort_entry.starred_at`), gated
  by can-view, never a shared aggregate field. Archived workspaces are out of
  sorting scope entirely.
- conversation list (`channels:<ws_id>`): a **single hard group `channels`**. A
  conversation star is **exclusive** (#task:1888) — the starred conversation MOVES
  to the global Favorites/STARRED list and is reordered there, so it is EXCLUDED
  from this group's reorder (it stays in the payload and remains a valid
  star/touch target). One **list-wide** mode. Threads are out of sorting scope.

**Single-source partition (no drift).** The home endpoints (`GET /api/workspaces`,
`/api/workspaces/:id/channels`) return the FULL visible set + `viewer_sort` (they
are shared consumers — e.g. cross-workspace activity reads them — so they are
**not** filtered server-side). The conversation list derives its exclusion (hide
the starred conversations, which now render in STARRED) from the **same payload's**
`viewer_sort.entries[].starred_at`, never by joining `GET /api/favorites`. The
backend's reorder validation excludes those same conversations using the **same
fact** (`user_sort_entry.starred_at`, via `listStarredEntityIds`) — so display and
validation are 同源 and cannot diverge. This home-EXCLUSION applies to
**conversations only**. The rail reads the same `starred_at` fact but does NOT
exclude — a starred workspace/DM stays in its kind group, pinned to the top of it.

**Rank asymmetry on star/unstar (deliberate).** `rank` is the viewer's deliberate
placement in THAT list. Since #task:1888 no list hard-partitions by star, so a
star never moves an entity ACROSS groups within one list and **the home rank is
always preserved** (`SortRepo` + `routes/sort.ts` — the route applies the policy,
`SortRepo` is the mechanism). The one asymmetry left is home vs favorites:
- **home rank PRESERVED on star** (`setStarred`; the route does NOT clear). A
  conversation star MOVES it out of its workspace list, so its home rank is a
  harmless orphan while starred and is RESTORED to its arranged position when it
  returns home on unstar. On the rail the entity does not move at all, so its rank
  simply keeps holding its place in its kind group.
- **FAVORITES rank CLEARED on unstar** (`clearFavoriteRank`). Leaving Favorites is
  a *voluntary* removal, so its arranged position is discarded — a later re-star
  re-enters fresh (recent/tail), never silently jumping to a stale favorites slot.

Star is personal, so any write is **scoped to the acting viewer** (the old global
pin cleared all viewers' ranks via the now-removed `clearEntityRank`).

### Renderer composition (pure helper)

`live partition (rail: agent_home→dm / regular→regular — by KIND only, a starred
workspace/DM merely PINNED to the top of its group; conversation list → the single
group `channels`, with the starred conversations EXCLUDED to the global Favorites
list)` → within each group by **that scope's** mode
(`sortModeOf(state, group?)` — group omitted ⇒ scope `''`):

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
aggregate). `SortRepo.setStarred` upserts it (mechanism only — it just flips
`starred_at`; the **rank policy is applied by the route**). Since #task:1888 the
policy is uniform: **the HOME `rank` is always PRESERVED**, because no list
hard-partitions by star, so a star never moves an entity across groups within one
list. On the **conversation list** the starred conversation moves OUT to global
Favorites and its home rank is an orphan restored on unstar-return; on the **rail**
the container does not move at all and keeps its place in its kind group. Clearing
either would silently corrupt the viewer's arranged home order. (The converse —
`clearFavoriteRank` on unstar — drops the `list_key='favorites'` rank, a voluntary
removal.) `SortRepo.clearRank`, which existed only for the old
`starred | unstarred` cross-group move, was **deleted** with its last caller.
**No seed:** the old global
`workspaces.pinned_at` / `conversations.pinned_at` columns are NOT migrated into
per-user stars — they go vestigial (still present, append-only; no longer read or
written; stripped from every DTO so they never reach the wire).

**`starred_at` is presence, not a sort key (#task:1209 / #task:1888).** Non-null
marks the entity as starred; what that DOES to the home list depends on the list
kind. On the **conversation list** it means "MOVED to the global Favorites list and
HIDDEN from this list" — the list reads it to EXCLUDE the conversation. On the
**rail** it means "pinned to the top of its own kind group" — the container stays
a full member, the rail reads it only to hoist it within that group.
Either way it does **not** order anything.
Within-group order (home OR favorites) is governed by that group's mode like every
other hard group — `recent` → `last_accessed_at`, `manual` → `rank`. Letting
`starred_at` silently drive order would make the sort menu a lie and add a third
axis with undefined precedence vs recent/manual. The timestamp is retained for the
read-model's projection + future/debug use, never as an implicit order override.

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
sparse — an absent scope means `recent`). Conversation lists carry the single scope
`''`; the rail carries up to `dm` / `regular` (star is not a rail scope — a
container's star only pins it inside its kind group). Read with the renderer
helper `sortModeOf(state, group?)` — group omitted ⇒ scope `''` (so channel call
sites are unchanged), rail passes its section group.

`viewer_sort.entries[]` carries the per-entity state `{ entity_id, rank,
last_accessed_at, starred_at }` (#task:1209). `starred_at` is the **only** source
of an entity's starred state — the entity DTOs no longer carry `pinned_at`, so the
renderer reads star straight off these entries (no fallback to any aggregate
field). `starred_at`'s effect on the home list depends on the list (#task:1888):
on the **conversation list** it is the home-EXCLUSION signal — a non-null entry
means the conversation has MOVED to the global Favorites/STARRED list, so the list
hides it; on the **rail** it is the in-group PIN signal — a starred workspace/DM
stays a full member of its kind group, hoisted to the top of it. Either way the
home payload still carries the entity
(shared consumers need the full set); the renderer derives partition/exclusion
from `starred_at` in the same payload.

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
  group for the list kind (rail: `dm|regular`; conversation list: `channels`;
  favorites: `favorites`) — an
  illegal group is rejected even with empty `ordered_ids`. The backend validates
  against live kind/star state. On the **conversation list** it **excludes starred
  conversations** (they live in the global Favorites list, reordered there — an
  `ordered_ids` that includes a starred conversation is a 400). On the **rail**
  there is **no exclusion** (#task:1888): a starred workspace/DM is a full member
  of its kind group, so the whole group — starred member included — is the legal
  set, and OMITTING it is the partial-submission 400. It rejects
  partial/extra/duplicate (400) — a partial submission would leave other members'
  ranks stale and collide within the group, so it is not a
  patch. On success it rewrites
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
  alongside rank/mode in one state. The **rank policy on a toggle is uniform**
  since #task:1888 (no list hard-partitions by star, so a toggle is never a
  cross-group move):
  - **home rank PRESERVED** on both lists. A conversation star is a MOVE OUT to
    Favorites (rank a harmless orphan, restored on unstar-return); a container star
    does not move it at all (rank keeps holding its place in its kind group).
  - **on unstar** the route additionally calls `clearFavoriteRank` to drop the
    `list_key='favorites'` rank orphan (voluntary removal). Only a list with a
    global-Favorites projection has one — `favoriteKeyForHome` returns null for the
    rail, so a container unstar touches no favorites row.

  A target not in the live visible set ⇒ 404 (not found / archived); a list the
  viewer can't see ⇒ 403.

`ViewerSortStateDto = { list_key, modes: Record<scope, 'recent'|'manual'>, entries: { entity_id, rank, last_accessed_at, starred_at }[] }`
(exported from `@silverhand/shared`; `modes` is the per-scope map — sparse, absent
scope ⇒ default `recent`; channel lists use the single sentinel scope `''`).

## Favorites — the global STARRED list, exclusive of home (#task:1252 / #task:1888)

> **SCOPE (定稿, shiki 2026-08-07, #task:1888).** The global Favorites/STARRED list
> collects **CONVERSATIONS only** — `kind ∈ {channel, dm_channel}`, projected from
> the per-workspace conversation lists (`list_key='channels:<ws_id>'`). A
> **workspace / DM container is outside this bounded context**: starring one PINS
> it at the top of its own rail kind group, never hoisting it into this flat
> top-level list. Rationale: the single-column sidebar stars **leaves**, because
> mixing granularities would put parents in a short list whose row count then grows
> with their children. There is no `workspace` / `dm` kind, field, or branch in the
> Favorites read-model — a container's star lives entirely in the `workspaces` sort
> list. (This supersedes the 2026-07-01 workspace/DM-only scope, which the
> single-column sidebar inverted.) Note "Mentions" is not a kind: a Mentions inbox
> is a `dm_channel` in the agent's own home workspace.

The sidebar's `STARRED` section is the viewer's **global Favorites**: a flat
list of the conversations the viewer has starred. It is **exclusive** — a
starred conversation lives HERE and is REMOVED from its parent workspace's
children, Slack-style, with no duplication (#task:1252; see *Exclusive — moved out
of home* below). **Membership** is a read-side projection — the single
`user_sort_entry.starred_at` fact (in the conversation's HOME `channels:<ws_id>`
list_key) is the one source
of star truth; there is no "favorites membership" storage. **Ordering**, by
contrast, Favorites owns: a first-class viewer-scoped sort state under
`list_key='favorites'` (#task:1252 C — see *Sortable* below).

- `GET /api/favorites` → `ListFavoritesDto { items: FavoriteRowDto[], viewer_sort }`.
  Read-only, human viewer-scoped, **global** (no workspace filter, mirroring
  Activity). The backend does not impose an authoritative `items` order (raw item
  order is a deterministic fallback only); the renderer composes the display order
  from `viewer_sort` with the shared list-sort helper, exactly like the rail /
  channel sidebar.
- **Sortable (#task:1252 C).** Favorites is a first-class sortable list reusing the
  whole `sort` bounded context, NOT the rail's old `workspaces`/`starred` scope
  (that one only ordered workspaces/DMs and made star a rail hard group). Its state
  lives under `list_key='favorites'`:
  - **flat, single group** `'favorites'` — sortable but not sub-partitioned;
  - **list-wide [recent | manual]** mode (scope `''`, like the channel sidebar) +
    **manual drag** reorder, via `PUT /api/sort/order|mode` with `list_key='favorites'`;
  - **`recent` = recently-OPENED**: it reads each entity's HOME-list
    `last_accessed_at` (so opening a conversation from its workspace updates its
    Favorites recency too), NULLs last → `created_at` → `favorite_key`. **NOT**
    `starred_at`
    ("recently starred" would silently diverge from every other list's `recent`).
  - **`manual` = the favorites `rank`**, written by the reorder under `list_key='favorites'`.
  - This **reverses** the v1 "Favorites owns no storage" stance: storing per-viewer
    *ordering* (rank + the list-wide mode) is the explicit cost of C. It still stores
    no *membership* — `starred_at` in the home list remains the sole star truth.
- **`favorite_key = <kind>:<entity_id>`** (`channel:`/`dm_channel:`) is the
  list's stable sort identity: the renderer row/drag key, the reorder `ordered_ids`
  element, AND the `entity_id` under `user_sort_entry.list_key='favorites'` and the
  matching `viewer_sort.entries[].entity_id`. Kind-qualified — never a bare id — so
  the key stays self-describing and cannot collide with another kind's id space.
  Pre-#1888 rows keyed `workspace:`/`dm:` are unreachable orphans (no member can
  project them), deliberately neither migrated nor deleted.
- `viewer_sort` (`list_key='favorites'`) carries the list-wide mode (`modes['']`)
  and one entry per `favorite_key` with the sort fields the renderer's
  `sortEntryLookup` reads: `rank` (from `favorites`) + `last_accessed_at` (from the
  entity's HOME list). `starred_at` (home) also rides along as a membership/display
  mirror — NOT a sort key (recent's tiebreak is the row's `created_at` →
  `favorite_key`). The read-model **synthesizes** these — joining favorites-rank
  with home-last_accessed — so the renderer treats Favorites like any other list
  (no special-casing).
- Each row carries **server-resolved** display identity, its own AND its
  **PARENT's** (Activity `preview_sender` precedent), so the renderer does **zero**
  local workspace/agent-cache join — a favorite whose parent context is not loaded
  (a collapsed, never-opened workspace) still renders a title, a parent name and a
  parent glyph.
  Fields:
  `{ kind, favorite_key, entity_id, workspace_id, title, parent_title,
  parent_icon_url|null, parent_runtime|null, starred_at, created_at,
  unread_count|null }`. `title` is the conversation's own bare title (no `#`
  sigil, no parent prefix — the renderer composes those); `workspace_id` is the
  **PARENT** (since #1888 it is NOT `entity_id`); `parent_title` is the workspace
  name, or the bound agent's display name → handle → workspace name for an
  agent-home parent. The glyph recipe is chosen from `parent_icon_url` +
  `parent_runtime` (DATA-driven — never inferred from `kind`, since nothing in the
  schema forces "dm_channel ⟺ agent-home parent"). `unread_count` = the
  conversation's unread rollup (#task:1254 / #task:1888 — from the SAME canonical
  `ConversationReadRepo` `ROLLUP_UNREAD` predicate an in-tree channel row uses, so
  STARRED ≡ in-tree; 0 when caught up, renderer badges `> 0`). The conversation left
  its parent's children and that parent may be collapsed and fetching nothing, so
  this row is the only place its unread shows. `entity_id` is the HOME id / star
  path param, distinct from the sort key `favorite_key`.
- **kind is the conversation's own kind** (the list adds none) and does NOT select
  an endpoint — every row unstars through `DELETE /api/channels/:entity_id/star`,
  which derives the storage `list_key` server-side, so the renderer never builds one:
  - `channel` — a starred regular channel; its parent is a regular workspace, which
    has no icon storage ⇒ `parent_icon_url` always null ⇒ renderer monogram.
  - `dm_channel` — a starred conversation in an agent's home workspace (the DM
    stream, its Onboarding thread, its Mentions inbox); `parent_title` /
    `parent_icon_url` / `parent_runtime` resolve from the parent's bound
    `owner_agent_id`.
  - There is **no `workspace` / `dm` kind** — a container's star pins it inside its
    own rail kind group, never a global-Favorites row.
- **Membership contract** (read-model enforces; written here, not hidden in SQL):
  a row appears **iff the viewer can still reach the conversation AND neither it nor
  its workspace is archived** — the star endpoint's own reachability arms,
  INTERSECTED with "not archived" (the star endpoint itself does not look at the
  parent's archive state), so Favorites membership is the viewer's star-toggleable
  conversation set minus the archived. Concretely: viewer ∈ `workspace_users`(parent)
  ∧ `workspaces.archived_at IS NULL` ∧ `conversations.archived_at IS NULL` ∧
  (viewer ∈ `conversation_users` ∨ (`kind='channel'` ∧ `visibility='public'`)) — the
  union of the two arms `listActiveChannelsForViewer` (joined ∪ browseable public)
  and the membership-filtered DM query are built from. The public arm is
  kind-qualified so the DM side cannot be widened by a stray `visibility` value.
  Reducing this to a bare `conversation_users` join would silently drop a starred
  browseable public channel. An
  inaccessible/archived favorite is **hidden, not deleted**: the
  `starred_at` row persists, so the favorite reappears on restore/re-share (same
  orphan-hide philosophy as `getState(visibleEntityIds)`). On **unstar** the
  `favorites` *ordering* row is actively DELETED (`clearFavoriteRank`), so a
  re-star re-enters fresh — there is no stale favorites rank to revive. (The HOME
  rank is the opposite: preserved as an orphan, restored on return.) **Why hide
  archived rather than keep+flag:** the star
  routes already 404 archived entities, so a retained archived row's unstar button
  would 404 — keeping it would be a false affordance unless the star routes were
  also loosened (out of v1 scope). The entity's HOME rank, by contrast, IS
  preserved as a harmless orphan (restored when it returns home on unstar) — see
  the rank asymmetry below.
- **Exclusive — moved out of home, NOT an additive overlay (#task:1252).** A
  starred conversation appears in Favorites **and is REMOVED from its parent's
  children** — Slack-style move, no duplication. (A workspace/DM container is not in
  this list at all; its star is a within-group pin — see *Single-value rank, live
  hard-grouping*.) This is the deliberate
  reversal of the earlier additive-overlay design: duplication bred inconsistency
  (e.g. a divergent unread badge in two places). The home list excludes the entity
  by reading `starred_at` off its OWN inline `viewer_sort` (single-source — never
  by joining `/api/favorites`), and the backend reorder validation excludes it via
  the same `starred_at` fact, so display and validation cannot drift. The two
  ordering axes stay **independent**: a Favorites reorder writes only
  `list_key='favorites'` ranks and never disturbs the entity's home rank (and vice
  versa).
- **Rank asymmetry on the move (deliberate).** Star → home rank PRESERVED
  (involuntary hide; restored on unstar-return). Unstar → favorites rank CLEARED
  (`clearFavoriteRank`; voluntary removal, re-star re-enters fresh). See the
  *Single-value rank* section for the full rationale.
- **STARRED owns presence, not behavior (invariant).** Favorites is an INDEX to
  entities, not a second navigation/selection/unread model. Opening a favorite,
  restoring its saved layout, computing its selection highlight, its unread, and
  its context actions all DELEGATE to the home surface's entry points (the rail /
  channel sidebar) — Favorites must not build a parallel approximation (a bare
  `nav.toChannel` that skips layout-restore, its own selection predicate, its own
  badge). A divergence here is the root cause class of the #task:1252 dogfood bugs
  (duplication / wrong highlight / lost layout).

## Decisions / non-goals

- Server-side per-user (viewer-scope), not localStorage — Silverhand is
  multi-surface (desktop + web + standalone), same human across surfaces; local
  storage would split per surface. localStorage v0 and recent-**active** were
  considered and rejected as fallbacks only.
- Star's effect is **per list kind** (#task:1888, 定稿):
  - **conversation list** — star is **exclusive**: a starred conversation MOVES to
    the global Favorites/STARRED list and is removed from its parent's children.
    Star is NOT a hard group; the list has the single group `channels`.
  - **workspace rail (workspace/DM)** — star is a **pin**: the container stays a
    live, reorderable member of its kind group, hoisted to the top of it. Containers
    never enter the global Favorites list.
  Sort mode only orders *within* a group. "Pin/Pinned 📌" is reserved for a future
  SHARED axis and must not reuse the star storage/routes. (Note the rail's *visual*
  hoist is a within-group presentation of a personal star — not the shared 📌.)
- Favorites ordering is its OWN axis (`list_key='favorites'`, #task:1252 C), not the
  home-list rank and not a revival of any home `starred` hard group. Storing
  membership for Favorites is still a non-goal — `starred_at` in the home list is the
  sole star truth; `favorites` stores only how the list is arranged.
- Threads and the archived recovery index are out of the sorting model.
