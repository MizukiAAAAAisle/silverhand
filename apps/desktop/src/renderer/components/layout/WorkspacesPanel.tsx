import * as Popover from '@radix-ui/react-popover';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentDto, SortGroup } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { ChevronDown, LayoutGrid, MessagesSquare, MoreVertical, Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
} from '@/components/layout/list-drag-sort';
import {
  OUTER_GLYPH_INSET,
  SidebarSection,
  MutedMarker,
  useSidebarSectionExpanded,
} from './sidebar-shared';
import { WorkspaceChannels } from './WorkspaceChannels';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { agentSpaceRecognitionName } from '@/lib/workspace-name';
import {
  branchHoldsSelectedRow,
  collapsedGroupRevealBranches,
  isWorkspaceAwake,
  type SelectedConversation,
} from '@/lib/home-grouping';
import { isAgentSpace } from '@/features/workspaces/workspace-ownership';

export interface WorkspaceItem {
  id: string;
  name: string;
  /** The agent that owns this container, or `null` for a people-owned workspace.
   *  The rail's only spelling of the distinction (#task:2078): classify through
   *  `isAgentSpace`, read the id itself only to resolve the owner's avatar. */
  owner_agent_id: string | null;
  active?: boolean;
  /** Unread mention notifications scoped to this workspace. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True when the viewer has muted this workspace — drives the persistent
   *  `MutedMarker`. Read from the attention roll-up's `muted_workspace_ids`, the
   *  same carrier as `unread`, so the row can never disagree with itself about
   *  one workspace (#task:1870 / #task:1877). Never true for an agent space
   *  (structurally un-mutable). */
  muted?: boolean;
  /** True for soft-archived workspaces. Since #task:1889 an archived workspace is
   *  NOT in this tree at all — the top-level `Archived` page (#task:1890) is the
   *  single archive index. */
  archived?: boolean;
  /** Creation time — stable fallback/tiebreak for the viewer sort modes
   *  (#task:1146). */
  created_at: number;
}

/** Live drag-sort wiring for ONE sortable group (#task:1146). `WorkspaceGroup`
 *  partitions its (already-ordered) workspaces into the `order` hard sub-groups —
 *  each its own DnD context, dividers between — and renders draggable rows. The
 *  drag state machine itself lives in the shared `useListDragSort` (owned by
 *  `Sidebar`); this just carries the per-row callbacks down. */
export interface WorkspaceSortConfig<GroupKey extends SortGroup = SortGroup> {
  /** Sub-group render order. Each rail section now drives a single group:
   *  `['agent_space']` or `['regular']` — one flat, drag-ordered list per section.
   *  These are `SortGroup` WIRE + DB tokens, produced in exactly one place
   *  (`railSortGroupOf`); they are not display words. */
  order: GroupKey[];
  /** The hard group a workspace lives in (agent-owned | people-owned). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Commit a group's new full order. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

interface WorkspaceGroupProps<GroupKey extends SortGroup = SortGroup> {
  label: string;
  /** The section's header glyph — one of the two constants below, so the family
   *  of three section glyphs stays defined in one place (#task:2078: this used to
   *  be a container KIND that the group did nothing else with). */
  icon: ReactNode;
  workspaces: WorkspaceItem[];
  /** The open conversation, as one object. NOT three loose props: the workspace
   *  half only ever answers "which collapsed branch keeps the open row", and that
   *  answer also depends on whether the row has moved into STARRED — splitting
   *  them let a call site supply the parent id without the star fact, which is
   *  exactly the bug `branchHoldsSelectedRow` closes (#task:1901). The channel id
   *  is still the single FILL authority: at most one CHANNEL row highlights, and
   *  no container row ever does. */
  selected: SelectedConversation;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  /** Optional `+` button. The AGENT SPACES section omits this — an agent space is
   *  created with its agent, never from the rail. Ignored when `headerAction`
   *  is set (the caller composes its own action cluster, e.g. sort + add). */
  onAdd?: () => void;
  /** Header right-slot content (e.g. the sort menu, or sort + add). Takes
   *  precedence over `onAdd`. */
  headerAction?: ReactNode;
  /** Shown when `workspaces` is empty. */
  emptyHint?: ReactNode;
  /** Whether the group starts expanded. Defaults to true. With `persistId` this
   *  is only the first-run value. */
  defaultExpanded?: boolean;
  /** Storage identity for cross-restart collapse state (see
   *  `SidebarSection`). Omit for session-only collapse. */
  persistId?: string;
  /** Lookup of all workspace agents, keyed by id. An agent space's row resolves
   *  its `owner_agent_id` here for the agent's runtime + display name. The
   *  avatar object URLs themselves come via `ownerAgentAvatarUrls` (resolved ONCE
   *  at the rail level, not per-section) so reordering a row never churns an
   *  avatar. Optional so callers without agent context still get a sane
   *  fallback. #task:919 / #task:1146 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Resolved owner-agent avatar object URLs, keyed by agent id. Owned by the
   *  parent (`Sidebar`) over the STABLE union of all rail owner agents, so this
   *  map is identical across reorders — no per-section refetch flash
   *  (#task:1146). */
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** Drag-sort wiring. Required since #task:1889 — the last non-sortable caller
   *  (the bottom ARCHIVED group) is gone. */
  sort: WorkspaceSortConfig<GroupKey>;
}

