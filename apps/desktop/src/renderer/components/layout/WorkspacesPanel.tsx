import { Fragment, useEffect, type ReactNode } from 'react';
import type { AgentDto, SortGroup } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
} from '@/components/layout/list-drag-sort';
import {
  SidebarSection,
  MutedMarker,
  UnreadBadge,
  useSidebarSectionExpanded,
} from './sidebar-shared';
import { ChannelSortMenu, WorkspaceChannels } from './WorkspaceChannels';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { dmRecognitionName } from '@/lib/workspace-name';

type WorkspaceUiKind = 'regular' | 'dm';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: WorkspaceUiKind;
  dm_agent_id: string | null;
  starred_at?: number | null;
  active?: boolean;
  /** Unread mention notifications scoped to this workspace. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True when the viewer has muted this workspace — drives the persistent
   *  `MutedMarker`. Read from the attention roll-up's `muted_workspace_ids`, the
   *  same carrier as `unread`, so the row can never disagree with itself about
   *  one workspace (#task:1870 / #task:1877). Never true for a DM (structurally
   *  un-mutable). */
  muted?: boolean;
  /** True for soft-archived workspaces. Since #task:1889 an archived workspace is
   *  NOT in this tree at all — the top-level `Archived` page (#task:1890) is the
   *  single archive index — so this only gates the star action below. */
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
   *  `['dm']` or `['regular']` (a starred ws/DM is PINNED inside its own group,
   *  never moved to another one — #task:1888). */
  order: GroupKey[];
  /** The hard group a workspace lives in (by kind: dm | regular). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Commit a group's new full order. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

interface WorkspaceGroupProps<GroupKey extends SortGroup = SortGroup> {
  label: string;
  /** Default kind for icon picking when a row's `kind` is the same.
   *  Kept on the group for the empty-state messaging. */
  kind: WorkspaceUiKind;
  workspaces: WorkspaceItem[];
  /** The workspace the primary pane is in — used ONLY to decide which parent
   *  reveal-on-navigate expands. It never highlights a row (#task:1889). */
  selectedWorkspaceId: string | null;
  /** The open conversation. The single selection object of the whole tree: at
   *  most one CHANNEL row FILLs, and no container row ever does. */
  selectedChannelId: string | null;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  onStarWorkspace?: (id: string, starred: boolean) => void;
  /** Optional `+` button. DM groups omit this — DM workspaces are
   *  auto-created when an agent is provisioned. Ignored when `headerAction`
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
  /** Lookup of all workspace agents, keyed by id. DM workspace rows resolve
   *  their `dm_agent_id` here for the agent's runtime + display name. The
   *  avatar object URLs themselves come via `dmAgentAvatarUrls` (resolved ONCE
   *  at the rail level, not per-section) so star/unstar moving a DM between
   *  sections doesn't churn every avatar. Optional so callers without agent
   *  context still get a sane fallback. #task:919 / #task:1146 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Resolved DM-agent avatar object URLs, keyed by agent id. Owned by the
   *  parent (`Sidebar`) over the STABLE union of all rail DM agents, so this
   *  map is identical across star/unstar/reorder — no per-section refetch flash
   *  (#task:1146). */
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** Drag-sort wiring. Required since #task:1889 — the last non-sortable caller
   *  (the bottom ARCHIVED group) is gone. */
  sort: WorkspaceSortConfig<GroupKey>;
}

/** Per-row context shared by every entry point so a row is the SAME component
 *  regardless of where it is rendered (one entity, one shape). */
interface RailRowContext {
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  onStarWorkspace?: (id: string, starred: boolean) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
}

function rowIconFor(workspace: WorkspaceItem, ctx: RailRowContext): JSX.Element {
  // One canonical workspace glyph for every surface (sidebar + filter
  // dropdowns). DM rows resolve to the bound agent's avatar; regular rows to
  // the themed `data-workspace-icon` badge — all handled inside `WorkspaceIcon`
  // so this stays identical to the workspace-filter dropdowns (#task:1192 /
  // #task:919 / #task:1160).
  return (
    <WorkspaceIcon
      kind={workspace.kind}
      dmAgentId={workspace.dm_agent_id}
      agentsById={ctx.agentsById}
      dmAgentAvatarUrls={ctx.dmAgentAvatarUrls}
    />
  );
}

