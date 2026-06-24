import { type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Hash,
  Plus,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';
import { SidebarSectionHeader } from '@/components/layout/sidebar-shared';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
  useListDragSort,
} from '@/components/layout/list-drag-sort';
import { Button } from '@/components/ui/button';
import { useChannelSortState, useSetSortMode } from '@/features/workspaces/hooks';
import { sortModeOf } from '@/lib/viewer-sort';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelNode {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  status: 'active' | 'idle' | 'crashed';
  parent_channel_id: string | null;
  closed_at: number | null;
  starred_at: number | null;
  archived_at: number | null;
  /** Creation time — stable fallback/tiebreak for sort modes (#task:1146). */
  created_at: number;
}

interface ChannelsSidebarProps {
  /** null when no workspace is selected — used only to choose the empty
   *  hint copy. Workspace name + workspace-level actions live in the
   *  titlebar; channel-list-level actions (create + sort) live in this
   *  sidebar's own header (#task:1146). */
  workspaceName: string | null;
  /** The selected workspace id — drives the viewer's per-list sort state
   *  (`channels:<id>`) + reorder/mode mutations. null when none selected. */
  workspaceId: string | null;
  /** Active (non-archived) top-level channels, server-filtered. In the
   *  reply-cluster model a thread is no longer a conversation node, so it
   *  never appears in this tree — the sidebar only renders top-level
   *  channels / DM channels. Any legacy `kind='thread'` row (which carries
   *  a `parent_channel_id`) is filtered out below. Archived channels live
   *  on a dedicated chat tool page. */
  channels: ChannelNode[];
  workspaceKind: WorkspaceUiKind | null;
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onStarChannel: (channelId: string, starred: boolean) => void;
  onArchiveChannel: (channelId: string, archived: boolean) => void;
  /** Create a channel — moved here from the titlebar (#task:1146). Absent
   *  when creation isn't applicable (no workspace selected / not in channel
   *  view); when absent the header shows the sort entry only. */
  onCreateChannel?: () => void;
  archivePending?: boolean;
  /** Unread notification counts keyed by channel id. Used to render
   *  per-channel badges. Missing key ≡ zero. */
  unreadByChannel?: Record<string, number>;
}