/** Per-row context shared by every entry point so a row is the SAME component
 *  regardless of where it is rendered (one entity, one shape). */
interface RailRowContext {
  selected: SelectedConversation;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
}

function rowIconFor(workspace: WorkspaceItem, ctx: RailRowContext): JSX.Element {
  // One canonical workspace glyph for every surface (sidebar + filter
  // dropdowns). An agent space resolves to its owner's avatar; other rows to
  // the themed `data-workspace-icon` badge — all handled inside `WorkspaceIcon`
  // so this stays identical to the workspace-filter dropdowns (#task:1192 /
  // #task:919 / #task:1160).
  return (
    <WorkspaceIcon
      ownerAgentId={workspace.owner_agent_id}
      agentsById={ctx.agentsById}
      ownerAgentAvatarUrls={ctx.ownerAgentAvatarUrls}
    />
  );
}

/** The recognition name a workspace row shows: an agent space reads as its owning
 *  agent (no `@`, no `· DM` suffix — shiki, #task:1768), any other workspace as its
 *  own name. Shared by the interactive header and the collapsed-group caption so the
 *  two can never drift. */
function workspaceRowTitle(
  workspace: WorkspaceItem,
  ctx: RailRowContext,
): string {
  const ownerAgent = workspace.owner_agent_id
    ? ctx.agentsById?.get(workspace.owner_agent_id)
    : undefined;
  return isAgentSpace(workspace)
    ? agentSpaceRecognitionName(workspace.name, ownerAgent)
    : workspace.name;
}

/**
 * A NON-interactive workspace label, shown above a non-current awake branch's poked
 * rows while the whole group is collapsed (#task:1939). When a collapsed group reveals
 * loud channels from more than one workspace, those rows would otherwise float with no
 * owner — two workspaces' `general` become indistinguishable. The branch you are IN
 * needs none of this (the titlebar names it), so only the OTHER branches are captioned.
 *
 * Deliberately NOT `WorkspaceHeaderRow`: it carries no disclosure triangle, drag,
 * sort menu or `+`. A collapse toggle here would be the fake control shiki removed
 * from the collapsed branch (its only action can no longer change anything), and
 * writing `expanded` from it would break the "reveal is DERIVED" invariant. It wears
 * the muted grouping weight (a caption), not the header's `text-text-secondary`
 * (a control), so it reads as a label for the rows beneath it.
 */
function WorkspaceCaption({
  workspace,
  ctx,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
}): JSX.Element {
  return (
    <li>
      <div
        className={
          'sidebar-row-gutter flex h-7 w-full items-center pr-2 ' +
          OUTER_GLYPH_INSET +
          ' text-text-muted'
        }
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {rowIconFor(workspace, ctx)}
        </span>
        <span className="ml-2 min-w-0 truncate text-xs font-medium">
          {workspaceRowTitle(workspace, ctx)}
        </span>
      </div>
    </li>
  );
}

