import { useState } from 'react';
import { MessageSquare, Pin, PinOff } from 'lucide-react';

interface ChannelNode {
  id: string;
  title: string;
  status: 'active' | 'idle' | 'crashed';
  parent_channel_id: string | null;
  closed_at: number | null;
  pinned_at: number | null;
}

interface ChannelsSidebarProps {
  /** null when no workspace is selected — used only to choose the empty
   *  hint copy. Workspace name + actions live in the titlebar now. */
  workspaceName: string | null;
  channels: ChannelNode[];
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onPinChannel: (channelId: string, pinned: boolean) => void;
  /** Unread notification counts keyed by channel id. Used to render
   *  per-channel badges. Missing key ≡ zero. */
  unreadByChannel?: Record<string, number>;
}

export function ChannelsSidebar({
  workspaceName,
  channels,
  selectedChannelId,
  onSelectChannel,
  onPinChannel,
  unreadByChannel = {},
}: ChannelsSidebarProps): JSX.Element {
  // Pinned top-level channels float above unpinned ones. The backend
  // already returns them sorted correctly, but we split here so we can
  // render an optional separator between the two groups.
  const topLevel = channels.filter(s => s.parent_channel_id === null);
  const pinnedTop = topLevel.filter(s => s.pinned_at !== null);
  const unpinnedTop = topLevel.filter(s => s.pinned_at === null);
  const childrenByParent = new Map<string, ChannelNode[]>();
  for (const s of channels) {
    if (s.parent_channel_id) {
      const list = childrenByParent.get(s.parent_channel_id) ?? [];
      list.push(s);
      childrenByParent.set(s.parent_channel_id, list);
    }
  }

  return (
    <aside className="flex h-full w-[var(--channels-sidebar-width)] shrink-0 flex-col border-r border-border-subtle bg-[var(--bg-sessions-sidebar)]">
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
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
                childChannels={childrenByParent.get(top.id) ?? []}
                selectedChannelId={selectedChannelId}
                onSelect={onSelectChannel}
                onPin={onPinChannel}
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
                childChannels={childrenByParent.get(top.id) ?? []}
                selectedChannelId={selectedChannelId}
                onSelect={onSelectChannel}
                onPin={onPinChannel}
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
  childChannels,
  selectedChannelId,
  onSelect,
  onPin,
  unreadByChannel,
}: {
  channel: ChannelNode;
  childChannels: ChannelNode[];
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
  onPin: (channelId: string, pinned: boolean) => void;
  unreadByChannel: Record<string, number>;
}): JSX.Element {
  return (
    <li>
      <ChannelRow
        channel={channel}
        depth={0}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onPin={onPin}
        unreadCount={unreadByChannel[channel.id] ?? 0}
      />
      {childChannels.length > 0 ? (
        <ul className="space-y-0.5">
          {childChannels.map(child => (
            <li key={child.id}>
              <ChannelRow
                channel={child}
                depth={1}
                selected={child.id === selectedChannelId}
                onClick={() => onSelect(child.id)}
                onPin={onPin}
                unreadCount={unreadByChannel[child.id] ?? 0}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ChannelRow({
  channel,
  depth,
  selected,
  onClick,
  onPin,
  unreadCount,
}: {
  channel: ChannelNode;
  depth: 0 | 1;
  selected: boolean;
  onClick: () => void;
  onPin: (channelId: string, pinned: boolean) => void;
  unreadCount: number;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isPinned = channel.pinned_at !== null;
  const [hovered, setHovered] = useState(false);

  // Show the pin control only for top-level channels (threads can't be
  // pinned), and only on hover or when already pinned. A sibling <button>
  // is used — not a nested interactive — so keyboard focus and click
  // semantics are correct. stopPropagation prevents the row click handler
  // from firing when the pin button is activated.
  const showPin = depth === 0 && (hovered || isPinned);

  const rowBg = selected
    ? 'border-accent bg-bg-selected text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary';

  return (
    <div
      className={'flex w-full items-stretch border-2 transition-colors ' + rowBg}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Channel select button — grows to fill the row */}
      <button
        type="button"
        onClick={onClick}
        className={
          'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm ' +
          (depth === 1 ? 'pl-6' : 'pl-2')
        }
      >
        {depth === 1 ? (
          <span className="text-text-muted/60">↳</span>
        ) : null}
        <MessageSquare
          className={
            'size-3.5 shrink-0 ' +
            (isClosed ? 'text-text-muted/50' : 'text-text-muted')
          }
        />
        <span
          className={
            'size-1.5 shrink-0 rounded-full ' +
            (isClosed
              ? 'bg-text-muted/30'
              : channel.status === 'active'
                ? 'bg-success'
                : channel.status === 'crashed'
                  ? 'bg-error'
                  : 'bg-text-muted/50')
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
          <span className="ml-auto shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[16px] text-text-on-accent">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {/* Pin button — sibling, not nested. Reserves fixed width so the
          title doesn't shift on hover. */}
      {depth === 0 ? (
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
            <PinOff className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
          ) : (
            <Pin className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
          )}
        </button>
      ) : null}
    </div>
  );
}
