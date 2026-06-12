import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Bell, BellOff, CornerUpLeft, Loader2, X } from 'lucide-react';
import { groupMessages } from '@/components/chat/groupMessages';
import { MessageItem } from '@/components/chat/MessageItem';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { Composer } from '@/components/chat/Composer';
import { useMessageRenderContext } from '@/components/chat/useMessageRenderContext';
import { useMessageActionSurface } from '@/components/chat/useMessageActionSurface';
import { MessageActionChrome } from '@/components/chat/MessageActionChrome';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import {
  useFollowThread,
  useThreadCluster,
  useThreadFollowers,
  useThreadRoot,
  useUnfollowThread,
} from '@/features/channels/hooks';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';

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
   *  `requestJump` + `closeThread`. Omitted = button hidden. */
  onViewInChannel?: () => void;
  /** Inline-ref resolution + navigation, threaded from App so a thread
   *  reply resolves `#conv:` / `#<channel>` / `#task:` sigils identically
   *  to the channel pane (#task:1052). Same handlers App passes to
   *  `ChannelView`. */
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** `(workspaceId, channelId)` — App-level handler; the panel pre-binds
   *  it to this thread's workspace before handing it to the renderer. */
  onOpenChannelRef?: (workspaceId: string, channelId: string) => void;
  /** `(taskNumber, workspaceId)` — App-level handler; wrapped into a
   *  `TaskRefContextProvider` scoped to this thread's workspace so inline
   *  `#task:<n>` chips resolve + open. */
  onOpenTask?: (taskNumber: number, workspaceId: string) => void;
  /** A reply inside this cluster to scroll-locate + flash. Set by App when
   *  a jump (task/saved/search/notification) targets a message whose
   *  `thread_root_id === rootMessageId`. App gates this to this cluster, so
   *  the panel just locates. Null = no pending jump. */
  jumpMessageId?: string | null;
  /** Called once the jump completes (flashed) or is given up (target not in
   *  the loaded window). App clears the jump target on this. */
  onJumped?: () => void;
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
 * Render context (lookup maps + sigil resolution) comes from the shared
 * `useMessageRenderContext` hook — the SAME source `ChannelView`'s
 * `MessageList` consumes — so an inline `@mention` / `#<channel>` /
 * `#conv:` / `#task:` resolves identically in both panes (#task:1052).
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
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  onOpenTask,
  jumpMessageId,
  onJumped,
}: ThreadPanelProps): JSX.Element {
  const rootCtx = useThreadRoot(channelId, rootMessageId);
  const cluster = useThreadCluster(channelId, rootMessageId);
  const messages = cluster.data;
  // Window-position signals (mirrors the channel pane). A cluster can be
  // mid-history after an around-reply jump (saved/search/task/notification
  // → primeAround with threadRootId), so the back-to-bottom button must be
  // able to reset to the true tail, not just scroll the local window.
  const { isAtTail, hasNewerLiveGap, resetToLatest } = cluster;
  const shouldResetToLatest = !isAtTail || hasNewerLiveGap;

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

  // Shared render context — identical maps to the channel pane. The
  // AGENT avatar batch is lifted here (not in the hook) so this pane's
  // authors share one fetch; `useAgents` is React-Query cached so this
  // call reuses the same data the hook reads.
  const {
    agentsById,
    agentsByName,
    humansById,
    humansByName,
    channelsByName,
    humanAvatarUrls,
    viewerAvatarObjectUrl,
    viewer,
    userResolver,
    liveChannels,
    archivedChannels,
  } = useMessageRenderContext(workspaceId, channelId);
  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);

  // ── Message actions (copy / share / multi-select export) ──────────────
  // Shared action surface — identical wiring to the channel pane
  // (#task:1067), so the per-row action props can't drift. The list/window
  // strategy is NOT shared: ThreadPanel stays a plain scroller / cluster
  // window. `selectionResetKey` is this pane's window-reset signal, bumped
  // on thread switch (rootMessageId effect below) and on any disjoint
  // cluster window replacement (detector below); the hook clears the active
  // selection when it changes.
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  const actions = useMessageActionSurface({
    channelId,
    windowResetVersion: selectionResetKey,
    jumpToMessageId: jumpMessageId ?? null,
    agentsById,
    viewer,
  });

  // Parent-channel title/kind for the export screenshot header + filename.
  // The thread shares the parent channel's identity; fall back to the
  // `parentTitle` prop when the channel list hasn't resolved yet.
  const channelMeta = useMemo(() => {
    const c =
      liveChannels.find(x => x.id === channelId) ??
      archivedChannels.find(x => x.id === channelId);
    if (!c) {
      return { title: parentTitle ?? null, kind: null as 'channel' | 'dm' | null };
    }
    return {
      title: c.title,
      kind:
        c.kind === 'dm_channel'
          ? ('dm' as const)
          : c.kind === 'channel'
            ? ('channel' as const)
            : null,
    };
  }, [liveChannels, archivedChannels, channelId, parentTitle]);

  // Drop any active selection when the cluster WINDOW is replaced (not just
  // grown by prepend/append). A disjoint replacement — reset-to-latest, an
  // off-tail composer send rebuilding to a tail page, a reconnect
  // invalidate, or an around-reply jump — leaves `selection.selected`
  // holding rows that are no longer in view. ChannelView gets this for free
  // from `useMessageSelection`'s `windowResetVersion`; the cluster needs the
  // same signal (Cindy `0f9d2ba` re-review blocker). Detect replacement by
  // the window's top-row identity vanishing from the new window. We
  // deliberately do NOT update the ref across a transient empty window
  // (`resetToLatest` clears the cache to [] before the tail refetch lands),
  // so the pre-reset top is still remembered when the fresh window arrives.
  const prevTopIdRef = useRef<string | null>(null);
  useEffect(() => {
    const topId = messages[0]?.id ?? null;
    if (topId == null) return; // keep prevTopIdRef across transient empties
    const prevTop = prevTopIdRef.current;
    prevTopIdRef.current = topId;
    if (prevTop == null || prevTop === topId) return;
    // Prepend/append keep the old top somewhere in the window; only a
    // disjoint replacement makes it disappear entirely.
    if (!messages.some(m => m.id === prevTop)) {
      setSelectionResetKey(v => v + 1);
    }
  }, [messages]);

  // Pre-bind the App handlers to this thread's workspace, mirroring
  // `ChannelView` exactly so the renderer receives the same shapes.
  const handleOpenChannelRef = useCallback(
    (resolvedChannelId: string) => {
      onOpenChannelRef?.(workspaceId, resolvedChannelId);
    },
    [onOpenChannelRef, workspaceId],
  );
  const taskRefContext = useMemo(
    () => ({
      workspaceId,
      onOpenTask: onOpenTask
        ? (taskNumber: number) => onOpenTask(taskNumber, workspaceId)
        : undefined,
    }),
    [workspaceId, onOpenTask],
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

  // Scroll-to-bottom behavior, mirroring the channel (#task:1050 items 4+5):
  // (re)opening the panel lands at the newest reply, and a back-to-bottom
  // button appears once the user scrolls up. ThreadPanel uses a plain
  // scroll container (not the channel's Virtuoso list), so this is a small
  // vanilla controller rather than a reused hook.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinBottomRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinBottomRef.current = true;
    setShowScrollBottom(false);
  }, []);

  // Back-to-bottom click: when the cluster window is mid-history (a forward
  // live gap, or an around-reply jump landed off-tail), local scrolling
  // can't reach the newest replies — reset the query to the tail window and
  // pin to bottom so the fresh data lands at the end. Otherwise just scroll
  // the loaded window to its end. (Mirrors ChannelView's bottom button.)
  const handleScrollBottomClick = useCallback(() => {
    if (shouldResetToLatest) {
      pinBottomRef.current = true;
      setShowScrollBottom(false);
      resetToLatest();
      return;
    }
    scrollToBottom();
  }, [shouldResetToLatest, resetToLatest, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 20;
    pinBottomRef.current = atBottom;
    setShowScrollBottom(!atBottom);
  }, []);

  // Reopening the panel for a (different) root resets to follow-bottom mode
  // and drops any in-flight selection (the frame the user was selecting in
  // is gone).
  useEffect(() => {
    pinBottomRef.current = true;
    setShowScrollBottom(false);
    setSelectionResetKey(v => v + 1);
  }, [rootMessageId]);

  // While pinned (initial open, or the user sitting at the tail), keep the
  // newest reply in view as the root loads / replies arrive. Instant jump
  // (not smooth) so an open never animates up from the top.
  useLayoutEffect(() => {
    if (!pinBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollBottom(false);
  }, [messages, rootMessageId, cluster.isLoading, rootCtx.root]);

  // Jump-locate: when App routes a jump to a reply inside THIS cluster,
  // scroll it into view + one-shot flash, mirroring the channel's
  // `MessageList` flash sequence. App gates `jumpMessageId` to messages
  // whose `thread_root_id === rootMessageId`, so the panel just locates.
  // A pending jump overrides follow-bottom so the locate scroll wins.
  // Virtuoso renders the channel list async; this plain container renders
  // its loaded rows synchronously, so a short rAF poll covers the window's
  // commit. A target outside the loaded window (an older paginated reply)
  // releases the jump rather than latching — cross-page locate is a
  // follow-up, not silently broken.
  useEffect(() => {
    if (!jumpMessageId) return;
    pinBottomRef.current = false;
    setShowScrollBottom(true);
    let raf = 0;
    let attempts = 0;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const tryLocate = (): void => {
      const node = document.getElementById(`msg-${jumpMessageId}`);
      if (node) {
        node.scrollIntoView({ block: 'center' });
        node.classList.add('msg-jump-flash');
        flashTimer = setTimeout(() => {
          node.classList.remove('msg-jump-flash');
          onJumped?.();
        }, 3000);
        return;
      }
      attempts += 1;
      if (attempts > 60) {
        onJumped?.();
        return;
      }
      raf = requestAnimationFrame(tryLocate);
    };
    raf = requestAnimationFrame(tryLocate);
    return () => {
      cancelAnimationFrame(raf);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [jumpMessageId, onJumped]);

  const renderMessage = (m: typeof messages[number]): JSX.Element =>
    m.from_kind === 'system' ? (
      <SystemMessage
        key={m.id}
        message={m}
        channelsByName={channelsByName}
        onOpenChannelRef={handleOpenChannelRef}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        humansByName={humansByName}
      />
    ) : (
      <MessageItem
        key={m.id}
        message={m}
        conversationId={channelId}
        agentsById={agentsById}
        agentsByName={agentsByName}
        humansByName={humansByName}
        humansById={humansById}
        channelsByName={channelsByName}
        onOpenChannelRef={handleOpenChannelRef}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        viewerAvatarObjectUrl={viewerAvatarObjectUrl}
        viewer={viewer}
        humanAvatarUrls={humanAvatarUrls}
        agentAvatarUrls={agentAvatarUrls}
        userResolver={userResolver}
        {...actions.rowActionProps(m)}
      />
    );

  return (
    <TaskRefContextProvider value={taskRefContext}>
    <aside
      data-pane="thread"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-chat,transparent)]"
    >
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <CornerUpLeft className="size-3.5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">
            {parentTitle || 'Thread'}
          </div>
          <div className="truncate text-xs text-text-muted">
            Thread · {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </div>
        </div>
        <div
          data-channel-actions
          className="ml-auto flex shrink-0 items-center gap-1"
        >
          {followers.data ? (
            <button
              type="button"
              aria-label={viewerFollowing ? 'Unfollow thread' : 'Follow thread'}
              aria-pressed={viewerFollowing}
              title={viewerFollowing ? 'Unfollow thread' : 'Follow thread'}
              onClick={toggleFollow}
              disabled={followPending}
              className={
                'flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] hover:bg-bg-hover disabled:opacity-50 ' +
                (viewerFollowing
                  ? 'text-text-primary hover:text-text-primary'
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
              aria-label="View in channel"
              title="View in channel"
              onClick={onViewInChannel}
              className="flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <ArrowUpRight className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary"
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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageActionChrome
            surface={actions}
            renderCtx={{
              agentsById,
              agentsByName,
              humansByName,
              channelsByName,
              conversationRefsById,
              agentAvatarUrls,
              viewer,
              viewerAvatarObjectUrl,
            }}
            workspaceId={workspaceId}
            channelTitle={channelMeta.title}
            channelKind={channelMeta.kind}
          />
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2"
          >
            {/* Load earlier replies (between the root and the tail window). */}
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

            {/* Root message — the cluster anchor, rendered inline as the
                first message in the stream. No longer pinned (#task:1050
                item 1) so replies get the panel's full height. */}
            {rootCtx.root ? renderMessage(rootCtx.root) : null}

            {cluster.isLoading ? (
              <div className="flex flex-1 items-center justify-center text-text-muted">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : replyMessages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
                还没有回复
              </div>
            ) : (
              items.map(item => {
                if (item.kind === 'cluster') {
                  return (
                    <SystemActivityCluster
                      key={item.messages[0]?.id ?? 'cluster'}
                      messages={item.messages}
                      channelsByName={channelsByName}
                      onOpenChannelRef={handleOpenChannelRef}
                      conversationRefsById={conversationRefsById}
                      onOpenConversationRef={onOpenConversationRef}
                      humansByName={humansByName}
                    />
                  );
                }
                return renderMessage(item.message);
              })
            )}
          </div>

          {/* Back-to-bottom — same primitive as the channel (#task:1050
              item 5). Appears once the user scrolls away from the tail. */}
          {showScrollBottom || shouldResetToLatest ? (
            <button
              type="button"
              aria-label={shouldResetToLatest ? '跳到最新回复' : '滚动到底部'}
              title={shouldResetToLatest ? '跳到最新回复' : '滚动到底部'}
              onClick={handleScrollBottomClick}
              className="absolute bottom-4 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-text-on-accent shadow-lg transition-all hover:opacity-90 active:opacity-75"
            >
              <ArrowDown className="size-4" />
            </button>
          ) : null}
        </div>
      )}

      <Composer
        key={`${channelId}#cluster#${rootMessageId}`}
        conversationId={channelId}
        threadRootId={rootMessageId}
        disabled={closed || rootCtx.isError || !rootCtx.root}
        archived={archived}
        activityAgentIds={followerAgentIds}
      />
    </aside>
    </TaskRefContextProvider>
  );
}