/** The GROUP header's semantic glyph — the thing shiki asked for on the rail's
 *  sections: identity at rest, chevron on hover. They must read as one family, so
 *  every one is a stroke glyph at the same optical weight: `Star` (STARRED) /
 *  `LayoutGrid` (WORKSPACES — four tiles = a set of spaces) / `MessagesSquare`
 *  (AGENT SPACES, Slack's double bubble; chosen while that section was still
 *  called DM — #task:2035 renamed the section, not the glyph).
 *
 *  WORKSPACES is NOT a `W` (shiki, 2026-08-08: 「和后面的 label W 重复了」). A
 *  letterform beside the word it is the first letter of says nothing the label has
 *  not already said, and it stuttered a second time against the rows below, where
 *  every people-owned workspace's own badge is a literal `W`. `LayoutGrid` is also
 *  the only candidate with no enclosing square: `MessagesSquare` one row down and
 *  `Archive` in the tools group both are, and at 14px a third outlined box would
 *  have read as the same word. `Layers` was unavailable — it is the compaction
 *  glyph (`ComposerActivityHeader`) and the Saved filter's "all".
 *
 *  A hand-drawn oval-bubble glyph was tried for the double-bubble section and
 *  rejected on looks (shiki, 2026-08-08). The concern it answered — square bubbles
 *  are the THREAD vocabulary (`ThreadIcon`) — is carried by the COMPOUND form
 *  instead: the thread glyph is the single `MessageSquare`, so two stacked bubbles
 *  stay a distinct word (and the same one NavRail's Chat tab uses).
 *
 *  Deliberately WITHOUT `data-workspace-icon`: that hook is the themed poster
 *  badge for a workspace INSTANCE, and a muted section header is not one (see
 *  app-layout.md §9 on not inventing a second primitive — this reuses the header
 *  vocabulary rather than the row's).
 *
 *  Constants rather than a lookup keyed on container kind (#task:2078): a rail
 *  SECTION is a fixed composition decision made once in `Sidebar`, not something
 *  derived per workspace, and keying it on the kind was the last thing that kept a
 *  container word in this component. */
export const WORKSPACES_SECTION_GLYPH: ReactNode = <LayoutGrid className="size-3.5" />;
export const AGENT_SPACES_SECTION_GLYPH: ReactNode = <MessagesSquare className="size-3.5" />;

