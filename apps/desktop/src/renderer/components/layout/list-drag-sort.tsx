import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  defaultAnimateLayoutChanges,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import type { SortGroup, ViewerSortStateDto } from "@silverhand/shared";
import { useApplySortOrder, useReorderSort } from "@/features/workspaces/hooks";
import { sortEntryLookup, sortGroup, sortModeOf, type SortEntryLookup } from "@/lib/viewer-sort";
import {
  recentKeyForAndAdmit,
  recentSnapshotToken,
  useRecentKeySnapshot,
} from "@/lib/recent-order-snapshot";

/**
 * Shared drag-reorder LOGIC for the per-user sortable lists (#task:1146) —
 * the channel sidebar AND the workspace rail. This is the single source of
 * the CDP-tuned, counter-intuitive flicker invariants documented in
 * docs/list-sort-v1.md §Renderer composition. There are TWO consumers, so the
 * invariants live here ONCE: a hand-copied second copy would drift the moment
 * one surface fixed a flicker the other missed (correctness-DRY, not brevity).
 *
 * Scope boundary (Cindy's review contract): this hook owns ONLY the state
 * machine — it is list-agnostic over a generic `GroupKey` + item type. The
 * consumer keeps everything visual: the live partition (star/kind → groups),
 * the per-row `SortableXxxItem` shell (calls `useSortable` + `sortableItemStyle`),
 * the row component (ChannelRow / WorkspaceRow), and the
 * header chrome (SortModeMenu, add button). Row-shape differences and 2-vs-3
 * groups never leak in — only the `GroupKey` union changes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INVARIANT #1 — the drop reorder MUST be applied synchronously in *render*,
 * inside the same React commit as dnd-kit's drag-reset. `pendingDrop` is
 * component-local state set in the `onDragEnd` event; the override is applied
 * here in render (`applyOverride`), NOT in an effect, NOT async, NOT via a bare
 * `setQueryData`. dnd clears the active row's transform synchronously on drop
 * (frame N); a cache-driven reorder lands a frame later (frame N+1) because
 * React Query's observer notify is microtask-batched — so for one frame the row
 * snaps back to its OLD slot then jumps (CDP "B-type" desync). `flushSync`
 * can't save it (nothing pending to flush). Do NOT move this override out of
 * render. The cache write (`applySortOrder`) + the mutation are pure
 * persistence; the override self-clears once the cache catches up.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface ListDragSort<GroupKey extends SortGroup, T> {
  /** Per-group live order, with the synchronous drop override applied
   *  (INVARIANT #1). Iterate these to render rows in the right slots. */
  orderedGroups: Record<GroupKey, T[]>;
  /** Commit a group's NEW full order (set-equal to the live group — the
   *  backend rejects partial / cross-group ids and flips mode→manual
   *  atomically, #task:1147). Drives the synchronous override + persistence. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

export function useListDragSort<GroupKey extends SortGroup, T>(params: {
  /** null disables sorting (no workspace selected) — `onReorder` no-ops. */
  listKey: string | null;
  /** Live groups, already partitioned by the consumer (star/kind). The key set
   *  defines the sortable groups; values are the unsorted live members. */
  groups: Record<GroupKey, T[]>;
  viewerSort: ViewerSortStateDto | undefined;
  getId: (t: T) => string;
  getCreatedAt: (t: T) => number;
  /** Maps a group to the mode SCOPE that governs it — the SINGLE source for
   *  both READ (which mode orders this group) and WRITE (which scope's mode the
   *  drop flips to `manual`). Omit for a list-wide list (channel sidebar: every
   *  group resolves to scope `''`, one shared mode — behaviour unchanged). The
   *  rail passes `g => g` so each section toggles independently. INVARIANT: read
   *  and write MUST go through this same mapping, or the menu shows a false
   *  state / a single-group drag appears to flip the whole list's mode. */
  modeScopeOf?: (group: GroupKey) => SortGroup | undefined;
}): ListDragSort<GroupKey, T> {
  const { listKey, groups, viewerSort, getId, getCreatedAt, modeScopeOf } = params;
  const lookup = sortEntryLookup(viewerSort);
  const applySortOrder = useApplySortOrder();
  const reorderSort = useReorderSort();

  // The mode that orders ONE group — read through `modeScopeOf` (omitted ⇒
  // list-wide scope ''). Single source shared with the optimistic write below.
  const modeFor = (group: GroupKey) => sortModeOf(viewerSort, modeScopeOf?.(group));

  // Recent-mode visible order is a FROZEN read model (#task:1161): freeze each
  // id's recent key (`last_accessed_at`) at entry so opening a row can't reflow
  // it under the pointer on the next `viewer_sort` refetch. This makes the fix
  // refetch-source-agnostic — we don't chase which query revalidates on
  // selection; the order is simply stable by construction. The snapshot
  // re-captures ONLY on triggers DECOUPLED from selection/touch, encoded in
  // `snapshotToken`: the list changes (listKey), or a scope toggles into recent
  // (its membership in `recentScopes`). It MUST NOT change on a touch /
  // last_accessed refetch — re-snapshotting then would re-eat the just-written
  // key and the jump returns (Alice's invariant). Manual scopes are rank-ordered
  // and never consult the snapshot. Ids that appear after entry (new / restored
  // rows) have no snapshot entry and fall back to their live key, so they still
  // enter at their natural recent slot.
  const recentScopes = new Set<string>();
  for (const group of Object.keys(groups) as GroupKey[]) {
    if (modeFor(group) === "recent") recentScopes.add(modeScopeOf?.(group) ?? "");
  }
  const snapshotToken = recentSnapshotToken(listKey, recentScopes, viewerSort !== undefined);
  const recentSnapshot = useRecentKeySnapshot(snapshotToken, () => {
    const keyById = new Map<string, number | null>();
    for (const group of Object.keys(groups) as GroupKey[]) {
      if (modeFor(group) !== "recent") continue;
      for (const item of groups[group]) {
        keyById.set(getId(item), lookup(getId(item)).lastAccessedAt);
      }
    }
    return keyById;
  });

  // `byGroup` is keyed by the GroupKey union — zero hard-coded group literals,
  // so the same state covers channel (starred/unstarred) and rail (agent_space /
  // regular).
  const [pendingDrop, setPendingDrop] = useState<{
    listKey: string;
    byGroup: Partial<Record<GroupKey, string[]>>;
  } | null>(null);

  const hasOverride = pendingDrop !== null && pendingDrop.listKey === listKey;

  // INVARIANT #1: apply the drop override here in RENDER (not an effect). The
  // override is laid on top of the cache-derived per-group order, and the same
  // commit that sets `pendingDrop` (in onDragEnd) reorders the DOM the frame
  // dnd clears the transform — no B-type desync.
  const applyOverride = (sorted: T[], group: GroupKey): T[] => {
    const override = hasOverride ? pendingDrop!.byGroup[group] : undefined;
    if (!override) return sorted;
    const pos = new Map(override.map((id, i) => [id, i] as const));
    return [...sorted].sort(
      (a, b) =>
        (pos.get(getId(a)) ?? Number.MAX_SAFE_INTEGER) -
        (pos.get(getId(b)) ?? Number.MAX_SAFE_INTEGER),
    );
  };

  const orderedGroups = {} as Record<GroupKey, T[]>;
  for (const group of Object.keys(groups) as GroupKey[]) {
    const mode = modeFor(group);
    // Recent groups order by the FROZEN key (snapshot for known ids); an id not
    // yet in the snapshot is admitted at its live key and frozen from then on
    // (admit-and-freeze). Manual groups bypass the snapshot (rank-ordered).
    const groupLookup: SortEntryLookup =
      mode === "recent"
        ? (id) => {
            const e = lookup(id);
            return {
              rank: e.rank,
              lastAccessedAt: recentKeyForAndAdmit(recentSnapshot, id, e.lastAccessedAt),
            };
          }
        : lookup;
    orderedGroups[group] = applyOverride(
      sortGroup(groups[group], mode, getId, getCreatedAt, groupLookup),
      group,
    );
  }

  // Drop the override once the cache-derived order matches it (the cache caught
  // up, a microtask after the drop) — at which point clearing is a no-op render.
  // Our own optimistic write makes derived == override, so this never thrashes.
  useEffect(() => {
    if (!pendingDrop) return;
    if (pendingDrop.listKey !== listKey) {
      setPendingDrop(null);
      return;
    }
    const settled = (group: GroupKey): boolean => {
      const override = pendingDrop.byGroup[group];
      if (!override) return true;
      const derived = sortGroup(
        groups[group] ?? [],
        modeFor(group),
        getId,
        getCreatedAt,
        lookup,
      ).map(getId);
      return derived.length === override.length && derived.every((id, i) => id === override[i]);
    };
    if ((Object.keys(pendingDrop.byGroup) as GroupKey[]).every(settled)) {
      setPendingDrop(null);
    }
    // `groups` is rebuilt each render (consumer partition) — same instability the
    // prior in-place version had; the body is cheap + idempotent.
  }, [pendingDrop, listKey, viewerSort, modeScopeOf, lookup, groups, getId, getCreatedAt]);

  const onReorder = (group: GroupKey, orderedIds: string[]): void => {
    if (!listKey) return;
    // INVARIANT #1: synchronous local state set inside the drop event so it
    // batches with dnd's reset into one commit.
    setPendingDrop((prev) => ({
      listKey,
      byGroup: {
        ...(prev && prev.listKey === listKey ? prev.byGroup : {}),
        [group]: orderedIds,
      },
    }));
    // Pure persistence — deterministic cache mirror + server write. Neither
    // carries the frame (see useApplySortOrder). The optimistic mode flip uses
    // the SAME scope as the read (modeFor), so a single-group drag flips only
    // that group's mode. On error, drop the override so the invalidate-driven
    // revert to the old order shows.
    applySortOrder(listKey, modeScopeOf?.(group), orderedIds);
    reorderSort.mutate(
      { list_key: listKey, group, ordered_ids: orderedIds },
      { onError: () => setPendingDrop(null) },
    );
  };

  return { orderedGroups, onReorder };
}

