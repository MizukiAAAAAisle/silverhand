import { isAgentSpace } from "@/features/workspaces/workspace-ownership";

/** Whether an item is starred — the one predicate the projections turn on. */
export function isStarredAt(starredAt: number | null | undefined): boolean {
  return starredAt !== null && starredAt !== undefined;
}

interface RailWorkspaceItem {
  id: string;
  owner_agent_id: string | null;
  archived?: boolean;
}

declare const FAVORITES_WATCH_SCOPE: unique symbol;

/**
 * The STARRED freshness scope, as a NOMINAL type (#task:1889, @Cindy MUST FIX).
 *
 * `FavoritesGroup.watchWorkspaceIds` takes this and nothing else, and the ONLY
 * value of it is `partitionRailWorkspaces().allVisibleIds`. That is the fence:
 * re-deriving the scope from a projection — `homeAgentSpaces.concat(homeRegular).map(w =>
 * w.id)`, or the favorites rows' own `workspace_id`s — produces a plain
 * `string[]` and fails typecheck at the call site. The earlier claim that this
 * was already unrepresentable was wrong: the shape was structurally identical, so
 * the wrong wiring compiled and every test stayed green (@Cindy proved it by
 * doing exactly that substitution). A brand is what actually makes the two
 * distinguishable.
 *
 * Why the scope must be the raw set: it has to stay armed for a workspace with
 * NOTHING visible in the tree — that is precisely where a hidden star waits, and
 * where a restore arrives. Any projection has already dropped those rows.
 */
export type FavoritesWatchScope = readonly string[] & {
  readonly [FAVORITES_WATCH_SCOPE]: true;
};

/**
 * Partition the rail's workspaces into the home hard groups by OWNERSHIP. Archived rows
 * are DROPPED, not returned: since #task:1889 the merged tree has no ARCHIVED group
 * at all — the top-level `Archived` page (#task:1890) is the single archive index —
 * so an archived workspace is simply not part of the home tree; everything else is
 * returned. The input order is preserved within each group, so an upstream sort
 * still holds.
 *
 * `allVisibleIds` is the RAW input's id set — every workspace the viewer can see,
 * archived INCLUDED, and deliberately NOT `agentSpaces ∪ regular`. It is the scope set for
 * viewer-local projections that must stay armed for a workspace holding nothing
 * visible (STARRED's `useFavorites`, #task:1889): a parent with zero visible rows
 * is exactly the one whose hidden star is waiting to be restored, and an archived
 * parent is exactly where a restore arrives. It is returned from HERE, beside the
 * projections, and typed `FavoritesWatchScope` (above) so a projection-derived
 * substitute cannot reach the consumer.
 */
export function partitionRailWorkspaces<T extends RailWorkspaceItem>(
  items: readonly T[],
): { agentSpaces: T[]; regular: T[]; allVisibleIds: FavoritesWatchScope } {
  const agentSpaces: T[] = [];
  const regular: T[] = [];
  const allVisibleIds: string[] = [];
  for (const w of items) {
    allVisibleIds.push(w.id);
    if (w.archived) continue;
    if (isAgentSpace(w)) agentSpaces.push(w);
    else regular.push(w);
  }
  // The one place the brand is minted — it asserts provenance (raw input set),
  // which no runtime check can express.
  return { agentSpaces, regular, allVisibleIds: allVisibleIds as unknown as FavoritesWatchScope };
}

interface StarrableItem {
  starred_at?: number | null;
}

/**
 * The channel sidebar's home list: top-level channels (threads are reply clusters,
 * never nodes) MINUS the starred ones, which have moved into global STARRED
 * (#task:1888 — exclusive, so hiding them here is the point, not a bug). One flat
 * group; the pre-#1888 `starred | unstarred` hard split is gone. Must run before
 * `useListDragSort` so the drag group matches the server's live member set.
 */
export function excludeStarredChannels<T extends StarrableItem>(items: readonly T[]): T[] {
  return items.filter((c) => !isStarredAt(c.starred_at));
}

/**
 * Whether the open conversation has moved into global STARRED. THREE states on
 * purpose: "the favorites list has not answered yet" is not "not starred", and
 * folding it into `false` is what let a starred selection's parent branch mount on
 * cold start (#task:1901, @Cindy MUST FIX #2). `'unstarred'` is also the deliberate
 * fallback when that list FAILS: pending is a bounded wait, a failure is not, and
 * the fallback restores the COMMON path — a genuinely unstarred selection keeps its
 * row. It does not rescue a genuinely starred one: that row is excluded from its
 * parent by the parent's own `starred_at` and STARRED has no data either, so it is
 * absent for as long as the list is down, exactly as before this change.
 */
export type StarMembership = "starred" | "unstarred" | "unknown";

/** The open conversation, as the sidebar's containers see it. `starred` is the
 *  SAME fact `excludeStarredChannels` filters on (`user_sort_entry.starred_at`),
 *  reached through STARRED's own list rather than through the parent's channel
 *  query — which is the point: the parent's query is what this decides whether to
 *  mount. Nothing selected → `channelId: null`. */
export interface SelectedConversation {
  channelId: string | null;
  /** The workspace the primary pane is in. */
  workspaceId: string | null;
  starred: StarMembership;
}

export function branchHoldsSelectedRow(
  workspaceId: string,
  selected: SelectedConversation,
): boolean {
  if (selected.channelId === null) return false;
  if (selected.starred !== "unstarred") return false;
  return selected.workspaceId === workspaceId;
}

export function collapsedRevealRows<T>(
  items: readonly T[],
  opts: {
    pokeUnread: boolean;
    isSelected: (item: T) => boolean;
    isLoud: (item: T) => boolean;
  },
): T[] {
  return items.filter((c) => opts.isSelected(c) || (opts.pokeUnread && opts.isLoud(c)));
}

export function collapsedGroupRevealBranches<T>(
  workspaces: readonly T[],
  opts: { holdsSelection: (w: T) => boolean; isAwake: (w: T) => boolean },
): T[] {
  const reveal = workspaces.filter((w) => opts.holdsSelection(w) || opts.isAwake(w));
  return [
    ...reveal.filter((w) => opts.holdsSelection(w)),
    ...reveal.filter((w) => !opts.holdsSelection(w)),
  ];
}

/**
 * The collapsed poke-out WAKE GATE (#task:1939), as ONE predicate. A lit workspace
 * attention badge (`workspace.unread` = `attentionBadges.by_workspace`, the Σ of its
 * rows' `loud` badges) means a `loud` unread row exists somewhere in the branch, so it
 * mounts even while collapsed to poke that row out. `docs/activity-lifecycle-v1.md` §8
 * calls this "the same `badge > 0` gate" at both levels — branch (`pokeUnread`) and
 * group (`collapsedGroupRevealBranches`' `isAwake`) — so it lives in exactly one place:
 * change the gate here and both levels move together.
 */
export function isWorkspaceAwake(workspace: { unread?: number | null }): boolean {
  return (workspace.unread ?? 0) > 0;
}
