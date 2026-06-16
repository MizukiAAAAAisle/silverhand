import { useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Hash,
  Pin,
  PinOff,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelNode {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  status: 'active' | 'idle' | 'crashed';
  parent_channel_id: string | null;
  closed_at: number | null;
  pinned_at: number | null;
  archived_at: number | null;
}

interface ChannelsSidebarProps {
  /** null when no workspace is selected — used only to choose the empty
   *  hint copy. Workspace name + actions live in the titlebar now. */
  workspaceName: string | null;
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
  onPinChannel: (channelId: string, pinned: boolean) => void;
  onArchiveChannel: (channelId: string, archived: boolean) => void;
  archivePending?: boolean;
  /** Unread notification counts keyed by channel id. Used to render
   *  per-channel badges. Missing key ≡ zero. */
  unreadByChannel?: Record<string, number>;
}

export function ChannelsSidebar({
  workspaceName,
  channels,
  workspaceKind,
  selectedChannelId,
  onSelectChannel,
  onPinChannel,
  onArchiveChannel,
  archivePending = false,
  unreadByChannel = {},
}: ChannelsSidebarProps): JSX.Element {
  // The sidebar renders top-level channels only. Threads are reply
  // clusters under a message now, not conversation nodes, so they are
  // never shown here (legacy `kind='thread'` rows carry a
  // `parent_channel_id` and are excluded by this filter). Pinned channels
  // float above unpinned ones — the backend already returns them sorted,
  // we split here only to render an optional separator between the groups.
  const topLevel = channels.filter(s => s.parent_channel_id === null);
  const pinnedTop = topLevel.filter(s => s.pinned_at !== null);
  const unpinnedTop = topLevel.filter(s => s.pinned_at === null);

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
      <div className="scrollbar-hide flex-1 overflow-y-auto px-1.5 py-1.5">
        {!workspaceName ? (
          <EmptyHint message="选择左侧 Workspace" />
        ) : topLevel.length === 0 ? (
          <EmptyHint message="还没有 Channel。点 + 开始" />
        ) : (
          <ul className="space-y-0.5">
            {pinnedTop.map(top => (
              <ChannelTreeItem
                key={top.id}
                channel={top}
                selectedChannelId={selectedChannelId}
                onSelect={onSelectChannel}
                onPin={onPinChannel}
                onArchive={onArchiveChannel}
                archivePending={archivePending}
                workspaceKind={workspaceKind}
                unreadByChannel={unreadByChannel}
              />
            ))}
            {pinnedTop.length > 0 && unpinnedTop.length > 0 ? (
              <li>
                <div className="mx-2 my-1 border-t border-border-subtle" />
              </li>
            ) : null}
            {unpinnedTop.map(top => (
              <ChannelTreeItem
                key={top.id}
                channel={top}
                selectedChannelId={selectedChannelId}
                onSelect={onSelectChannel}
                onPin={onPinChannel}
                onArchive={onArchiveChannel}
                archivePending={archivePending}
                workspaceKind={workspaceKind}
                unreadByChannel={unreadByChannel}
              />
            ))}
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

function ChannelTreeItem({
  channel,
  selectedChannelId,
  onSelect,
  onPin,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
}: {
  channel: ChannelNode;
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
  onPin: (channelId: string, pinned: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadByChannel: Record<string, number>;
}): JSX.Element {
  return (
    <li>
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onPin={onPin}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
      />
    </li>
  );
}

function ChannelRow({
  channel,
  selected,
  onClick,
  onPin,
  onArchive,
  archivePending,
  workspaceKind,
  unreadCount,
}: {
  channel: ChannelNode;
  selected: boolean;
  onClick: () => void;
  onPin: (channelId: string, pinned: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadCount: number;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isPinned = channel.pinned_at !== null;
  const isArchived = channel.archived_at !== null;
  const [hovered, setHovered] = useState(false);

  // Pin control shows on hover or when already pinned. A sibling <button>
  // is used — not a nested interactive — so keyboard focus and click
  // semantics are correct. stopPropagation prevents the row click handler
  // from firing when the pin button is activated.
  const showPin = hovered || isPinned;
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
      className={'sidebar-row-border flex w-full items-stretch border transition-colors ' + rowBg}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Channel select button — grows to fill the row */}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left text-sm"
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
        {unreadCount > 0 && !selected ? (
          <span data-sidebar-unread className="ml-auto shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[16px] text-text-on-accent">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {/* Pin button — sibling, not nested. Reserves fixed width so the
          title doesn't shift on hover. */}
      <button
        type="button"
        aria-label={isPinned ? '取消固定' : '固定'}
        title={isPinned ? '取消固定' : '固定'}
        onClick={e => {
          e.stopPropagation();
          onPin(channel.id, !isPinned);
        }}
        className={
          'group/pin flex shrink-0 items-center justify-center px-1 ' +
          (!showPin ? 'pointer-events-none opacity-0' : '') +
          (selected
            ? isPinned
              ? ' text-text-on-selected'
              : ' text-text-on-selected/60 hover:text-text-on-selected'
            : isPinned
              ? ' text-accent'
              : ' text-text-muted hover:text-text-primary')
        }
        tabIndex={showPin ? 0 : -1}
      >
        {isPinned ? (
          <PinOff data-pin-icon className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        ) : (
          <Pin data-pin-icon className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        )}
      </button>
    </div>
  );

  return (
    <AppContextMenu trigger={row}>
      <AppContextMenuItem
        icon={
          isPinned ? (
            <PinOff className="size-3.5" />
          ) : (
            <Pin className="size-3.5" />
          )
        }
        onSelect={() => onPin(channel.id, !isPinned)}
      >
        {isPinned ? 'Unpin' : 'Pin'}
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
