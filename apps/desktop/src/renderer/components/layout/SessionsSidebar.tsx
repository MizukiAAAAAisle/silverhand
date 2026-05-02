import { MessageSquare } from 'lucide-react';

interface SessionNode {
  id: string;
  title: string;
  status: 'active' | 'idle' | 'crashed';
  parent_session_id: string | null;
  closed_at: number | null;
}

interface SessionsSidebarProps {
  /** null when no channel is selected — used only to choose the empty
   *  hint copy. Channel name + actions live in the titlebar now. */
  channelName: string | null;
  sessions: SessionNode[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}

export function SessionsSidebar({
  channelName,
  sessions,
  selectedSessionId,
  onSelectSession,
}: SessionsSidebarProps): JSX.Element {
  // Build tree view: top-level sessions, with their children listed below.
  const topLevel = sessions.filter(s => s.parent_session_id === null);
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
            {topLevel.map(top => (
              <SessionTreeItem
                key={top.id}
                session={top}
                childSessions={childrenByParent.get(top.id) ?? []}
                selectedSessionId={selectedSessionId}
                onSelect={onSelectSession}
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
}: {
  session: SessionNode;
  childSessions: SessionNode[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <li>
      <SessionRow
        session={session}
        depth={0}
        selected={session.id === selectedSessionId}
        onClick={() => onSelect(session.id)}
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
}: {
  session: SessionNode;
  depth: 0 | 1;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const isClosed = session.closed_at !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center gap-1.5 border-2 py-1.5 pr-2 text-left text-sm transition-colors ' +
        (depth === 1 ? 'pl-6 ' : 'pl-2 ') +
        (selected
          ? 'border-accent bg-bg-selected text-text-on-selected'
          : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary')
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
          'truncate ' + (isClosed ? 'line-through text-text-muted' : '')
        }
      >
        {session.title}
      </span>
    </button>
  );
}
