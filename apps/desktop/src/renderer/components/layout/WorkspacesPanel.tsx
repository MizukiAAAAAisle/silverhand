import { Fragment, type ReactNode } from 'react';
import type { AgentDto, SortGroup } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
} from '@/components/layout/list-drag-sort';
import { SidebarSection } from './sidebar-shared';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { dmWorkspaceLabel } from '@/lib/workspace-name';
import { railRowTierClass, railSelectionTier } from '@/lib/rail-selection';

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
  /** True for soft-archived workspaces — drives the Archived sidebar
   *  group; the row itself looks the same once you're inside it. */
  archived?: boolean;
  /** Creation time — stable fallback/tiebreak for the viewer sort modes
   *  (#task:1146). */
  created_at: number;
}

/** Live drag-sort wiring for ONE sortable group (#task:1146). When present,
 *  `WorkspaceGroup` partitions its (already-ordered) workspaces into the
 *  `order` hard sub-groups — each its own DnD context, dividers between — and
 *  renders draggable rows. Absent → a plain non-sortable list (the Archived
 *  group). The drag state machine itself lives in the shared `useListDragSort`
 *  (owned by `Sidebar`); this just carries the per-row callbacks down. */
export interface WorkspaceSortConfig<GroupKey extends SortGroup = SortGroup> {
  /** Sub-group render order. Each rail section now drives a single group:
   *  `['dm']` or `['regular']` (a starred ws/DM is MOVED to the global STARRED
   *  list, not a rail group — #task:1252 / #task:1254). */
  order: GroupKey[];
  /** The hard group a workspace lives in (by kind: dm | regular). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Commit a group's new full order. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

interface WorkspaceGroupProps<GroupKey extends SortGroup = SortGroup> {
  label: string;
  /** Default kind for icon picking when a row's `kind` is the same.
   *  For mixed groups (e.g. Archived combines DM + regular) the per-row
   *  `w.kind` wins. Kept on the group for the empty-state messaging. */
  kind: WorkspaceUiKind;
  workspaces: WorkspaceItem[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onStarWorkspace?: (id: string, starred: boolean) => void;
  localWorkspacePaths: ReadonlyMap<string, string>;
  /** Optional `+` button. DM groups omit this — DM workspaces are
   *  auto-created when an agent is provisioned. Ignored when `headerAction`
   *  is set (the caller composes its own action cluster, e.g. sort + add). */
  onAdd?: () => void;
  /** Header right-slot content (e.g. the sort menu, or sort + add). Takes
   *  precedence over `onAdd`. */
  headerAction?: ReactNode;
  /** Shown when `workspaces` is empty. */
  emptyHint?: ReactNode;
  /** Whether the group starts expanded. Defaults to true; archive group
   *  defaults to false so it stays out of the way. With `persistId` this is
   *  only the first-run value. */
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
  /** When set, the group is drag-sortable (#task:1146). */
  sort?: WorkspaceSortConfig<GroupKey>;
}

/** Per-row context shared by the sortable + flat render paths so a row is the
 *  SAME component regardless of entry point (one entity, one shape). */
interface RailRowContext {
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onStarWorkspace?: (id: string, starred: boolean) => void;
  localWorkspacePaths: ReadonlyMap<string, string>;
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
  // Both regular workspaces and DMs can be starred into the global STARRED list
  // (#task:1209 / #task:1252 / #task:1254); star MOVES the row out of its rail
  // kind group into STARRED (home rank kept as an orphan, restored on unstar).
  // Archived rows never star. The backend star route accepts regular |
  // agent_home; the gate here just mirrors that.
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
  onSelectWorkspace,
  onStarWorkspace,
  localWorkspacePaths,
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
    onSelectWorkspace,
    onStarWorkspace,
    localWorkspacePaths,
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
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? '空'}</li>
      ) : sort ? (
        renderSortableGroups(workspaces, sort, ctx)
      ) : (
        workspaces.map(w => (
          <li key={w.id}>
            <WorkspaceRow workspace={w} ctx={ctx} />
          </li>
        ))
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

/** Drag-sortable rail row — the `<li>` is BOTH the sortable node AND the drag
 *  surface (listeners here, not on the inner row, so they bypass the Radix
 *  context-menu `Slot`). Whole-row drag (no grip), 4px activation. Mirrors the
 *  channel sidebar's `SortableChannelItem`; the drag style comes from the
 *  shared list-drag-sort helpers. */
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
      {...attributes}
      {...listeners}
    >
      <WorkspaceRow workspace={workspace} ctx={ctx} draggable />
    </li>
  );
}