function canStarWorkspace(workspace: WorkspaceItem, ctx: RailRowContext): boolean {
  // Both regular workspaces and DMs can be starred (#task:1209 / #task:1252 /
  // #task:1254). Since #task:1888 a CONTAINER star does not move the row: it pins
  // it to the top of its own group (ordering, not membership). Archived rows never
  // star. The backend star route accepts regular | agent_home; the gate here just
  // mirrors that.
  return (
    (workspace.kind === 'regular' || workspace.kind === 'dm') &&
    !workspace.archived &&
    !!ctx.onStarWorkspace
  );
}

export function WorkspaceGroup<GroupKey extends SortGroup = SortGroup>({
  label,
  workspaces,
  selectedWorkspaceId,
  selectedChannelId,
  onSelectChannel,
  onCreateChannel,
  onStarWorkspace,
  onAdd,
  headerAction,
  emptyHint,
  defaultExpanded,
  persistId,
  agentsById,
  dmAgentAvatarUrls,
  sort,
}: WorkspaceGroupProps<GroupKey>): JSX.Element {
  const ctx: RailRowContext = {
    selectedWorkspaceId,
    selectedChannelId,
    onSelectChannel,
    onCreateChannel,
    onStarWorkspace,
    agentsById,
    dmAgentAvatarUrls,
  };

  return (
    <SidebarSection
      label={label}
      count={workspaces.length}
      onAdd={headerAction ? undefined : onAdd}
      action={headerAction}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
      persistId={persistId}
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
      className="touch-none"
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
 * it always belongs to the open conversation. Hierarchy is carried by the chevron
 * gutter, the lighter ink and the absence of the row vocabulary (no ink frame),
 * not by indenting the children — every glyph in the tree shares one column.
 *
 * Collapse state persists per workspace under the shared section vocabulary
 * (`silverhand:layout.sidebar-section.ws.<id>`), so the shape of the tree survives
 * a restart. REVEAL-ON-NAVIGATE: navigating to a channel expands its parent (and
 * writes that through), which is what makes the FILL reachable — a collapsed
 * parent is never given a stand-in "you are here" marker. The effect keys on
 * `selectedChannelId`, not on `expanded`, so a deliberate collapse while the
 * channel stays open is not immediately undone.
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
  const [expanded, setExpanded] = useSidebarSectionExpanded(`ws.${workspace.id}`, true);
  const mustReveal =
    ctx.selectedChannelId !== null && ctx.selectedWorkspaceId === workspace.id;
  useEffect(() => {
    if (mustReveal) setExpanded(true);
    // Deliberately NOT depending on `expanded`: this reveals on a NAVIGATION, and
    // must not fight a manual collapse of the workspace you are currently in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustReveal, ctx.selectedChannelId]);

  return (
    <>
      <WorkspaceHeaderRow
        workspace={workspace}
        ctx={ctx}
        expanded={expanded}
        onToggle={() => setExpanded()}
        dragHandleProps={dragHandleProps}
      />
      {expanded ? (
        <ul className="space-y-0.5">
          <WorkspaceChannels
            workspaceId={workspace.id}
            workspaceKind={workspace.kind}
            selectedChannelId={ctx.selectedChannelId}
            onSelectChannel={ctx.onSelectChannel}
            onCreateChannel={ctx.onCreateChannel}
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
  // DM rows show the bound agent's RAW display name — no `@`, no `· DM` suffix
  // (shiki 2026-08-01, #task:1768). This is a recognition surface (who you're
  // talking to), so it reads like a person, not a handle. Shares
  // `dmRecognitionName` with the titlebar so the two can't drift.
  const dmAgent =
    workspace.kind === 'dm' && workspace.dm_agent_id
      ? ctx.agentsById?.get(workspace.dm_agent_id)
      : undefined;
  const title =
    workspace.kind === 'dm'
      ? dmRecognitionName(workspace.name, dmAgent)
      : workspace.name;
  const icon = rowIconFor(workspace, ctx);
  const canStar = canStarWorkspace(workspace, ctx);
  const isStarred = isWorkspaceStarred(workspace);
  const unread = workspace.unread;
  // Hover-revealed actions. `group-focus-within` keeps them reachable by keyboard,
  // and `:has([data-state=open])` keeps them visible while one of their own menus
  // is open — otherwise the trigger vanishes from under an open Radix popover the
  // moment the pointer leaves the row.
  const hoverOnly =
    'opacity-0 transition-opacity group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 [&:has([data-state=open])]:opacity-100';

  const row = (
    <div
      className={
        // 28px chrome, NOT the 32px row vocabulary: no ink frame, muted ink, and a
        // transparent border that exists only to keep this row's content box on the
        // same x as a child row's (see GLYPH_COLUMN_INSET — margin + border + 4px
        // padding, then the 12px chevron gutter and a 4px gap, lands every glyph at
        // 28px from the sidebar edge).
        'sidebar-row-border group/ws flex h-7 w-full items-stretch border border-transparent pl-1 pr-2 ' +
        'text-text-muted hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary'
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center text-left text-[12.5px] font-medium"
      >
        <span className="flex w-3 shrink-0 items-center justify-center opacity-70">
          {expanded ? (
            <ChevronDown className="size-2.5" />
          ) : (
            <ChevronRight className="size-2.5" />
          )}
        </span>
        <span className="ml-1 flex shrink-0 items-center">{icon}</span>
        <span className="ml-1.5 min-w-0 truncate">{title}</span>
      </button>
      <span className="flex shrink-0 items-center gap-1 pl-1">
        {/* Mute is a two-state fact about the workspace itself, so it is present
            collapsed AND expanded. The aggregate unread badge is not: it exists to
            answer "is it worth opening this?", so it is withdrawn once the children
            that carry the same information are on screen. It is consumed exactly as
            the backend projects it — a channel that has moved into STARRED is still
            counted here (shiki's ruling: don't re-derive the projection to subtract
            it). */}
        {workspace.muted ? <MutedMarker /> : null}
        {!expanded ? (
          unread && unread > 0 ? (
            <UnreadBadge count={unread} />
          ) : workspace.active ? (
            <span className="size-1.5 rounded-full bg-success" />
          ) : null
        ) : null}
        {expanded ? (
          <span className={hoverOnly}>
            <ChannelSortMenu workspaceId={workspace.id} workspaceKind={workspace.kind} />
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => ctx.onCreateChannel(workspace.id)}
          aria-label={`New channel in ${title}`}
          title="New channel"
          className={
            'flex size-5 items-center justify-center text-text-muted hover:text-text-primary ' +
            hoverOnly
          }
        >
          <Plus className="size-3.5" />
        </button>
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
        canStar={canStar}
        isStarred={isStarred}
        onToggleStar={() => ctx.onStarWorkspace?.(workspace.id, !isStarred)}
        muteWorkspaceId={canMuteWorkspace(workspace) ? workspace.id : null}
      />
    </div>
  );
}

/** A row can flip the workspace mute suppressor when it is a REGULAR, non-archived
 *  workspace. A DM (`agent_home`) is structurally un-mutable — directed-grade
 *  traffic has no ambient floor to silence, and the DB trigger forbids the row —
 *  and an archived workspace isn't being listened to at all. */
function canMuteWorkspace(workspace: WorkspaceItem): boolean {
  return workspace.kind === 'regular' && !workspace.archived;
}

export function isWorkspaceStarred(workspace: WorkspaceItem): boolean {
  return workspace.starred_at !== null && workspace.starred_at !== undefined;
}