export function ChannelsSidebar({
  workspaceName,
  workspaceId,
  channels,
  workspaceKind,
  selectedChannelId,
  onSelectChannel,
  onStarChannel,
  onArchiveChannel,
  onCreateChannel,
  archivePending = false,
  unreadByChannel = {},
}: ChannelsSidebarProps): JSX.Element {
  const { data: viewerSort } = useChannelSortState(workspaceId, workspaceKind);
  const setSortMode = useSetSortMode();

  const listKey = workspaceId ? `channels:${workspaceId}` : null;
  const mode = sortModeOf(viewerSort);

  // The sidebar renders top-level channels only (threads are reply clusters
  // now, never conversation nodes). Starred channels are a hard top group;
  // within each group the viewer's sort mode orders the rows — recent-opened
  // (last_accessed_at) or manual drag (rank). See docs/list-sort-v1.md. Star is
  // the personal ⭐ favorite, read off the viewer's `viewer_sort.entries[].
  // starred_at` (joined onto each node's `starred_at` upstream), never a shared
  // field (#task:1209). The drag state machine (synchronous drop override,
  // settle guard) lives in useListDragSort — shared with the workspace rail so
  // the CDP-tuned drop invariants can't drift between the two surfaces.
  // Partition stays here (consumer owns star/kind grouping).
  const topLevel = channels.filter(s => s.parent_channel_id === null);
  const { orderedGroups, onReorder } = useListDragSort<
    'starred' | 'unstarred',
    ChannelNode
  >({
    listKey,
    groups: {
      starred: topLevel.filter(s => s.starred_at !== null),
      unstarred: topLevel.filter(s => s.starred_at === null),
    },
    viewerSort,
    getId: c => c.id,
    getCreatedAt: c => c.created_at,
  });
  const starredTop = orderedGroups.starred;
  const unstarredTop = orderedGroups.unstarred;

  const rowProps = {
    selectedChannelId,
    onSelect: onSelectChannel,
    onStar: onStarChannel,
    onArchive: onArchiveChannel,
    archivePending,
    workspaceKind,
    unreadByChannel,
  };

  const renderGroup = (
    group: ChannelNode[],
    groupKey: 'starred' | 'unstarred',
  ): ReactNode => {
    if (listKey) {
      const ids = group.map(c => c.id);
      return (
        <SortableGroup ids={ids} onReorder={ordered => onReorder(groupKey, ordered)}>
          {group.map(channel => (
            <SortableChannelItem key={channel.id} channel={channel} {...rowProps} />
          ))}
        </SortableGroup>
      );
    }
    return group.map(channel => (
      <ChannelTreeItem key={channel.id} channel={channel} {...rowProps} />
    ));
  };

  return (
    <aside
      data-sidebar="channels"
      className="flex h-full w-[var(--channels-sidebar-width)] shrink-0 flex-col bg-[var(--bg-sessions-sidebar)]"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      {workspaceName ? (
        <div className="shrink-0 px-1.5 pt-1.5">
          <SidebarSectionHeader
            label="CHANNELS"
            count={topLevel.length}
            action={
              <span className="flex items-center">
                <SortModeMenu
                  mode={mode}
                  onChange={m =>
                    listKey && setSortMode.mutate({ list_key: listKey, mode: m })
                  }
                />
                {onCreateChannel ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={onCreateChannel}
                    aria-label="新建 Channel"
                    title="新建 Channel"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                ) : null}
              </span>
            }
          />
        </div>
      ) : null}

      <div className="scrollbar-hide flex-1 overflow-y-auto px-1.5 pb-1.5">
        {!workspaceName ? (
          <EmptyHint message="选择左侧 Workspace" />
        ) : topLevel.length === 0 ? (
          <EmptyHint message="还没有 Channel。点 + 开始" />
        ) : (
          <ul className="space-y-0.5">
            {renderGroup(starredTop, 'starred')}
            {starredTop.length > 0 && unstarredTop.length > 0 ? (
              <li>
                <div className="mx-2 my-1 border-t border-border-subtle" />
              </li>
            ) : null}
            {renderGroup(unstarredTop, 'unstarred')}
          </ul>
        )}
      </div>
    </aside>
  );
}

function EmptyHint({ message }: { message: string }): JSX.Element {
  return (
    <div className="px-2 py-3 text-center text-xs text-text-muted">{message}</div>
  );
}

interface RowChildProps {
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
  onStar: (channelId: string, starred: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadByChannel: Record<string, number>;
}

function ChannelTreeItem({
  channel,
  selectedChannelId,
  onSelect,
  onStar,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
}: { channel: ChannelNode } & RowChildProps): JSX.Element {
  return (
    <li>
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onStar={onStar}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
      />
    </li>
  );
}

// Animate sibling rows WHILE sorting (the smooth "make way" slide as you drag
// over them), but skip dnd-kit's post-drop settle animation — see
// `animateLayoutChanges` in list-drag-sort.tsx (shared with the rail).

/** Drag-sortable row for manual ordering. The `<li>` is BOTH the sortable
 *  node (`setNodeRef`) AND the drag surface — the dnd-kit `attributes` +
 *  `listeners` live here, not on the inner row, so they don't have to pass
 *  through the Radix context-menu `Slot` (which was swallowing the pointer
 *  activation). The whole row drags (no grip — per shiki); a 4px pointer
 *  activation distance keeps a plain click selecting. Vertical-only. The drag
 *  STYLE (transform/opacity-lift) comes from the shared list-drag-sort helpers
 *  so it stays identical to the rail's row. */
function SortableChannelItem({
  channel,
  selectedChannelId,
  onSelect,
  onStar,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
}: { channel: ChannelNode } & RowChildProps): JSX.Element {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id: channel.id, animateLayoutChanges });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onStar={onStar}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
        draggable
      />
    </li>
  );
}

