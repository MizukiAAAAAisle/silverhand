import { Loader2, X } from 'lucide-react';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import type { StreamUnreadDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { useMessageRenderContext } from '@/components/chat/useMessageRenderContext';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useConversationUnread } from '@/features/channels/hooks';
import {
  useChannelThreads,
  type ThreadSummary,
} from '@/features/channels/useChannelThreads';

interface ChannelThreadsPanelProps {
  channelId: string;
  workspaceId: string;
  /** Parent channel title, shown in the header. */
  parentTitle?: string | null;
  onClose: () => void;
  /** Open one thread: App wires this to `nav.openThread(rootMessageId)`,
   *  which replaces this list with the `ThreadPanel` for that thread. */
  onOpenThread: (rootMessageId: string) => void;
}

type Author = ThreadSummary['root_author'];

/**
 * Right-pane index of every reply-cluster in one channel (#task:1073, P2).
 * Threads are otherwise discoverable only by the inline reply badge on each
 * message row — invisible in a busy channel. This list surfaces them all,
 * newest activity first, one click to open the existing `ThreadPanel`.
 *
 * A thread is NOT a conversation (it shares the parent channel's context), so
 * — like the reply-cluster pane — this panel renders outside the
 * conversation-bound `secondaryDescriptor` system and reads its own
 * channel-scoped aggregate via `useChannelThreads`.
 */
