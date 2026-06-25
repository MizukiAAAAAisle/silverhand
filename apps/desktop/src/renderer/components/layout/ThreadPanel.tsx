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
import { threadClusterShowsLoader, threadLiveMarkReadSeq, threadMarkReadSnapshot, threadOpenNeedsLatestRefetch } from './threadMarkRead';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import {
  useFollowThread,
  useMarkThreadRead,
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
  /** True while a first-unread jump into THIS thread is still priming its
   *  around-window (#task:1226 §9.10). App derives it from the jump
   *  controller's `isPrimePendingFor`. While set, the cluster query is held
   *  disabled so its empty-cache initial latest fetch can't race / clobber
   *  `primeAround`'s around-window; the pane shows a loader meanwhile. */
  jumpPrimePending?: boolean;
  /** Called once the jump completes (flashed) or is given up (target not in
   *  the loaded window). App clears the jump target on this. */
  onJumped?: () => void;
  /** Render as an Activity DOCKED SOURCE VIEWER (#task:1227): identity + exit
   *  header only. The Follow/Unfollow control (a delivery/attention management
   *  op) is suppressed — the user manages following from the original thread.
   *  Keeps `Open in conversation` + close. See `ChannelView.sourceViewer`. */
  sourceViewer?: boolean;
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
  jumpPrimePending = false,
  onJumped,
  sourceViewer,
}: ThreadPanelProps): JSX.Element {
  const rootCtx = useThreadRoot(channelId, rootMessageId);
  const cluster = useThreadCluster(channelId, rootMessageId, {
    jumpPrimePending,
  });
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
  const markThreadRead = useMarkThreadRead();
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

  // Mark this reply-cluster read once per open (#task:1226 surface 4, §9/§9.10).
  // Opening a thread IS reading it (read-to-clear whole opened thread), so we
  // advance the viewer's per-thread `conversation_reads` cursor to the
  // OPEN-TIME stream head. The snapshot must come from THIS open's window fetch
  // — not the previous open's cache React Query serves synchronously on reopen,
  // and not a `setQueryData` update. `threadMarkReadSnapshot` enforces that via
  // `windowFetchSucceededAt >= openedAt`.
  //
  // `openedAt` / the once-guard / "was this a jump open" are captured at
  // RENDER time (the earliest point — before effects, before a fast localhost
  // `primeAround` could resolve), keyed by (channelId, rootMessageId). The
  // once-guard is therefore re-armed per open, never a permanent per-root lock,
  // so a stale cache can't lock it before the fresh fetch.
  // Human-attention only — writes the read cursor, never delivery/wake.
  const openKeyRef = useRef('');
  const openedAtRef = useRef(0);
  const markedForOpenRef = useRef(false);
  const markInflightSeqRef = useRef(0);
  const lastMarkedSeqRef = useRef(0);
  const liveMarkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isJumpOpenRef = useRef(false);
  const openKey = `${channelId}::${rootMessageId}`;
  if (openKeyRef.current !== openKey) {
    openKeyRef.current = openKey;
    openedAtRef.current = Date.now();
    markedForOpenRef.current = false;
    markInflightSeqRef.current = 0;
    lastMarkedSeqRef.current = 0;
    // Whether THIS open began as a first-unread jump. Captured once at open so
    // a later `clearJump` (which nulls `jumpMessageId`) can't flip it and
    // trigger a latest refetch that clobbers the around-window mid-read.
    isJumpOpenRef.current = jumpMessageId != null;
  }

  // Issue a mark-read to `seq`: forward-only, once per seq. `lastMarkedSeqRef`
  // advances on mutation SUCCESS only (Cindy bar #2 — a pending/failed mark must
  // not look cleared locally while the server cursor hasn't moved); the
  // in-flight guard collapses re-fires while one is pending; on error the cursor
  // is untouched so the next trigger retries. Human-attention only — writes the
  // viewer's read cursor, never delivery/wake.
  const markThreadReadMutate = markThreadRead.mutate;
  const issueMarkRead = useCallback(
    (seq: number, onMarked?: () => void) => {
      if (seq <= lastMarkedSeqRef.current) return;
      if (seq <= markInflightSeqRef.current) return;
      markInflightSeqRef.current = seq;
      markThreadReadMutate(
        { channelId, threadRootId: rootMessageId, snapshotSeq: seq },
        {
          onSuccess: () => {
            if (seq > lastMarkedSeqRef.current) lastMarkedSeqRef.current = seq;
            onMarked?.();
          },
          onSettled: () => {
            if (markInflightSeqRef.current === seq) markInflightSeqRef.current = 0;
          },
        },
      );
    },
    [channelId, rootMessageId, markThreadReadMutate],
  );

  // §9.10: drive this open's window fetch explicitly (the query itself has
  // `refetchOnMount: false`). A NORMAL open forces a fresh latest window so its
  // mark snapshot is from this open and the gate opens. A JUMP open does NOT
  // refetch — `primeAround` already fetched the authoritative around-first-unread
  // window (and stamped the freshness epoch); a target-less latest refetch here
  // would clobber it. Keyed on (channelId, rootMessageId) so it runs once per
  // open, NOT on `jumpMessageId` (which clears after locate).
  useEffect(() => {
    if (threadOpenNeedsLatestRefetch({ isJumpOpen: isJumpOpenRef.current })) {
      void cluster.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, rootMessageId]);

  // OPEN-TIME mark (read-to-clear the whole opened thread): advance to the
  // open-time stream head, gated by `threadMarkReadSnapshot` to THIS open's
  // fresh window fetch. The once-guard `markedForOpenRef` is armed on mutation
  // SUCCESS only (Cindy review) — NOT optimistically — so a failed open-time
  // mark stays retryable: `issueMarkRead` is forward-only + in-flight-guarded,
  // so re-running this effect while the mark is pending is a no-op, and on
  // failure the guard is never armed, so the next dep change (a new reply bumps
  // `streamHeadSeq`, a refetch bumps `windowFetchSucceededAt`) retries. The
  // visible-live effect below independently covers the pinned-tail case.
  useEffect(() => {
    if (markedForOpenRef.current) return;
    const snapshot = threadMarkReadSnapshot({
      alreadyMarkedForOpen: markedForOpenRef.current,
      isFetching: cluster.isFetching,
      headSeq: cluster.streamHeadSeq,
      windowFetchSucceededAt: cluster.windowFetchSucceededAt,
      openedAt: openedAtRef.current,
    });
    if (snapshot === null) return;
    issueMarkRead(snapshot, () => {
      markedForOpenRef.current = true;
    });
  }, [
    channelId,
    rootMessageId,
    cluster.isFetching,
    cluster.streamHeadSeq,
    cluster.windowFetchSucceededAt,
    issueMarkRead,
  ]);

  // Document visibility as REACTIVE state (#task:1226, Cindy review). The
  // live-mark gate reads visibility, but `document.hidden` read inline isn't
  // reactive — `visibilitychange` fires no React render. Without this, a reply
  // that arrives while the app is backgrounded correctly stays unread, but when
  // the user returns to the foreground (pinned at the tail, reply now on
  // screen) nothing re-runs the gate, so it lingers unread until the next
  // message/scroll/reopen. Mirroring visibility into state makes the return-to-
  // visible transition a dependency that re-fires the live-mark effect.
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden,
  );
  useEffect(() => {
    const onVisibility = (): void => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () =>
      document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // VISIBLE-LIVE mark (#task:1226 — shiki dogfood): a reply arriving while the
  // panel is open + watched should clear unread without a close/reopen. Follow
  // the read cursor to the newest reply ONLY while pinned at the tail (it's on
  // screen) AND the window is visible — never swallowing an unrendered tail
  // (scrolled up) or a backgrounded panel. `threadLiveMarkReadSeq` is the pure
  // gate; debounced so a burst of replies collapses to one mark at the latest
  // visible seq (max-VISIBLE, not latest-known — `messages` is the loaded
  // window). `lastMarkedSeqRef` (advanced on success) keeps it forward-only.
  // `documentVisible` is a dep so returning to the foreground re-runs the gate.
  const maxLoadedSeq = messages.length
    ? messages[messages.length - 1]!.seq
    : null;
  const pinnedAtTail = isAtTail && pinBottomRef.current;
  useEffect(() => {
    const seq = threadLiveMarkReadSeq({
      pinnedAtTail,
      documentVisible,
      maxVisibleSeq: maxLoadedSeq,
      lastMarkedSeq: lastMarkedSeqRef.current,
    });
    if (seq === null) return;
    if (liveMarkTimerRef.current) clearTimeout(liveMarkTimerRef.current);
    liveMarkTimerRef.current = setTimeout(() => {
      liveMarkTimerRef.current = null;
      // Re-check at fire time: the user may have scrolled up or backgrounded
      // the app during the debounce window.
      if (!(isAtTail && pinBottomRef.current) || document.hidden) return;
      issueMarkRead(seq);
    }, 300);
    return () => {
      if (liveMarkTimerRef.current) {
        clearTimeout(liveMarkTimerRef.current);
        liveMarkTimerRef.current = null;
      }
    };
  }, [pinnedAtTail, documentVisible, maxLoadedSeq, isAtTail, issueMarkRead]);

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
        canReact={!closed && !archived}
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
          {!sourceViewer && followers.data ? (
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
            data-sticker-close
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

            {threadClusterShowsLoader({
              isLoading: cluster.isLoading,
              jumpPrimePending,
              hasWindow: messages.length > 0,
            }) ? (
              // Loader only while there is genuinely nothing to render yet: a
              // real in-flight fetch, OR a still-priming jump whose around-window
              // has not committed. Once primeAround commits, the (disabled)
              // query's cache carries the window (`messages.length > 0`) and we
              // MUST render it even though `jumpPrimePending` is still true — the
              // controller keeps prime pending until the VISUAL locate/flash
              // finishes, and hiding the messages would starve that locate of its
              // DOM node, timing the jump out with first-unread locate failed
              // (§9.10, Cindy). `threadClusterShowsLoader` encodes this.
              <div className="flex flex-1 items-center justify-center text-text-muted">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : replyMessages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
                No replies yet
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
              data-scroll-bottom
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