export function WorkspaceGroup<GroupKey extends SortGroup = SortGroup>({
  label,
  icon,
  workspaces,
  selected,
  onSelectChannel,
  onCreateChannel,
  onOpenWorkspaceSettings,
  onAdd,
  headerAction,
  emptyHint,
  defaultExpanded,
  persistId,
  agentsById,
  ownerAgentAvatarUrls,
  sort,
}: WorkspaceGroupProps<GroupKey>): JSX.Element {
  const ctx: RailRowContext = {
    selected,
    onSelectChannel,
    onCreateChannel,
    onOpenWorkspaceSettings,
    agentsById,
    ownerAgentAvatarUrls,
  };

  // Collapsed group: reveal the same rows an EXPANDED group would keep visible while
  // its branches are collapsed — the open conversation's row, PLUS every awake
  // branch's `loud` unread rows (#task:1939). A collapsed GROUP must not hide a new
  // message any more than a collapsed BRANCH does: the section header paints no unread
  // number, so this reveal is the only signal and it has to survive one level up.
  // `collapsedGroupRevealBranches` mounts exactly `holdsSelection || wakeGate` — the
  // set an expanded group already mounts — and NOTHING else (@Cindy MUST FIX ②: a
  // quiet, unselected branch stays unmounted; the group never mounts its whole
  // membership just because it closed). Each branch reuses its own `collapsed` +
  // `pokeUnread` render, so STARRED exclusion, the `channelNodeBadge` `loud` verdict
  // and selected∪loud dedup are the SAME as the branch level, and no `expanded` is
  // ever written (@Cindy MUST FIX ①) — the reveal is derived and retracts when the
  // unread clears.
  //
  // The current branch is FIRST and headerless (the titlebar names the workspace you
  // are in — shiki, 2026-08-08). Any OTHER awake branch gets a NON-interactive
  // `WorkspaceCaption`: its loud channels would otherwise float context-free, and two
  // workspaces' same-named channels become indistinguishable. The caption is a label,
  // not the branch header — no disclosure, drag, sort or `+` — so it is not the fake
  // control shiki removed from the collapsed branch. It is passed THROUGH
  // `WorkspaceChannels` (`revealCaption`), not rendered beside it, so it appears ONLY
  // when that branch's reveal is non-empty: a branch whose wake gate is lit but whose
  // only loud row is STARRED — or whose row queries are loading/failed — shows nothing,
  // never an orphan title (@Cindy MUST FIX).
  const revealBranches = collapsedGroupRevealBranches(workspaces, {
    holdsSelection: w => branchHoldsSelectedRow(w.id, selected),
    isAwake: w => isWorkspaceAwake(w),
  });

  return (
    <SidebarSection
      label={label}
      icon={icon}
      count={workspaces.length}
      onAdd={headerAction ? undefined : onAdd}
      action={headerAction}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
      persistId={persistId}
      collapsedContent={
        revealBranches.length > 0 ? (
          <>
            {revealBranches.map(w => (
              <WorkspaceChannels
                key={w.id}
                workspaceId={w.id}
                selectedChannelId={selected.channelId}
                onSelectChannel={onSelectChannel}
                onCreateChannel={onCreateChannel}
                collapsed
                pokeUnread={isWorkspaceAwake(w)}
                // The current branch is headerless (titlebar names it); any OTHER
                // branch gets a caption — but passed THROUGH `WorkspaceChannels` so it
                // renders only when that branch's reveal is non-empty. A wake-gate-lit
                // branch whose only loud row is STARRED (or whose row queries are
                // loading/failed) then shows nothing at all, never an orphan title
                // (@Cindy MUST FIX — same "signal with no row" failure as the branch
                // level).
                revealCaption={
                  branchHoldsSelectedRow(w.id, selected) ? undefined : (
                    <WorkspaceCaption workspace={w} ctx={ctx} />
                  )
                }
              />
            ))}
          </>
        ) : null
      }
    >
      {workspaces.length === 0 ? (
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? 'Empty'}</li>
      ) : (
        renderSortableGroups(workspaces, sort, ctx)
      )}
    </SidebarSection>
  );
}

/** Render the workspaces as drag-sortable hard sub-groups in `sort.order`,
 *  each its own DnD context (no cross-group drag), a divider between non-empty
 *  groups. The workspaces are already in final order (Sidebar sorted them), so
 *  partitioning preserves within-group order. */
function renderSortableGroups<GroupKey extends SortGroup>(
  workspaces: WorkspaceItem[],
  sort: WorkspaceSortConfig<GroupKey>,
  ctx: RailRowContext,
): ReactNode {
  const partitions = sort.order
    .map(key => ({ key, items: workspaces.filter(w => sort.groupKeyOf(w) === key) }))
    .filter(p => p.items.length > 0);

  return partitions.map((p, i) => (
    <Fragment key={p.key}>
      {i > 0 ? (
        <li>
          <div className="mx-2 my-1 border-t border-border-subtle" />
        </li>
      ) : null}
      <SortableGroup
        ids={p.items.map(w => w.id)}
        onReorder={ordered => sort.onReorder(p.key, ordered)}
      >
        {p.items.map(w => (
          <SortableWorkspaceItem key={w.id} workspace={w} ctx={ctx} />
        ))}
      </SortableGroup>
    </Fragment>
  ));
}

/** Drag-sortable workspace BRANCH — the `<li>` is the sortable node and holds
 *  the transform, so an expanded workspace's channel children travel with their
 *  parent while it is dragged (they live inside this `<li>`).
 *
 *  The drag SURFACE, however, is the header row only: `attributes` + `listeners`
 *  are handed down and spread on the header `<div>`, not here. Putting them on the
 *  `<li>` (what the flat rail did) would make a pointerdown on any CHILD row start
 *  a workspace drag. Whole-row drag on the header (no grip), 4px activation; the
 *  drag style comes from the shared list-drag-sort helpers. */
