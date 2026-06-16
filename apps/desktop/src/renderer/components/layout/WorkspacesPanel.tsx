import { Fragment, type ReactNode } from 'react';
import { Copy, FolderOpen, Pin, PinOff, User } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentDto, SortGroup } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';
import { AgentAvatar } from '@/components/AgentAvatar';
import {
  SortableGroup,
  animateLayoutChanges,
  deriveRowFreeze,
  sortableItemStyle,
} from '@/components/layout/list-drag-sort';
import { SidebarSection } from './sidebar-shared';

type WorkspaceUiKind = 'regular' | 'dm';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: WorkspaceUiKind;
  workspace_path: string;
  workspace_host_id: string;
  dm_agent_id: string | null;
  pinned_at?: number | null;
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
   *  `['pinned']`, `['dm']`, or `['regular']`. */
  order: GroupKey[];
  /** The hard group a workspace lives in (live pin/kind). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Post-drop bridge window — see `deriveRowFreeze`. */
  bridging: boolean;
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
  onPinWorkspace?: (id: string, pinned: boolean) => void;
  canRevealWorkspace?: (workspace: WorkspaceItem) => boolean;
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
   *  defaults to false so it stays out of the way. */
  defaultExpanded?: boolean;
  /** Lookup of all workspace agents, keyed by id. DM workspace rows resolve
   *  their `dm_agent_id` here for the agent's runtime + display name. The
   *  avatar object URLs themselves come via `dmAgentAvatarUrls` (resolved ONCE
   *  at the rail level, not per-section) so pin/unpin moving a DM between
   *  sections doesn't churn every avatar. Optional so callers without agent
   *  context still get a sane fallback. #task:919 / #task:1146 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Resolved DM-agent avatar object URLs, keyed by agent id. Owned by the
   *  parent (`Sidebar`) over the STABLE union of all rail DM agents, so this
   *  map is identical across pin/unpin/reorder — no per-section refetch flash
   *  (#task:1146). */
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** When set, the group is drag-sortable (#task:1146). */
  sort?: WorkspaceSortConfig<GroupKey>;
}

const ICON_BY_KIND: Record<WorkspaceUiKind, JSX.Element> = {
  regular: (
    <span className="inline-flex size-3.5 items-center justify-center font-serif text-[14px] font-semibold leading-none">
      W
    </span>
  ),
  dm: <User className="size-3.5" />,
};

/** Per-row context shared by the sortable + flat render paths so a row is the
 *  SAME component regardless of entry point (one entity, one shape). */
interface RailRowContext {
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onPinWorkspace?: (id: string, pinned: boolean) => void;
  canRevealWorkspace?: (workspace: WorkspaceItem) => boolean;
  agentsById?: ReadonlyMap<string, AgentDto>;
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
}

function rowIconFor(workspace: WorkspaceItem, ctx: RailRowContext): JSX.Element {
  // DM rows: render the agent's avatar (or runtime icon fallback) instead of
  // the generic `User` glyph. Falls back to `ICON_BY_KIND.dm` when the agent
  // lookup is missing or the agent is no longer in the list. #task:919
  const dmAgent =
    workspace.kind === 'dm' && workspace.dm_agent_id
      ? ctx.agentsById?.get(workspace.dm_agent_id) ?? null
      : null;
  return dmAgent ? (
    <AgentAvatar
      runtime={dmAgent.runtime}
      size={16}
      avatarObjectUrl={ctx.dmAgentAvatarUrls.get(dmAgent.id) ?? null}
      alt={dmAgent.display_name || dmAgent.name}
    />
  ) : (
    ICON_BY_KIND[workspace.kind]
  );
}

function canPinWorkspace(workspace: WorkspaceItem, ctx: RailRowContext): boolean {
  // Both regular workspaces and DMs are pinnable into the cross-kind PINNED
  // group (#task:1146 pin redesign). Archived rows never pin. The backend pin
  // route accepts regular | agent_home; the gate here just mirrors that.
  return (
    (workspace.kind === 'regular' || workspace.kind === 'dm') &&
    !workspace.archived &&
    !!ctx.onPinWorkspace
  );
}

export function WorkspaceGroup<GroupKey extends SortGroup = SortGroup>({
  label,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onPinWorkspace,
  canRevealWorkspace,
  onAdd,
  headerAction,
  emptyHint,
  defaultExpanded,
  agentsById,
  dmAgentAvatarUrls,
  sort,
}: WorkspaceGroupProps<GroupKey>): JSX.Element {
  const ctx: RailRowContext = {
    selectedWorkspaceId,
    onSelectWorkspace,
    onPinWorkspace,
    canRevealWorkspace,
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
          <SortableWorkspaceItem
            key={w.id}
            workspace={w}
            ctx={ctx}
            bridging={sort.bridging}
          />
        ))}
      </SortableGroup>
    </Fragment>
  ));
}

