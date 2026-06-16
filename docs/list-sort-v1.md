# List sort v1 — per-user workspace rail & channel sidebar ordering

Status: backend landed (#task:1147); renderer (#task:1146, Norman) consumes this
contract. Design converged with @Cindy (review) + @Norman (renderer) and
approved by shiki 2026-06-16.

## Model

Ordering is **personal view state**, not an aggregate field — "how THIS viewer
arranged the list". It never lives on the workspace / conversation aggregate; it
is its own viewer-scoped read model with its own tables. The **backend persists
preferences and exposes them; it does not order**. The renderer composes the
final order with a pure helper.

Two concerns, two scopes:

- **mode** — per *list*. One `[recent | manual]` toggle per list. Default
  `recent` (recently-**opened** by this viewer). A manual reorder (drag) also
  switches the list to `manual` atomically (`order ⟹ manual`, see API), so drag
  works from any mode.
- **per-entity state** — `rank` (manual order) + `last_accessed_at`
  (recent-opened), per entity per list.

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
partitioned **live at sort time** from the entity's own pin/kind state — never
baked into a storage bucket key. This keeps pin/unpin from having to migrate
ranks across buckets.

Hard groups (sort-time partition; manual drag is within a group, never across):

- workspace rail: `dm` (agent_home) / `regular:pinned` / `regular:unpinned`.
  DM workspaces have **no pin** (`canPin = regular && !archived`), so there is no
  `dm:pinned`. Archived workspaces are out of sorting scope entirely.
- channel sidebar: `pinned` / `unpinned`. Threads are out of sorting scope.

Crossing a pin boundary (pin/unpin) **clears the entity's manual rank** for all
viewers (`SortRepo.clearEntityRank`), so it falls to the new group's manual tail
until re-dragged — this also prevents the two groups' dense rank numbering from
colliding.

### Renderer composition (pure helper)

`live partition (rail: agent_home→dm, regular→pin tier; channel→pin tier)` →
within each group by mode:

- `recent` → `last_accessed_at DESC` (NULLs last).
- `manual` → `rank ASC` (NULLs last, then `created_at`, then id tiebreak).

`entries` is sparse (only entities with a rank or a last_accessed). An entity
absent from `entries` joins as both-null.

#### Drop-frame sync invariant (drag reorder)

The drag-reorder UI must hold two frame-level invariants, both learned the hard
way via CDP (see `apps/desktop/.../ChannelsSidebar.tsx`). Code that conflicts
with these is the bug.

1. **Reorder in the same React commit as dnd's drag-reset.** On drop, dnd-kit
   clears the active row's transform synchronously (frame N). If the new list
   order is sourced from the React Query cache, the reorder lands a frame later
   (frame N+1) — RQ's observer notify is microtask-batched — so for one frame
   the row snaps back to its OLD slot, then jumps to the new one (CDP "B-type"
   desync). Fix: `onDragEnd` sets a synchronous component-local override
   (`pendingDrop`) that batches with dnd's reset into one commit; the cache
   write + mutation are **pure persistence**, and the override self-clears once
   the cache catches up (≈1–2 frames). **Do NOT** drive the drop reorder from
   pure `setQueryData` or any async-store notification — `flushSync` can't save
   it (nothing is pending to flush), the desync just returns.

2. **Freeze color transitions across the whole drop bridge, not just the
   drag.** Rows carry a `transition-colors`; if it is live at the drop/reorder
   commit frame, the row landing under the cursor momentarily loses its hover
   value (bg → transparent for one frame) and then animates back to hover over
   ~150ms = a visible in-place flicker (only on down-drags, where the cursor
   settles on a *different* row than it started on; up-drags land on the
   already-colored dragged row). Keying the freeze on `isSorting` alone is one
   frame too short — it flips false exactly on the commit frame. Fix: freeze the
   color transition for `isSorting || bridging`, where `bridging` = this list's
   `pendingDrop` is still settling, so the hover value re-stabilizes with no
   transition. A separate, *imperceptible* residual (the drop-target's normal
   hover fade arriving a few frames after the bridge clears) is intentionally
   **not** suppressed: forcing it instant would make the landing row hard-cut
   while siblings fade — a visible inconsistency for an invisible difference.

3. **Two freezes, two row-sets — value-freeze is siblings-only, never the
   dragged row.** The freeze is split into two signals on purpose
   (`freezeColorTransition` = every row through the bridge, per invariant 2;
   `freezeColorValue` = siblings only — strips `:hover` so a row sliding under a
   stationary cursor can't paint a hover bg). The split is **structural, not
   residue**: the dragged row lands under the cursor on drop, so its true value
   is `hover`. If its *value* were also frozen (to the resting value) during the
   drag, then at the frame the freeze lifts there is a value delta
   (resting → hover); if the transition has re-attached on that same frame, the
   browser animates the delta — the fade-in doesn't disappear, it just defers
   from the drop frame to the unfreeze frame. Keeping the dragged row's value
   **live at all times** (only its transition frozen) guarantees no unfreeze
   boundary ever carries an animatable delta. **Do NOT** collapse the two into a
   single signal — it reintroduces the fade-in. Making the dragged row hide its
   hover bg mid-drag would require a staggered two-frame unfreeze (value first,
   transition next frame), strictly more complex — not done.

This whole color-freeze apparatus exists *solely* to preserve the resting
`transition-colors` hover-fade during drag. That fade is kept deliberately: every
sidebar row type (workspace rail, channel list, search / saved / archived) uses
the same 150ms fade, so dropping it on draggable channel rows alone would split
the sidebar's row language for no semantic reason. Switching the sidebar to
instant hover is a *global* design decision (its own task), out of scope here —
and only that decision would let this apparatus be deleted.

## Storage (migration v47)

```sql
CREATE TABLE user_list_sort_mode (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key   TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('recent', 'manual')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_key)
);

CREATE TABLE user_sort_entry (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key         TEXT NOT NULL,
  entity_id        TEXT NOT NULL,   -- soft ref to workspaces|conversations by list_key (no FK, polymorphic)
  rank             INTEGER,         -- NULL = not manually arranged
  last_accessed_at INTEGER,         -- NULL = never opened
  PRIMARY KEY (user_id, list_key, entity_id)
);
```

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

Mutations return the authoritative `{ viewer_sort }` for optimistic reconcile
(touch excepted):

- `PUT /api/sort/mode { list_key, mode }` → `{ viewer_sort }`. Validates list
  scope (existence + visibility) like order/touch — a viewer can't persist a
  preference for a non-existent / forbidden list.
- `PUT /api/sort/order { list_key, group, ordered_ids }` → `{ viewer_sort }`.
  `ordered_ids` must be **exactly** the live members of `group` (any order, no
  missing / extra / duplicate / cross-group id). `group` must be a legal hard
  group for the list kind (rail: `dm|regular:pinned|regular:unpinned`; channel:
  `pinned|unpinned`) — an illegal group is rejected even with empty
  `ordered_ids`. The backend validates against live pin/kind state and rejects
  otherwise (400) — a partial submission would leave other members' ranks stale
  and collide within the group, so it is not a patch. On success it rewrites
  dense ranks (0..n) for the group **and sets the list's mode to `manual` in the
  same transaction** — `order ⟹ manual` is an invariant, so a drag works from
  any mode (including `recent`) in a single call and there is never a window
  where manual ranks exist while the mode still reads `recent`. The response's
  `viewer_sort.mode` comes back `manual`.
- `POST /api/sort/touch { list_key, entity_id }` → `{ ok: true }`. Idempotent
  upsert of `last_accessed_at`. Called **only on selection**. Renderer sends it
  fire-and-forget (non-blocking) and dedups/throttles per `(viewer, target)`;
  the upsert is idempotent as a backstop.

`ViewerSortStateDto = { list_key, mode, entries: { entity_id, rank, last_accessed_at }[] }`
(exported from `@silverhand/shared`).

## Decisions / non-goals

- Server-side per-user (viewer-scope), not localStorage — Silverhand is
  multi-surface (desktop + web + standalone), same human across surfaces; local
  storage would split per surface. localStorage v0 and recent-**active** were
  considered and rejected as fallbacks only.
- Pin stays a hard top group; sort mode only orders *within* a group. Cross-group
  drag is not an implicit pin change.
- Threads and the archived recovery index are out of the sorting model.
