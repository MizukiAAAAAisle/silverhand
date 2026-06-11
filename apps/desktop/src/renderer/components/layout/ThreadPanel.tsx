import { useMemo } from 'react';
import { ArrowUpRight, Bell, BellOff, CornerDownLeft, Loader2, X } from 'lucide-react';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { groupMessages } from '@/components/chat/groupMessages';
import { MessageItem } from '@/components/chat/MessageItem';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { Composer } from '@/components/chat/Composer';
import type { ChannelReference } from '@/components/chat/ChannelRef';
import {
  useFollowThread,
  useThreadCluster,
  useThreadFollowers,
  useThreadRoot,
  useUnfollowThread,
} from '@/features/channels/hooks';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsers, makeUserNameResolver } from '@/features/users/hooks';
import { useConversationMembers } from '@/features/conversations/useConversationMembers';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';

interface ThreadPanelProps {
  /** Parent channel conversation. Replies live in this conversation with
   *  `thread_root_id = rootMessageId`; the panel reads/sends against it. */
  channelId: string;
  workspaceId: string;
  /** The root (main-line) message whose thread this panel shows. */
  rootMessageId: string;
  /** Parent channel title, shown in the header subtitle. */
  parentTitle?: string | null;
  /** Parent channel closed → composer disabled. */
  closed?: boolean;
  archived?: boolean;
  onClose: () => void;
  /** "View in channel": close this panel and scroll-locate + flash the
   *  root message in the main channel stream. Wired by App to
   *  `requestJump` + `closeCluster`. Omitted = button hidden. */
  onViewInChannel?: () => void;
}

/**
 * Right-pane view of one thread: the root message plus its replies, read
 * from `GET /api/channels/:id/messages?thread_root_id=` (cut3-4) and
 * appended to via the channel send route with `reply_to_message_id`
 * (cut3-5). A thread is NOT a separate conversation — it is a reply cluster
 * sharing the parent channel's context — so this panel deliberately does
 * not reuse the conversation-bound `ChannelView`; it renders the thread
 * with the same `MessageItem` / `groupMessages` primitives and a
 * reply-targeted Composer.
 *
 * NOTE: the message-render lookup maps below duplicate a slice of
 * `ChannelView`'s internal `MessageList`. Extracting a shared
 * `useMessageRenderContext(channelId, workspaceId)` hook is a clean
 * follow-up; kept inline here to avoid a large `ChannelView` refactor.
 */