/** Drag-sortable rail row — the `<li>` is BOTH the sortable node AND the drag
 *  surface (listeners here, not on the inner row, so they bypass the Radix
 *  context-menu `Slot`). Whole-row drag (no grip), 4px activation. Mirrors the
 *  channel sidebar's `SortableChannelItem`; the drag style + color-freeze
 *  signals come from the shared list-drag-sort helpers. */
function SortableWorkspaceItem({
  workspace,
  ctx,
  bridging,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  bridging: boolean;
}): JSX.Element {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
    attributes,
    listeners,
  } = useSortable({ id: workspace.id, animateLayoutChanges });
  const freeze = deriveRowFreeze(isSorting, isDragging, bridging);
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <WorkspaceRow
        workspace={workspace}
        ctx={ctx}
        draggable
        freezeColorTransition={freeze.freezeColorTransition}
        freezeColorValue={freeze.freezeColorValue}
      />
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
  freezeColorTransition = false,
  freezeColorValue = false,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  /** Manual mode: show the grab cursor. Listeners live on the parent `<li>`. */
  draggable?: boolean;
  /** Freeze the color TRANSITION (drop `transition-colors`) — every row across
   *  drag + bridge. See deriveRowFreeze / docs/list-sort-v1.md §Renderer
   *  composition. */
  freezeColorTransition?: boolean;
  /** Freeze the color VALUE (strip `:hover`) — SIBLINGS only; never the dragged
   *  row (see the guardrail in deriveRowFreeze). */
  freezeColorValue?: boolean;
}): JSX.Element {
  const title = workspace.kind === 'dm' ? displayDmName(workspace.name) : workspace.name;
  const icon = rowIconFor(workspace, ctx);
  const canPin = canPinWorkspace(workspace, ctx);
  const canReveal = ctx.canRevealWorkspace?.(workspace) ?? false;
  const selected = workspace.id === ctx.selectedWorkspaceId;
  const isPinned = isWorkspacePinned(workspace);
  const unread = workspace.unread;

  // Siblings mid-drag: drop the hover classes so a row sliding under the
  // pointer can't paint a hover bg. Value-freeze — siblings only.
  const rowBg = selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : freezeColorValue
      ? 'border-transparent text-text-secondary'
      : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';

  const row = (
    <div
      data-row-selected={selected || undefined}
      className={
        'sidebar-row-border flex h-8 w-full items-stretch border ' +
        // Freeze the color transition on every row during drag + bridge so any
        // hover/selected recompute lands instantly (no ~150ms fade).
        (freezeColorTransition ? '' : 'transition-colors ') +
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
            (unread && unread > 0 && !selected ? 'font-semibold text-text-primary' : '')
          }
        >
          <span className="truncate">{title}</span>
        </span>
        {unread && unread > 0 ? (
          <span
            data-sidebar-unread
            className={
              'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ' +
              (selected ? 'bg-bg-floating text-accent' : 'bg-accent text-text-on-accent')
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
    <AppContextMenu trigger={row}>
      {canPin ? (
        <AppContextMenuItem
          icon={isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          onSelect={() => ctx.onPinWorkspace?.(workspace.id, !isPinned)}
        >
          {isPinned ? 'Unpin' : 'Pin'}
        </AppContextMenuItem>
      ) : null}
      {canPin ? <AppContextMenuSeparator /> : null}
      {canReveal ? (
        <AppContextMenuItem
          icon={<FolderOpen className="size-3.5" />}
          onSelect={() => {
            void window.agentHub.showItemInFolder(workspace.workspace_path);
          }}
        >
          Open in Finder
        </AppContextMenuItem>
      ) : null}
      <AppContextMenuItem
        icon={<Copy className="size-3.5" />}
        onSelect={() => {
          void copyWorkspacePath(workspace.workspace_path);
        }}
      >
        Copy path
      </AppContextMenuItem>
    </AppContextMenu>
  );
}

export function isWorkspacePinned(workspace: WorkspaceItem): boolean {
  return workspace.pinned_at !== null && workspace.pinned_at !== undefined;
}

async function copyWorkspacePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success('已复制路径');
  } catch {
    toast.error('复制路径失败');
  }
}

/** DM workspaces are stored as `dm-<agentName>` (see provision.ts).
 *  Strip the prefix in the sidebar so the user just sees `@<agentName>`. */
function displayDmName(stored: string): string {
  return stored.startsWith('dm-') ? `@${stored.slice(3)}` : stored;
}
