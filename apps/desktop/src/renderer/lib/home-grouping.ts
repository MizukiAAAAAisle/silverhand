/**
 * Home-list projections under the Favorites model (#task:1254, re-scoped to
 * CONVERSATIONS by #task:1888, and to conversations ONLY by #task:1900).
 *
 * `starred_at` now means exactly one thing anywhere in the app: a channel / DM
 * channel star MOVES the row out of its parent's channel list into the GLOBAL
 * STARRED list (`FavoritesPanel`). Exclusive — the row renders THERE only, never in
 * both places. See `excludeStarredChannels`.
 *
 * Containers (workspace / agent space) have NO star (shiki, 2026-08-08): their
 * order is `f(mode, rank)` and nothing else, so no projection here ever reads a
 * container's `starred_at`. Why the container reading was retired:
 * docs/app-layout.md §4.5 (#task:1900).
 *
 * SINGLE SOURCE, NO DRIFT: every projection reads each item's `starred_at`, which
 * the composition root (App.tsx) joins onto every item from the SAME
 * `viewer_sort.entries[].starred_at` the backend's reorder validation uses
 * (`SortRepo.listStarredEntityIds`). Display membership and server validation
 * therefore agree by construction — the renderer never joins `GET /api/favorites`
 * back onto the channel list or keeps a second starred set.
 *
 * Why this matters to DRAG, not just to looks: `routes/sort.ts` accepts a
 * whole-group reorder only when `ordered_ids` is EXACTLY the group's live members,
 * so the channel exclusion must happen BEFORE `useListDragSort` sees the list.
 */

import { isAgentSpace } from '@/features/workspaces/workspace-ownership';

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
export function excludeStarredChannels<T extends StarrableItem>(
  items: readonly T[],
): T[] {
  return items.filter(c => !isStarredAt(c.starred_at));
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
export type StarMembership = 'starred' | 'unstarred' | 'unknown';

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

/**
 * Does this workspace branch hold the open conversation's ROW — i.e. may a
 * COLLAPSED branch keep that one row on screen, and pay for the three queries that
 * takes (#task:1901, @Cindy MUST FIX)?
 *
 * The criterion is MEMBERSHIP AFTER exclusive-home, not `workspaceId` equality. A
 * starred conversation is no longer a member of its parent's list (#task:1888 —
 * `excludeStarredChannels` drops it) and its row lives in STARRED, so the parent
 * branch has nothing to keep: matching on the parent alone would mount channels /
 * sort / modes / unread only to find no row at the end of it. The row must be kept
 * by exactly the container that actually renders it, which is the same rule that
 * decides where the row IS.
 *
 * `'unknown'` does NOT mount either: membership is the whole precondition, so
 * guessing it is guessing the answer. The cost is that on a cold start a collapsed
 * branch's one row appears after the favorites list resolves rather than in
 * parallel with it; the alternative — guess "unstarred", mount, then unmount — is
 * the exact waste this predicate exists to remove, and it cannot be taken back once
 * the requests are out.
 */
export function branchHoldsSelectedRow(
  workspaceId: string,
  selected: SelectedConversation,
): boolean {
  if (selected.channelId === null) return false;
  if (selected.starred !== 'unstarred') return false;
  return selected.workspaceId === workspaceId;
}

/**
 * The rows a COLLAPSED workspace branch renders — the union of TWO independent
 * inputs, never one derived from the other (#task:1939, @Cindy MUST FIX).
 *
 * `isSelected` — the open row is ALWAYS kept, unread or not. That is the
 * pre-existing #task:1889 exception ("the selected row is always visible"), and it
 * has NOTHING to do with unread: a branch mounts to keep this row even when there
 * is no unread anywhere in it.
 *
 * `pokeUnread` — the SEPARATE poke gate: only when it is on are the branch's `loud`
 * unread rows revealed too. It MUST be the branch's WAKE GATE (the lit workspace
 * attention badge), NOT "is this branch collapsed": a branch can be collapsed-and-
 * mounted purely to keep the selected row (`branchHoldsSelectedRow`) while its wake
 * badge is dark, and the row-level `loud` verdict lives in a DIFFERENT cache from
 * the badge (they invalidate on different paths and neither refetches over time —
 * activity-lifecycle §10). Gating the poke on "collapsed" would then reveal a stale
 * `loud` sibling with no wake signal, breaking §8's "unread reveal is woken ONLY by
 * a non-zero badge". So the two inputs are kept orthogonal and the caller feeds the
 * wake gate here (by construction: poke ⟹ badge lit), not `!expanded`.
 *
 * `isLoud` MUST be the SAME `channelRowBadge`-`loud` verdict the row paints (Alice's
 * same-source constraint): the reveal set is then a subset of exactly what the wake
 * badge sums, so a `quiet` row never pokes out. `items` is the post-
 * `excludeStarredChannels` list, so a starred loud row is already gone — the
 * accepted empty-reveal case (#task:1888): its star counts toward the wake badge but
 * it renders in STARRED, not here.
 */
export function collapsedRevealRows<T>(
  items: readonly T[],
  opts: {
    pokeUnread: boolean;
    isSelected: (item: T) => boolean;
    isLoud: (item: T) => boolean;
  },
): T[] {
  return items.filter(
    c => opts.isSelected(c) || (opts.pokeUnread && opts.isLoud(c)),
  );
}

/**
 * Which workspace branches a COLLAPSED group reveals (#task:1939, @Cindy MUST FIX).
 *
 * A collapsed GROUP must not hide a new message any more than a collapsed BRANCH
 * does: the WORKSPACES / DM header paints no unread number either, so a poke is the
 * only signal and it has to survive one level further up. The revealed set is exactly
 * the branches an EXPANDED group already keeps mounted while collapsed — the one
 * `holdsSelection` and any that `isAwake` (wake badge lit) — and NOTHING else. A
 * quiet, unselected branch is NOT here: gating on the whole membership would mount
 * every branch's queries just because the group closed (constraint ②), and the poke
 * is meant to cost only what a lit badge already costs.
 *
 * The `holdsSelection` branch comes FIRST so the current context stays on top and can
 * render headerless (the titlebar names the workspace you are in); the rest keep input
 * (sort) order, each needing its own label to stay attributable. `isAwake` is the
 * SAME `unread > 0` wake gate the branch level poke is gated on, so the two levels
 * reveal by one rule. A starred selection makes `holdsSelection` false everywhere
 * (its row is STARRED's, #task:1888), so it is never force-mounted here.
 */
export function collapsedGroupRevealBranches<T>(
  workspaces: readonly T[],
  opts: { holdsSelection: (w: T) => boolean; isAwake: (w: T) => boolean },
): T[] {
  const reveal = workspaces.filter(
    w => opts.holdsSelection(w) || opts.isAwake(w),
  );
  return [
    ...reveal.filter(w => opts.holdsSelection(w)),
    ...reveal.filter(w => !opts.holdsSelection(w)),
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