function ChannelRow({
  channel,
  selected,
  onClick,
  onStar,
  onArchive,
  archivePending,
  workspaceKind,
  unreadCount,
  draggable,
}: {
  channel: ChannelNode;
  selected: boolean;
  onClick: () => void;
  onStar: (channelId: string, starred: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadCount: number;
  /** Manual mode: show the grab cursor so the row reads as draggable. The
   *  drag listeners live on the parent `<li>`, not here. */
  draggable?: boolean;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isStarred = channel.starred_at !== null;
  const isArchived = channel.archived_at !== null;
  // Archive/Restore is a channel-like organization action (#task:1145):
  // it applies to any top-level channel-like row — `channel` in a regular
  // workspace AND `dm_channel` in an agent_home/DM — and only excludes
  // threads. `channel.kind` is the precise discriminant, so we no longer
  // gate on the workspace `workspaceKind` beyond "a workspace is selected".
  const showArchiveMenu =
    workspaceKind !== null &&
    (channel.kind === 'channel' || channel.kind === 'dm_channel');
  const hasManagementMenu = showArchiveMenu;

  const rowBg = selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';

  const row = (
    <div
      data-row-selected={selected || undefined}
      className={
        'sidebar-row-border flex h-8 w-full items-stretch border px-2 ' +
        // No `transition-colors`: selected/hover switch instantly (#task:1162).
        // Selected is a discrete, already-committed state — fading it over 150ms
        // is what read as the leaving-row "flicker" (and the entering row "slow
        // to light up"). A discrete state must commit instantly; only hover (a
        // pointer-driven continuous affordance) ever earned the fade, and the
        // cost of keeping it (the whole drag-time color-freeze apparatus) wasn't
        // worth it. Hover now switches instantly too.
        rowBg +
        (draggable ? ' cursor-grab select-none active:cursor-grabbing' : '')
      }
    >
      {/* Channel select button — grows to fill the row */}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
      >
        <Hash
          data-channel-icon
          className={
            'size-3.5 shrink-0 ' +
            (isClosed ? 'text-text-muted/50' : 'text-text-muted')
          }
        />
        <span
          className={
            'min-w-0 truncate ' + (isClosed ? 'line-through text-text-muted' : '')
          }
        >
          {channel.title}
        </span>
        {unreadCount > 0 ? (
          <span data-sidebar-unread className="ml-auto shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[16px] text-text-on-accent">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );

  return (
    <AppContextMenu trigger={row}>
      <AppContextMenuItem
        icon={<Star className={'size-3.5' + (isStarred ? ' fill-current' : '')} />}
        onSelect={() => onStar(channel.id, !isStarred)}
      >
        {isStarred ? 'Unstar' : 'Star'}
      </AppContextMenuItem>
      {showArchiveMenu ? (
        <AppContextMenuItem
          icon={
            isArchived ? (
              <ArchiveRestore className="size-3.5" />
            ) : (
              <Archive className="size-3.5" />
            )
          }
          disabled={archivePending}
          onSelect={() => onArchive(channel.id, !isArchived)}
        >
          {isArchived ? 'Restore' : 'Archive'}
        </AppContextMenuItem>
      ) : null}
      {hasManagementMenu ? <AppContextMenuSeparator /> : null}
      <AppContextMenuItem
        icon={<Copy className="size-3.5" />}
        onSelect={() => {
          void copyChannelName(channel.title);
        }}
      >
        Copy name
      </AppContextMenuItem>
    </AppContextMenu>
  );
}

async function copyChannelName(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    toast.success('已复制名称');
  } catch {
    toast.error('复制名称失败');
  }
}