function SortableWorkspaceItem({
  workspace,
  ctx,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
}): JSX.Element {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id: workspace.id, animateLayoutChanges });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      // `group/wsbranch` spans the header row AND its channels: the row's
      // right-side actions (sort, `+`) are revealed by pointing anywhere in the
      // BRANCH, not just at its header (shiki, 2026-08-08) — same reveal scope
      // the group headers use, one level down. The header keeps its own narrower
      // `group/ws` for the collapse caret (#task:1948): a disclosure hint lighting
      // up on the parent while the pointer is on a child would say the wrong thing
      // about what is under the cursor.
      className="touch-none group/wsbranch"
    >
      <WorkspaceBranch
        workspace={workspace}
        ctx={ctx}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </li>
  );
}

/**
 * One workspace: its header row plus, when expanded, its channel children.
 *
 * The header is pure CHROME (#task:1889, shiki: 「workspace 应该永远不能高亮」) —
 * a collapse toggle and a right-click menu. It does NOT navigate, does NOT change
 * the titlebar context and NEVER highlights, so the tree has exactly one FILL and
 * it always belongs to the open conversation. Hierarchy is carried by one 16px
 * indent step (children sit on the child glyph column), the lighter ink and the
 * absence of the row vocabulary (no ink frame) — the header's own glyph slot is
 * the collapse control's home on hover, so no column is spent on a chevron.
 *
 * Collapse state persists per workspace under the shared section vocabulary
 * (`silverhand:layout.sidebar-section.ws.<id>`), so the shape of the tree survives
 * a restart. It starts COLLAPSED and only an explicit click changes it — the stored
 * bit means "I want this open", never "I have been here" (see `holdsSelection`
 * below). Opening a channel in a collapsed branch does not expand it; the branch
 * keeps that one row on screen by itself, and a collapsed branch with `loud` unread
 * also pokes those rows out (`collapsed` render + `pokeUnread`, #task:1939) — both DERIVED, so the
 * FILL and the unread stay reachable without pinning the branch open, writing
 * `expanded`, or handing the header a stand-in marker.
 */
function WorkspaceBranch({
  workspace,
  ctx,
  dragHandleProps,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  dragHandleProps: Record<string, unknown>;
}): JSX.Element {
  // FIRST RUN IS COLLAPSED (shiki, 2026-08-08:「只展开 starred/workspace/dm 第一
  // 级,第二级不展开」). The three group headers open by default, the branches under
  // them do not: an untouched tree is then a list of workspaces you can read at a
  // glance instead of every channel of every workspace, and the lazy-mount rule
  // above pays off on the very first paint rather than only after the user has
  // collapsed things by hand.
  const [expanded, setExpanded] = useSidebarSectionExpanded(`ws.${workspace.id}`, false);
  // Navigation does NOT expand this branch (shiki, 2026-08-08 — the second level
  // stays collapsed until you open it yourself). It used to: reveal-on-navigate
  // forced EXPANDED and wrote that through, so the stored bit recorded "you have
  // been here" rather than "you want this open", and a default of collapsed decayed
  // back to fully expanded over a few days of use. Nothing is lost by dropping it,
  // because a collapsed branch holding the open channel already shows that one row
  // (`collapsed` render) — the same reveal, without the siblings and without the write.
  //
  // "Holding" is membership AFTER exclusive-home, not parent-id equality: a starred
  // conversation's row is STARRED's, so this branch keeps nothing and stays
  // unmounted. Undecided membership does not mount either — the favorites list is
  // the only authority, and guessing while it loads spends exactly the requests
  // this gate exists to save (`branchHoldsSelectedRow`, #task:1901 @Cindy MUST FIX).
  const holdsSelection = branchHoldsSelectedRow(workspace.id, ctx.selected);
  // The collapsed poke-out wake gate (#task:1939): a lit workspace attention badge
  // (`workspace.unread` = `attentionBadges.by_workspace`, the Σ of its rows' `loud`
  // badges) means a `loud` unread row exists somewhere in this branch, so mount it
  // even while collapsed to poke that row out. The badge is already on the rail, so
  // this costs no fetch to DECIDE; mounting is the same bounded cost as
  // `holdsSelection`. It paints no number here (the header dropped its badge) — it is
  // purely the invisible signal that there is something to reveal. When the only loud
  // contributor is a starred row (still counted in the badge, but moved to STARRED),
  // the branch mounts and reveals nothing — a wasted query, never a visible signal.
  const wakeGate = isWorkspaceAwake(workspace);

  return (
    <>
      <WorkspaceHeaderRow
        workspace={workspace}
        ctx={ctx}
        expanded={expanded}
        onToggle={() => setExpanded()}
        dragHandleProps={dragHandleProps}
      />
      {expanded || holdsSelection || wakeGate ? (
        // 4px, the one sidebar row gap (#task:1951) — see `SidebarSection`.
        <ul className="space-y-1">
          <WorkspaceChannels
            workspaceId={workspace.id}
            selectedChannelId={ctx.selected.channelId}
            onSelectChannel={ctx.onSelectChannel}
            onCreateChannel={ctx.onCreateChannel}
            // Collapsed, but this branch is awake — the one you are IN
            // (`holdsSelection`) and/or one with a `loud` unread row (`wakeGate`).
            // TWO ORTHOGONAL inputs (#task:1939, @Cindy MUST FIX): `collapsed` only
            // means "render the partial set" (the kept selection); `pokeUnread` is the
            // SEPARATE gate that ALSO reveals the loud rows, and it is the WAKE GATE
            // itself — never `!expanded`. Were it `!expanded`, a branch mounted only
            // to keep the selection (`holdsSelection`, dark badge) would poke a stale
            // `loud` sibling with no wake signal — the badge and the row-level verdict
            // live in different caches, neither refetched over time (activity-lifecycle
            // §10). The reveal stays DERIVED — no `expanded` write (#task:1901: that
            // bit means "I want this open", never "something happened here") — so it
            // retracts the instant unread clears. Cost: this branch's three queries
            // stay armed while it has unread; bounded to branches that actually do.
            collapsed={!expanded}
            pokeUnread={wakeGate}
          />
        </ul>
      ) : null}
    </>
  );
}