export function ThreadPanel({
  channelId,
  workspaceId,
  rootMessageId,
  parentTitle,
  closed = false,
  archived = false,
  onClose,
  onViewInChannel,
}: ThreadPanelProps): JSX.Element {
  void workspaceId;
  // The root message is the thread's anchor — pinned at the top
  // independently of the tail-anchored reply window so a long thread can
  // never push it off-screen (cut3-3b review blocker, @Cindy). This read
  // also carries the authoritative cut3-6 reply count.
  const rootCtx = useThreadRoot(channelId, rootMessageId);
  const cluster = useThreadCluster(channelId, rootMessageId);
  const messages = cluster.data;

  // Human follower state for this cluster (item 4 + 5). `viewer_following`
  // drives the header toggle / context-menu unfollow; `follower_agent_ids`
  // restricts the (channel-scoped) activity bubble to this thread's agents.
  const followers = useThreadFollowers(channelId, rootMessageId);
  const viewerFollowing = followers.data?.viewer_following ?? false;
  // Until we have an authoritative follower snapshot, restrict the
  // (channel-scoped) activity bubble to an EMPTY allow-list so it shows
  // nothing — never fall back to unrestricted, which would leak main-line /
  // other-cluster agents into this thread. Showing full activity under
  // unknown state is wrong info, not a graceful fallback (Cindy #1047 cut B
  // review). `useThreadFollowers` keeps this snapshot fresh against the
  // thread message stream (auto-follow side effects).
  const followerAgentIds = followers.data?.follower_agent_ids ?? [];
  const followThread = useFollowThread(channelId, rootMessageId);
  const unfollowThread = useUnfollowThread(channelId, rootMessageId);
  const followPending = followThread.isPending || unfollowThread.isPending;
  const toggleFollow = (): void => {
    if (followPending) return;
    if (viewerFollowing) unfollowThread.mutate();
    else followThread.mutate();
  };

  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  const { data: viewer } = useViewerUser();
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);
  const conversationMembers = useConversationMembers(channelId);

  const { agentsById, agentsByName } = useMemo(() => {
    const byId = new Map<string, AgentDto>();
    const byName = new Map<string, AgentDto>();
    for (const a of agents) {
      byId.set(a.id, a);
      byName.set(a.name, a);
    }
    return { agentsById: byId, agentsByName: byName };
  }, [agents]);

  const humansById = useMemo(() => {
    const byId = new Map<string, UserDto>();
    for (const user of users) byId.set(user.id, user);
    if (viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer)) {
      byId.set(viewer.id, viewer);
    }
    return byId;
  }, [users, viewer]);

  const humansByName = useMemo(() => {
    const byName = new Map<string, UserDto>();
    if (conversationMembers.status === 'resolved') {
      for (const member of conversationMembers.members) {
        if (member.kind !== 'human') continue;
        const user = humansById.get(member.user_id);
        if (user) byName.set(user.name, user);
      }
    }
    if (viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer)) {
      byName.set(viewer.name, viewer);
    }
    return byName;
  }, [conversationMembers.status, conversationMembers.members, humansById, viewer]);

  const userResolver = useMemo(
    () => makeUserNameResolver(humansById),
    [humansById],
  );

  // `#<name>` channel refs are not resolved inside the cluster panel for
  // v1 — they degrade to inert text (use the main pane for navigation).
  const channelsByName = useMemo(
    () => new Map<string, ChannelReference | null>(),
    [],
  );

  // The root is pinned separately (see below), so drop it from the
  // scrolled reply list to avoid rendering it twice — it can appear in
  // the cluster window for small threads (where the window reaches the
  // start) but not for large ones (tail-anchored window).
  const replyMessages = useMemo(
    () => messages.filter(m => m.id !== rootMessageId),
    [messages, rootMessageId],
  );
  const items = useMemo(() => groupMessages(replyMessages), [replyMessages]);

  // Authoritative full reply count from the cut3-6 sidecar (kept live by
  // useThreadRoot) — NOT a count of currently-loaded rows, which would be
  // wrong for a paginated long thread.
  const replyCount = rootCtx.replyCount;

  const resolvedViewer =
    viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer)
      ? viewer
      : undefined;

  const renderMessage = (m: typeof messages[number]): JSX.Element =>
    m.from_kind === 'system' ? (
      <SystemMessage
        key={m.id}
        message={m}
        channelsByName={channelsByName}
        humansByName={humansByName}
      />
    ) : (
      <MessageItem
        key={m.id}
        message={m}
        conversationId={channelId}
        routeKind="channel"
        agentsById={agentsById}
        agentsByName={agentsByName}
        humansByName={humansByName}
        humansById={humansById}
        channelsByName={channelsByName}
        viewerAvatarObjectUrl={viewerAvatarObjectUrl}
        viewer={resolvedViewer}
        humanAvatarUrls={humanAvatarUrls}
        agentAvatarUrls={agentAvatarUrls}
        userResolver={userResolver}
        onUnfollowThread={
          viewerFollowing && !followPending
            ? () => unfollowThread.mutate()
            : undefined
        }
      />
    );

  return (
    <aside
      data-pane="thread"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-subtle bg-[var(--bg-chat,transparent)]"
    >
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <CornerDownLeft className="size-3.5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">
            Thread
          </div>
          <div className="truncate text-xs text-text-muted">
            {parentTitle ? `${parentTitle} · ` : ''}
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {followers.data ? (
            <button
              type="button"
              aria-label={viewerFollowing ? '取消关注该线程' : '关注该线程'}
              aria-pressed={viewerFollowing}
              title={viewerFollowing ? '取消关注该线程' : '关注该线程'}
              onClick={toggleFollow}
              disabled={followPending}
              className={
                'flex size-8 shrink-0 items-center justify-center rounded-[6px] hover:bg-bg-hover disabled:opacity-50 ' +
                (viewerFollowing
                  ? 'text-accent hover:text-accent'
                  : 'text-text-muted hover:text-text-primary')
              }
            >
              {viewerFollowing ? (
                <BellOff className="size-4" />
              ) : (
                <Bell className="size-4" />
              )}
            </button>
          ) : null}
          {onViewInChannel ? (
            <button
              type="button"
              aria-label="在频道中查看"
              title="在频道中查看"
              onClick={onViewInChannel}
              className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <ArrowUpRight className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      {rootCtx.isError ? (
        // Root unavailable (404 / legacy thread target / fetch failure).
        // Distinct from "no replies yet" — the thread can't be shown at
        // all, and replying would have no valid target.
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
          无法加载该消息,它可能已被删除或不可用
        </div>
      ) : rootCtx.isLoading && !rootCtx.root ? (
        <div className="flex flex-1 items-center justify-center text-text-muted">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : (
        <>
          {/* Pinned root — always visible, never paged away. */}
          {rootCtx.root ? (
            <div className="border-b border-border-subtle px-1 py-2">
              {renderMessage(rootCtx.root)}
            </div>
          ) : null}

          <div className="scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2">
            {cluster.isLoading ? (
              <div className="flex flex-1 items-center justify-center text-text-muted">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : replyMessages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
                还没有回复
              </div>
            ) : (
              <>
                {cluster.hasPreviousPage ? (
                  <button
                    type="button"
                    disabled={cluster.isFetchingPreviousPage}
                    onClick={() => void cluster.fetchPreviousPage()}
                    className="mx-auto mb-1 rounded px-2 py-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-50"
                  >
                    {cluster.isFetchingPreviousPage ? '加载中…' : '加载更早的回复'}
                  </button>
                ) : null}
                {items.map(item => {
                  if (item.kind === 'cluster') {
                    return (
                      <SystemActivityCluster
                        key={item.messages[0]?.id ?? 'cluster'}
                        messages={item.messages}
                        channelsByName={channelsByName}
                        humansByName={humansByName}
                      />
                    );
                  }
                  return renderMessage(item.message);
                })}
              </>
            )}
          </div>
        </>
      )}

      <Composer
        key={`${channelId}#cluster#${rootMessageId}`}
        conversationId={channelId}
        threadRootId={rootMessageId}
        routeKind="channel"
        disabled={closed || rootCtx.isError || !rootCtx.root}
        archived={archived}
        activityAgentIds={followerAgentIds}
      />
    </aside>
  );
}