/** The workspace rail row + its context menu. One component for every entry
 *  point (sortable DM / regular, flat archived) so the row never differs by
 *  origin (#task:1146; one entity, one shape). The context menu lives INSIDE
 *  the row (like `ChannelRow`) so the sortable `<li>` above can own the drag
 *  listeners without the Radix `Slot` swallowing them. */
function WorkspaceRow({
  workspace,
  ctx,
  draggable,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  /** Manual mode: show the grab cursor. Listeners live on the parent `<li>`. */
  draggable?: boolean;
}): JSX.Element {
  const title = workspace.kind === 'dm' ? dmWorkspaceLabel(workspace.name) : workspace.name;
  const icon = rowIconFor(workspace, ctx);
  const canStar = canStarWorkspace(workspace, ctx);
  const workspacePath = ctx.localWorkspacePaths.get(workspace.id) ?? null;
  // Selection rule (#task:1254): the workspace/DM row is `primary` iff it is the
  // selected workspace. Channels never appear in the rail/STARRED, so an open
  // channel just leaves its parent workspace selected. One function
  // (`railSelectionTier`) so rail and STARRED can't drift.
  const tier = railSelectionTier(
    { kind: workspace.kind === 'dm' ? 'dm' : 'workspace', workspaceId: workspace.id },
    ctx.selectedWorkspaceId,
  );
  const isPrimary = tier === 'primary';
  const isStarred = isWorkspaceStarred(workspace);
  const unread = workspace.unread;

  const rowBg = railRowTierClass(tier);

  const row = (
    <div
      data-row-selected={isPrimary || undefined}
      className={
        'sidebar-row-border flex h-8 w-full items-stretch border ' +
        // No `transition-colors`: selected/hover switch instantly (#task:1162).
        // Selected is a discrete committed state — fading it read as the
        // leaving-row "flicker". Mirrors ChannelRow.
        rowBg +
        (draggable ? ' cursor-grab select-none active:cursor-grabbing' : '')
      }
    >
      <button
        type="button"
        onClick={() => ctx.onSelectWorkspace(workspace.id)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm leading-[16px]"
      >
        <span className="shrink-0 text-text-muted">{icon}</span>
        <span
          className={
            'flex min-w-0 flex-1 items-baseline gap-1.5 ' +
            (unread && unread > 0 && !isPrimary ? 'font-semibold text-text-primary' : '')
          }
        >
          <span className="truncate">{title}</span>
        </span>
        {unread && unread > 0 ? (
          <span
            data-sidebar-unread
            className={
              'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ' +
              (isPrimary ? 'bg-bg-floating text-accent' : 'bg-accent text-text-on-accent')
            }
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : workspace.active ? (
          <span className="size-1.5 rounded-full bg-success" />
        ) : null}
      </button>
    </div>
  );

  return (
    <WorkspaceContextMenu
      trigger={row}
      canStar={canStar}
      isStarred={isStarred}
      onToggleStar={() => ctx.onStarWorkspace?.(workspace.id, !isStarred)}
      canReveal={workspacePath !== null}
      workspacePath={workspacePath}
    />
  );
}

export function isWorkspaceStarred(workspace: WorkspaceItem): boolean {
  return workspace.starred_at !== null && workspace.starred_at !== undefined;
}