export function ChannelThreadsPanel({
  channelId,
  workspaceId,
  parentTitle,
  onClose,
  onOpenThread,
}: ChannelThreadsPanelProps): JSX.Element {
  const { threads, isLoading, isError } = useChannelThreads(channelId);
  // Per-viewer server-scored unread, read from the SAME read-model the reply
  // chip reads (#task:1226) — one source of truth, no second unread fact on
  // `ThreadSummary`. Sparse: only roots with unread > 0 appear (absent ⇒ 0).
  const unreadByRoot = useConversationUnread(channelId).data?.threads;
  // Same author-resolution maps the message panes use, so an author renders
  // identically here and in the stream.
  const { agentsById, humansById, humanAvatarUrls } = useMessageRenderContext(
    workspaceId,
    channelId,
  );
  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);

  const authorName = (author: Author): string => {
    if (author.kind === 'agent') {
      const a = agentsById.get(author.id);
      return a?.display_name?.trim() || a?.name || 'agent';
    }
    if (author.kind === 'human') {
      return humansById.get(author.id)?.name || 'Someone';
    }
    return 'System';
  };

  const renderAvatar = (author: Author, size: number): JSX.Element => {
    const label = authorName(author);
    if (author.kind === 'agent') {
      const a = agentsById.get(author.id);
      if (a) {
        return (
          <AgentAvatar
            runtime={a.runtime}
            size={size}
            avatarObjectUrl={agentAvatarUrls.get(a.id) ?? null}
            alt={label}
            title={label}
          />
        );
      }
    }
    return (
      <UserAvatar
        size={size}
        avatarObjectUrl={
          author.kind === 'human'
            ? humanAvatarUrls.get(author.id) ?? null
            : null
        }
        alt={label}
        title={label}
      />
    );
  };

  return (
    <aside
      data-pane="threads-list"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-chat,transparent)]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <ThreadIcon className="size-3.5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-text-primary">
            Threads
          </div>
          <div className="truncate text-xs text-text-muted">
            {parentTitle ? `#${parentTitle} · ` : ''}
            {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          data-sticker-close
          className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-text-muted">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm text-text-primary">Couldn’t load threads</p>
            <p className="text-xs text-text-muted">
              The thread index isn’t available yet. Try again shortly.
            </p>
          </div>
        ) : threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <ThreadIcon className="size-6 text-text-muted/50" />
            <p className="text-sm text-text-primary">No threads yet</p>
            <p className="text-xs text-text-muted">
              Reply to a message to start a thread — it’ll show up here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {threads.map(t => (
              <ThreadRow
                key={t.root_message_id}
                summary={t}
                unread={unreadByRoot?.[t.root_message_id]}
                authorName={authorName}
                renderAvatar={renderAvatar}
                onOpen={() => onOpenThread(t.root_message_id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

interface ThreadRowProps {
  summary: ThreadSummary;
  /** Per-viewer unread for this root, from `useConversationUnread` (#task:1226).
   *  The single source of "N new" — NOT `summary.unread_count`. Absent ⇒ 0. */
  unread?: StreamUnreadDto;
  authorName: (author: Author) => string;
  renderAvatar: (author: Author, size: number) => JSX.Element;
  onOpen: () => void;
}

function ThreadRow({
  summary,
  unread,
  authorName,
  renderAvatar,
  onOpen,
}: ThreadRowProps): JSX.Element {
  // Last-reply time lives in the activity band (reply recency, not root
  // metadata). The root's own creation time isn't surfaced — in a thread list
  // "latest activity" is the time that matters.
  const lastReplyTime = useRelativeTime(summary.last_reply_at);
  const replyLabel = `${summary.reply_count} ${
    summary.reply_count === 1 ? 'reply' : 'replies'
  }`;
  const overflow = summary.replier_total - summary.repliers.length;
  const unreadCount = unread?.unread_count ?? 0;
  const hasUnread = unreadCount > 0;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-thread-row
        className="flex w-full flex-col overflow-hidden rounded-[var(--row-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating text-left transition hover:-translate-y-px hover:border-[color:var(--border-control-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      >
        {/* Band 1 — root message: sender avatar + a natural "Name: content"
            flow. shiki wants the avatar kept; the standalone byline row read as
            disjoint, so the display name folds into the preview as a bold
            prefix and the content carries the visual mass. */}
        <span className="flex items-start gap-2 px-2.5 py-2">
          <span className="mt-px flex shrink-0">
            {renderAvatar(summary.root_author, 20)}
          </span>
          <span className="line-clamp-2 break-words text-sm text-text-primary">
            <span className="font-semibold">
              {authorName(summary.root_author)}:{' '}
            </span>
            {summary.root_preview}
          </span>
        </span>

        {/* Band 2 — reply activity. Full-width footer, hairline-separated so it
            reads as its own band rather than a column tucked under the avatar.
            Dropped entirely when there are no replies (row degrades to a single
            band; height stays content-stable). */}
        {summary.reply_count > 0 ? (
          <span className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5">
            {summary.repliers.length > 0 ? (
              <span className="flex items-center gap-[3px]">
                {summary.repliers.map(r => (
                  <span key={`${r.kind}:${r.id}`} className="flex shrink-0">
                    {renderAvatar(r, 18)}
                  </span>
                ))}
                {overflow > 0 ? (
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-none bg-bg-muted text-[9px] font-medium text-text-muted">
                    +{overflow}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="text-xs font-medium text-text-secondary">
              {replyLabel}
            </span>
            {/* Unread hint rides right after the reply count (not right-aligned):
                followed → filled count sticker, unfollowed → soft dot. forza6
                squares both via data-thread-unread. */}
            {hasUnread ? (
              summary.viewer_following ? (
                <span
                  data-thread-unread="sticker"
                  className="shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[16px] text-text-on-accent"
                  title={`${unreadCount} new`}
                  aria-label={`${unreadCount} new`}
                >
                  {unreadCount > 99 ? '99+' : unreadCount} new
                </span>
              ) : (
                <span
                  data-thread-unread="dot"
                  className="size-1.5 shrink-0 rounded-full bg-accent"
                  title={`${unreadCount} unread`}
                  aria-label={`${unreadCount} unread`}
                />
              )
            ) : null}
            <span className="text-xs leading-4 text-text-muted" aria-hidden>
              ·
            </span>
            <time
              dateTime={new Date(summary.last_reply_at).toISOString()}
              title={lastReplyTime.absolute}
              className="shrink-0 text-xs text-text-muted"
            >
              {lastReplyTime.relative}
            </time>
          </span>
        ) : null}
      </button>
    </li>
  );
}