/** The dragged row's inline style. Single-sourced so the lift affordance
 *  (opacity 0.6) + the follow-the-pointer transform stay identical on both
 *  surfaces. zIndex + relative keep the row above its siblings as it crosses
 *  them. NOTE: the 0.6→1 restore is intentionally instant (no transition-opacity
 *  settle) — a post-drop opacity fade reads as a trailing lift, inconsistent
 *  with "drop = final" + the settle guard. */
export function sortableItemStyle(args: {
  transform: { y: number } | null;
  transition: string | undefined;
  isDragging: boolean;
}): CSSProperties {
  return {
    transform: args.transform ? `translate3d(0, ${args.transform.y}px, 0)` : undefined,
    transition: args.transition,
    opacity: args.isDragging ? 0.6 : undefined,
    zIndex: args.isDragging ? 1 : undefined,
    position: args.isDragging ? "relative" : undefined,
  };
}

/** Settle guard: animate sibling rows WHILE sorting (the smooth "make way"
 *  slide), but skip dnd-kit's post-drop settle animation. We reorder the data
 *  synchronously on drop (INVARIANT #1), so the row is already in its final DOM
 *  slot — a settle would then animate a leftover transform→0, the visible
 *  "jump". Pass to every `useSortable`. */
export const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

/** Generic per-group DnD context: vertical-only, in-place (no DragOverlay),
 *  4px pointer activation so a plain click still selects. Each hard group gets
 *  its own context so drags never cross a group boundary. The consumer renders
 *  its `SortableXxxItem` rows as children and sends the COMPLETE new group
 *  order up through `onReorder`. */
export function SortableGroup({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) return;
        onReorder(arrayMove(ids, oldIndex, newIndex));
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}