function WorkspaceHeaderRow({
  workspace,
  ctx,
  expanded,
  onToggle,
  dragHandleProps,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  expanded: boolean;
  onToggle: () => void;
  dragHandleProps: Record<string, unknown>;
}): JSX.Element {
  // An agent space's row shows the bound agent's RAW display name — no `@`, no
  // `· DM` suffix (shiki 2026-08-01, #task:1768). This is a recognition surface
  // (who you're talking to), so it reads like a person, not a handle. Shares
  // `workspaceRowTitle` / `agentSpaceRecognitionName` with the caption and titlebar so the
  // three can't drift.
  const title = workspaceRowTitle(workspace, ctx);
  const icon = rowIconFor(workspace, ctx);
  const unread = workspace.unread;
  // Hover-revealed actions, scoped to the whole BRANCH (`group/wsbranch` on the
  // sortable `<li>`): pointing at any channel keeps its parent's sort / `+` up
  // (shiki, 2026-08-08) — you reach for them while reading the list, not while
  // reading its header, and a `+` that hides the moment you move down toward the
  // channels is a target you have to re-acquire.
  // Keyboard reachability comes from `focus-visible` — on
  // the control itself, or on a descendant for the wrappers whose focusable part is
  // a menu trigger. NOT `group-focus-within`: Chromium focuses a <button> on
  // mousedown, so clicking the workspace header (a collapse toggle) left the row's
  // `+` and sort menu pinned visible until focus moved elsewhere — the row read as
  // stuck in a selected state (shiki, #task:1889 review). `:focus-visible` is the
  // keyboard-only half of that signal, which is the only half this affordance
  // wanted. `:has([data-state=open])` keeps a trigger visible while its own menu is
  // open — otherwise it vanishes from under an open Radix popover the moment the
  // pointer leaves the row.
  const hoverOnly =
    'opacity-0 transition-opacity group-hover/wsbranch:opacity-100 '
    + 'focus-visible:opacity-100 [&:has(:focus-visible)]:opacity-100 '
    + '[&:has([data-state=open])]:opacity-100';

  const row = (
    <div
      className={
        // 28px chrome, NOT the 32px row vocabulary. A container header row is a
        // GROUPING line, and the tree already spends its fill on the thing that
        // matters — the selected channel. So no ink frame and NO hover fill: the
        // `sidebar-row-gutter` twin reserves the same stroke for column alignment
        // but takes none of `.sidebar-row-border`'s state paint (in forza6 that
        // hover is a lime fill + drop shadow, which made this line compete with a
        // real selection). Hover lifts the ink and swaps the glyph for the
        // disclosure triangle — nothing else (shiki, 2026-08-08). The indent puts
        // it on the OUTER column — flush with its group header, because the one
        // available step is spent below this row instead: its channels are what
        // needs position to be readable as a block (shiki, 2026-08-08).
        //
        // Resting ink is `text-text-secondary`, NOT muted: muted is the group
        // LABEL's ink, and wearing it made the parent row read as a caption —
        // lighter than its own channel children, so the line that is actually a
        // control looked like the one thing on screen you cannot press (shiki:
        // 「可点击提示不强」, 2026-08-08).
        //
        // This row is a ROW, not the group: the weight ladder is section LABEL
        // `font-bold` vs every row `font-medium`, and a workspace row takes the row
        // rung even though it parents the channels below it (shiki 2026-08-10:
        // 「workspace 叶子需要 medium，而不是 bold」). It briefly wore `font-bold` — the
        // wrong reading of "group" — which put the loudest weight in the tree on
        // the line that is only a container.
        'sidebar-row-gutter group/ws flex h-7 w-full items-stretch pr-2 ' +
        OUTER_GLYPH_INSET +
        ' ' +
        'text-text-secondary hover:text-text-primary'
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/wstoggle flex min-w-0 flex-1 items-center text-left text-sm font-medium leading-4"
      >
        {/* Identity glyph, permanently (#task:1948). It used to cross-fade into a
            disclosure triangle on hover — the SAME swap the group headers
            used — which meant "this collapses" was invisible until you already
            pointed at the row. The state now rides in the trailing caret below, so
            the glyph slot is identity only and the row keeps one glyph per job.
            Still drawn by CAPABILITY, not by container species: every row that owns
            an `aria-expanded` (people-owned workspace AND agent space — one
            `WorkspaceHeaderRow` serves both) carries the caret, and the leaf rows
            (channel / STARRED) never do, because their glyph is not a hinge.
            A LEADING permanent triangle was the candidate rejected in #task:1889 —
            it needs its own column, and keeping the one indent step then costs
            every channel another 12px in an already narrow list
            (docs/app-layout.md §3). The trailing caret costs no column. */}
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="ml-2 min-w-0 truncate">{title}</span>
        {/* Mute rides WITH the name (shiki, 2026-08-09): it is a two-state fact
            about the workspace identity, so it belongs on the identity line — and
            OFF the trailing edge, where the always-present `+` used to push it
            around. Inside the toggle it hugs the (truncating) title and never moves
            with the hover actions. Wrapped in a span because `MutedMarker` takes no
            props — the marker owns its own size/opacity; the wrapper owns spacing. */}
        {workspace.muted ? (
          <span className="ml-1 flex shrink-0 items-center">
            <MutedMarker />
          </span>
        ) : null}
        {/* Collapse state, #task:1948. `aria-hidden` — the button's `aria-expanded`
            already says it, and the caret must not become a second hit area. It
            rests at the muted rung under this row's `--text-secondary` ink so the
            hint sits below the name it belongs to, and lifts with the row's own
            hover ink so it never jumps colour families. Placed after the mute
            marker, i.e. last inside the toggle: mute is a fact about the workspace
            and belongs beside its name, while this is a fact about the row's
            disclosure.

            Unlike the section header's caret this one is HOVER-REVEALED, and that
            asymmetry is by density, not by taste (shiki `mmIS3WTMxQOVC7Xd`:
            「group 可以加,dm/workspace 也加,感觉就是很多的重复」). There are three
            section headers and a dozen-plus of these rows, so the same permanent
            glyph reads as label chrome up there and as scatter down here —
            especially since it trails a TRUNCATING name, so every row parks it at a
            different x and the repetition never resolves into a column. Collapse is
            learned once and transfers to all rows, so paying the resting-ink price
            on every row buys nothing after the first. It keeps its box at rest
            (opacity, not mount) so the name's truncation point never moves between
            hover states. */}
        <span
          aria-hidden
          data-sidebar-branch-caret
          className="ml-1 inline-flex shrink-0 items-center text-text-muted opacity-0 transition-opacity group-hover/ws:opacity-100 group-focus-visible/wstoggle:opacity-100"
        >
          <ChevronDown
            className={
              'size-3 transition-transform duration-150 ' +
              (expanded ? 'rotate-0' : '-rotate-90')
            }
          />
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 pl-1">
        {!expanded && !(unread && unread > 0) && workspace.active ? (
          <span className="size-1.5 rounded-full bg-success" />
        ) : null}
        <span className={hoverOnly}>
          <WorkspaceActions
            title={title}
            onCreate={() => ctx.onCreateChannel(workspace.id)}
            onSettings={isAgentSpace(workspace) ? undefined : () => ctx.onOpenWorkspaceSettings(workspace.id)}
          />
        </span>
      </span>
    </div>
  );

  // The drag surface is a WRAPPER around the header, not the header itself: the
  // context-menu trigger below goes through a Radix `Slot`, which swallows the
  // dnd-kit pointer activation when the listeners are cloned onto the same element
  // (the hazard `ChannelRow` documents). Wrapping also scopes the surface to the
  // header — a pointerdown on a child channel row can never start a workspace drag.
  return (
    <div
      className="mt-1.5 cursor-grab select-none active:cursor-grabbing"
      {...dragHandleProps}
    >
      <WorkspaceContextMenu
        trigger={row}
        muteWorkspaceId={canMuteWorkspace(workspace) ? workspace.id : null}
        leaveWorkspace={
          canLeaveWorkspaceRow(workspace)
            ? { id: workspace.id, name: workspace.name }
            : null
        }
      />
    </div>
  );
}

/** A row can flip the workspace mute suppressor when it is a people-owned,
 *  non-archived workspace. An agent space is structurally un-mutable — directed-grade
 *  traffic has no ambient floor to silence, and the DB trigger forbids the row —
 *  and an archived workspace isn't being listened to at all. */
function canMuteWorkspace(workspace: WorkspaceItem): boolean {
  return !isAgentSpace(workspace) && !workspace.archived;
}

/** Self-leave is offered in the row menu on the SAME structural footing as mute
 *  — an active people-owned workspace — so the menu always keeps the always-present
 *  Mute item and never renders empty (the owner-rejection role gate is resolved
 *  downstream, inside the menu). An agent space has no membership to leave, and an
 *  archived workspace (which since #task:1889 isn't in this tree anyway) leaves
 *  through Settings. */
function canLeaveWorkspaceRow(workspace: WorkspaceItem): boolean {
  return !isAgentSpace(workspace) && !workspace.archived;
}

function WorkspaceActions({ title, onCreate, onSettings }: { title: string; onCreate: () => void; onSettings?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const keyboardOpen = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const cancelClose = (): void => { clearTimeout(closeTimer.current); };
  const show = (): void => { cancelClose(); setOpen(true); };
  const hide = (): void => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={`Actions for ${title}`} onMouseEnter={show} onMouseLeave={hide} onClick={event => {
          event.preventDefault();
          keyboardOpen.current = event.detail === 0;
          show();
          if (keyboardOpen.current) contentRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        }}>
          <MoreVertical className="size-3.5" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content ref={contentRef} align="end" sideOffset={4} onMouseEnter={cancelClose} onMouseLeave={hide} onOpenAutoFocus={event => { if (!keyboardOpen.current) event.preventDefault(); }} onCloseAutoFocus={event => { if (!keyboardOpen.current) event.preventDefault(); }} data-popover-frame="menu" className="z-[var(--z-dialog)] min-w-40 bg-bg-floating p-1 shadow-popover">
          <button type="button" className="flex w-full items-center gap-2 rounded-[var(--floating-item-radius)] px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover" onClick={() => { setOpen(false); onCreate(); }}><Plus className="size-3.5" />Create channel</button>
          {onSettings ? <button type="button" className="flex w-full items-center gap-2 rounded-[var(--floating-item-radius)] px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover" onClick={() => { setOpen(false); onSettings(); }}><Settings className="size-3.5" />Settings</button> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
