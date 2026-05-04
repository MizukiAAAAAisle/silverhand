import { useState } from 'react';
import { MessageSquare, Pin, PinOff } from 'lucide-react';

interface SessionNode {
  id: string;
  title: string;
  status: 'active' | 'idle' | 'crashed';
  parent_session_id: string | null;
  closed_at: number | null;
  pinned_at: number | null;
}

interface SessionsSidebarProps {
  /** null when no channel is selected — used only to choose the empty
   *  hint copy. Channel name + actions live in the titlebar now. */
  channelName: string | null;
  sessions: SessionNode[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onPinSession: (sessionId: string, pinned: boolean) => void;
  /** Unread notification counts keyed by session id. Used to render
   *  per-session badges. Missing key ≡ zero. */
  unreadBySession?: Record<string, number>;
}

export function SessionsSidebar({
  channelName,
  sessions,
  selectedSessionId,
  onSelectSession,
  onPinSession,
  unreadBySession = {},
}: SessionsSidebarProps): JSX.Element {
  // Pinned top-level sessions float above unpinned ones. The backend
  // already returns them sorted correctly, but we split here so we can
  // render an optional separator between the two groups.
  const topLevel = sessions.filter(s => s.parent_session_id === null);
  const pinnedTop = topLevel.filter(s => s.pinned_at !== null);
  const unpinnedTop = topLevel.filter(s => s.pinned_at === null);
  const childrenByParent = new Map<string, SessionNode[]>();
  for (const s of sessions) {
    if (s.parent_session_id) {
      const list = childrenByParent.get(s.parent_session_id) ?? [];
      list.push(s);
      childrenByParent.set(s.parent_session_id, list);
    }
  }

  return (
    <aside className="flex h-full w-[var(--sessions-sidebar-width)] shrink-0 flex-col border-r border-border-subtle bg-[var(--bg-sessions-sidebar)]">
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {!channelName ? (
          <EmptyHint message="选择左侧频道" />
        ) : topLevel.length === 0 ? (
          <EmptyHint message="还没有会话。点 + 开始" />
        ) : (
          <ul className="space-y-0.5">
            {pinnedTop.map(top => (
              <SessionTreeItem
                key={top.id}
                session={top}
                childSessions={childrenByParent.get(top.id) ?? []}
                selectedSessionId={selectedSessionId}
                onSelect={onSelectSession}
                onPin={onPinSession}
                unreadBySession={unreadBySession}
              />
            ))}
            {pinnedTop.length > 0 && unpinnedTop.length > 0 ? (
              <li>
                <div className="mx-2 my-1 border-t border-border-subtle" />
              </li>
            ) : null}
            {unpinnedTop.map(top => (
              <SessionTreeItem
                key={top.id}
                session={top}
                childSessions={childrenByParent.get(top.id) ?? []}
                selectedSessionId={selectedSessionId}
                onSelect={onSelectSession}
                onPin={onPinSession}
                unreadBySession={unreadBySession}
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

function SessionTreeItem({
  session,
  childSessions,
  selectedSessionId,
  onSelect,
  onPin,
  unreadBySession,
}: {
  session: SessionNode;
  childSessions: SessionNode[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onPin: (sessionId: string, pinned: boolean) => void;
  unreadBySession: Record<string, number>;
}): JSX.Element {
  return (
    <li>
      <SessionRow
        session={session}
        depth={0}
        selected={session.id === selectedSessionId}
        onClick={() => onSelect(session.id)}
        onPin={onPin}
        unreadCount={unreadBySession[session.id] ?? 0}
      />
      {childSessions.length > 0 ? (
        <ul className="space-y-0.5">
          {childSessions.map(child => (
            <li key={child.id}>
              <SessionRow
                session={child}
                depth={1}
                selected={child.id === selectedSessionId}
                onClick={() => onSelect(child.id)}
                onPin={onPin}
                unreadCount={unreadBySession[child.id] ?? 0}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SessionRow({
  session,
  depth,
  selected,
  onClick,
  onPin,
  unreadCount,
}: {
  session: SessionNode;
  depth: 0 | 1;
  selected: boolean;
  onClick: () => void;
  onPin: (sessionId: string, pinned: boolean) => void;
  unreadCount: number;
}): JSX.Element {
  const isClosed = session.closed_at !== null;
  const isPinned = session.pinned_at !== null;
  const [hovered, setHovered] = useState(false);

  // Show the pin control only for top-level sessions (threads can't be
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
      {/* Session select button — grows to fill the row */}
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
              : session.status === 'active'
                ? 'bg-success'
                : session.status === 'crashed'
                  ? 'bg-error'
                  : 'bg-text-muted/50')
          }
        />
        <span
          className={
            'min-w-0 truncate ' + (isClosed ? 'line-through text-text-muted' : '')
          }
        >
          {session.title}
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
            onPin(session.id, !isPinned);
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
