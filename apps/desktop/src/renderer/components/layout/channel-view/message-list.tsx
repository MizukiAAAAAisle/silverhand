import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import type { ReplyBadgeSummary, StreamUnreadDto } from '@silverhand/shared';
import { ChannelMessageItem } from '@/components/chat/ChannelMessageItem';
import { useMessageRenderContext } from '@/components/chat/useMessageRenderContext';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { groupMessages } from '@/components/chat/groupMessages';
import { useMessageActionSurface } from '@/components/chat/useMessageActionSurface';
import { MessageActionChrome } from '@/components/chat/MessageActionChrome';
import { MessageRowsSkeleton } from '@/components/layout/ConversationViewSkeleton';
import {
  type CachedMessage,
  isCommittedMessage,
} from '@/features/channels/pending-message';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import {
  FIRST_ITEM_INDEX_START,
  getFollowOutputBehavior,
  getInitialTopMostItemIndex,
  shouldRemountForJump,
  shouldRemountForWindowReplacement,
} from '@/components/layout/messageListVirtualization';

// ── Message list ────────────────────────────────────────────────────────

export function MessageList({
  channelId,
  workspaceId,
  messages,
  isLoading,
  hasMoreBefore,
  isFetchingEarlier,
  onLoadEarlier,
  agentAvatarUrls,
  leadingSlot,
  highlightedMessageId,
  jumpToMessageId,
  jumpPrimePending = false,
  onJumped,
  isAtTail = true,
  hasNewerLiveGap = false,
  onResetToLatest,
  onOpenThread,
  replyCountsByRoot,
  replySummariesByRoot,
  threadUnreadByRoot,
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  canReact,
  searchQuery,
  searchActiveMessageId,
}: {
  channelId: string;
  workspaceId: string;
  messages: CachedMessage[];
  isLoading: boolean;
  hasMoreBefore: boolean;
  isFetchingEarlier: boolean;
  onLoadEarlier: () => void;
  /** Map of agent id → avatar object URL. Lifted into ActiveChannelView
   *  so message authors, member chips, and the activity strip share a
   *  single batch fetch instead of three independent ones. */
  agentAvatarUrls: Map<string, string | null>;
  leadingSlot?: ReactNode;
  highlightedMessageId?: string | null;
  jumpToMessageId: string | null;
  /** When true, App is still resolving a `primeAround` for the current
   *  `jumpToMessageId`. The jump effect waits in the `idx === -1`
   *  branch instead of giving up. */
  jumpPrimePending?: boolean;
  onJumped?: () => void;
  /** True when the cached window reaches the conversation tail.
   *  Around-message jumps can leave the list in a valid mid-history
   *  window before any live message arrives; the center bottom button
   *  must reset to latest in that state, not scroll to the window end. */
  isAtTail?: boolean;
  /** True when the cache window doesn't include the conversation's
   *  tail and at least one live message has arrived since. This is a
   *  live-content hint only; `!isAtTail` is the durable window-state
   *  signal used for the button action. */
  hasNewerLiveGap?: boolean;
  onResetToLatest?: () => void;
  /** Opens a main-line message's thread (reply cluster) in the right
   *  pane. Receives the root message id. Undefined on secondary panes
   *  (no nested threads), which hides the reply affordance. */
  onOpenThread?: (rootMessageId: string, jumpToMessageId?: string) => void;
  /** Per-root reply counts from the message window's cut3-6 sidecar
   *  (`reply_counts_by_root`). Drives the inline "{count} Reply" badge.
   *  A root with 0 (or absent) shows the hover "Thread" action instead. */
  replyCountsByRoot?: Record<string, number>;
  /** Per-root enriched reply-badge summaries (P1, #task:1073). Optional —
   *  when a root has an entry the badge upgrades to avatars + last-reply
   *  time; absent → count-only fallback. */
  replySummariesByRoot?: Record<string, ReplyBadgeSummary>;
  /** Per-root per-viewer server-scored unread (#task:1226), from
   *  `useConversationUnread`. The SINGLE source of the chip's "N new" +
   *  first-unread — sparse (absent root ⇒ 0). Kept separate from the
   *  optimistically-patched `replySummariesByRoot` so the server-scored fact
   *  never lives in the message-window cache. */
  threadUnreadByRoot?: Record<string, StreamUnreadDto>;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** Pre-bound (workspace already resolved) click handler for inline
   *  `#<channel_name>` chips. */
  onOpenChannelRef?: (channelId: string) => void;
  /** Whether the viewer may react in this channel — false when closed or
   *  archived. Threaded down to each MessageItem so the reaction write
   *  affordances hide in a read-only channel. */
  canReact: boolean;
  /** In-conversation header find (#task:1335). The active term — highlighted
   *  inside every rendered row's body via `MessageItem`→`Markdown`. */
  searchQuery?: string;
  /** The id of the CURRENT prev/next find match, framed + marked "current".
   *  Off-window matches are materialised by the shared jump/prime path (App's
   *  `handleJumpToMessage`) before they can be the active row. */
  searchActiveMessageId?: string | null;
}): JSX.Element {
  // Render context (lookup maps + sigil resolution + resolved viewer)
  // comes from the shared hook so the channel pane and the thread
  // reply-cluster pane resolve `@mention` / `#<channel>` / `#conv:` /
  // `#task:` identically (#task:1052). The AGENT avatar batch stays
  // lifted in `ActiveChannelView` (passed in as `agentAvatarUrls`) so
  // authors, the member strip, and the activity bubble share one fetch.
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
  const handleOpenThread = (
    msg: CachedMessage,
    jumpToMessageId?: string,
  ): void => {
    // A pending optimistic row has no server id to anchor a thread on.
    if (!isCommittedMessage(msg)) return;
    onOpenThread?.(msg.id, jumpToMessageId);
  };

  // Auto-scroll to bottom on new messages or when a new activity bubble
  // appears — except when a jump is pending (the jump effect below owns
  // scroll position in that case).
  //
  // We record whether the user was near the bottom (≤20px) *before* each
  // render using a scroll listener + ref. After render, `scrollHeight` has
  // already grown by the new content, so computing distFromBottom post-render
  // would mis-classify a user sitting at the old bottom as "not near bottom".
  // The ref is initialised to `true` so the very first render scrolls down.
  //
  // On channel switch, MessageList may not remount (React reuses the instance).
  // Reset to `true` whenever `channelId` changes so switching to a new channel
  // always starts in "follow bottom" mode regardless of the previous channel's
  // scroll position.
  //
  // Jump sets `jumpToMessageId`, which bypasses auto-scroll entirely while
  // the jump is in flight. The jump effect also explicitly sets the ref to
  // `false` right after `scrollIntoView`, so "resume follow" only happens
  // once the user manually scrolls back down — more deterministic than
  // waiting for the smooth-scroll animation to fire `onScroll`.
  //
  // ── Virtuoso integration ────────────────────────────────────────────────
  //
  // Migration from a hand-rolled `overflow-y-auto + messages.map()` scroller
  // to react-virtuoso. The data layer (useChannelMessages → MessageDto[])
  // and the grouping layer (groupMessages) are unchanged; only the visible
  // window is virtualized so DOM/layout/paint cost no longer scales with
  // total message count.
  //
  // Behaviour we keep parity on:
  //   - Stick-to-bottom on new live messages (`followOutput="auto"`)
  //   - Top-pull pagination when older history exists (`startReached`)
  //   - Scroll-to-bottom button visible when not at bottom
  //   - Jump-to-message (Saved / task refs) — implemented via
  //     `virtuosoRef.scrollToIndex` + a one-shot DOM flash class once the
  //     row lands in the live DOM (Virtuoso may not have it mounted at
  //     dispatch time).
  //   - Restore scroll anchor across prepend (firstItemIndex tracking)
  //
  // Behaviour we explicitly drop:
  //   - The synchronous `scrollTop = scrollHeight` flick on new messages —
  //     replaced by Virtuoso's auto-follow which is gated on at-bottom
  //     state (saner default and matches user intent).
  const items = useMemo(() => groupMessages(messages), [messages]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [flashedMessageId, setFlashedMessageId] = useState<string | null>(null);
  // Last find match we locally scrolled to (see the in-window find effect
  // below). Guards against re-scrolling on every unrelated `items` change.
  const lastScrolledSearchIdRef = useRef<string | null>(null);

  // `firstItemIndex` shifts down as older messages prepend so the visible
  // logical index stays stable and Virtuoso can hold scroll position. We
  // start way above zero so we have headroom for many prepend rounds.
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_START);
  const [windowResetVersion, setWindowResetVersion] = useState(0);
  // Shared message action surface — selection state + copy / share /
  // export handlers, identical to the thread reply-cluster pane
  // (#task:1067), so the per-row action props can't drift apart. The
  // list/window strategy is NOT shared: this pane keeps Virtuoso + the
  // main-stream window reset. `windowResetVersion` / `jumpToMessageId` are
  // the selection-clearing signals for a latest↔around window replacement.
  const actions = useMessageActionSurface({
    channelId,
    windowResetVersion,
    jumpToMessageId,
    agentsById,
    viewer,
  });
  // Channel title/kind — surfaced in the screenshot header and used as the
  // suggested filename base. Top-level channels live in liveChannels; we
  // only want the title, so an inline find is fine.
  const channelMeta = useMemo(() => {
    const c =
      liveChannels.find(x => x.id === channelId) ??
      archivedChannels.find(x => x.id === channelId);
    if (!c) return { title: null as string | null, kind: null as 'channel' | 'dm' | null };
    return {
      title: c.title,
      kind:
        c.kind === 'dm_channel'
          ? ('dm' as const)
          : c.kind === 'channel'
            ? ('channel' as const)
            : null,
    };
  }, [liveChannels, archivedChannels, channelId]);
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX_START);
  const lastTopItemKeyRef = useRef<string | null>(null);
  const lastJumpRemountKeyRef = useRef<string | null>(null);

  const itemKey = useCallback((item: ReturnType<typeof groupMessages>[number]) => {
    return item.kind === 'cluster' ? item.id : item.message.id;
  }, []);

  // Index of the current jump target inside `items`, shared by
  // window-reset decisions and Virtuoso's `initialTopMostItemIndex`.
  // Returns -1 while App is still priming the around-window.
  const jumpTargetIdx = useMemo(() => {
    if (!jumpToMessageId) return -1;
    return items.findIndex(
      it => it.kind === 'message' && it.message.id === jumpToMessageId,
    );
  }, [items, jumpToMessageId]);

  // Reset Virtuoso bookkeeping whenever the channel changes — the user is
  // entering a fresh stream and the stale baselines from the previous
  // channel must not leak in.
  useEffect(() => {
    firstItemIndexRef.current = FIRST_ITEM_INDEX_START;
    setFirstItemIndex(FIRST_ITEM_INDEX_START);
    setWindowResetVersion(0);
    lastTopItemKeyRef.current = null;
    lastJumpRemountKeyRef.current = null;
    setIsAtBottom(true);
    setShowScrollBottom(false);
    setFlashedMessageId(null);
  }, [channelId]);

  // New jump attempt boundary — fires whenever `jumpToMessageId` flips
  // to a new non-null value. Clear any local flash from the previous
  // attempt; positioning is handled by remounting Virtuoso below.
  useEffect(() => {
    if (!jumpToMessageId) {
      lastJumpRemountKeyRef.current = null;
      return;
    }
    setFlashedMessageId(null);
  }, [jumpToMessageId, channelId]);

  // Detect prepend on the items array and decrement `firstItemIndex` by
  // the number of newly inserted top-side items. We compare against the
  // previously observed top key — if it now sits at index N, then N items
  // were prepended.
  //
  // useLayoutEffect (not useEffect) — this MUST commit synchronously
  // before any passive effect (especially the jump effect below) runs,
  // otherwise scrollToIndex fires with stale firstItemIndex props
  // queued, Virtuoso miscomputes the target offset, and the row never
  // materialises.
  //
  // Also handles the data-shrink case: when a query refetch evicts old
  // pages (e.g. saved-jump on the same channel re-clicks
  // markMessageChannelRead → invalidate → first page only), `prevTopKey` is no
  // longer in items. We can't compute a delta, so reset the baseline
  // from scratch — without this, Virtuoso's size cache stays anchored
  // to the long-gone 788-item layout and any subsequent scrollToIndex
  // misses badly.
  useLayoutEffect(() => {
    if (items.length === 0) {
      lastTopItemKeyRef.current = null;
      return;
    }
    const top = items[0];
    if (!top) return;
    const newTopKey = itemKey(top);
    const prevTopKey = lastTopItemKeyRef.current;
    if (prevTopKey !== null && newTopKey !== prevTopKey) {
      const idx = items.findIndex(it => itemKey(it) === prevTopKey);
      if (idx > 0) {
        // Pure prepend: anchor preserved, shift firstItemIndex down.
        firstItemIndexRef.current -= idx;
        setFirstItemIndex(firstItemIndexRef.current);
      } else {
        // Data shrunk / reset (prev top item no longer exists). Reset
        // the baseline so Virtuoso re-anchors against the new dataset
        // instead of tracking phantom offsets. This is a full window
        // replacement (latest ↔ around-window), not a prepend. Remount
        // only when the replacement is a valid landing window: normal
        // latest reset (no jump target) or an around-window containing
        // the target. If a jump target exists but is still absent,
        // remounting would fall back to the current window's local end
        // and reproduce the "stuck one hour ago" failure.
        firstItemIndexRef.current = FIRST_ITEM_INDEX_START;
        setFirstItemIndex(FIRST_ITEM_INDEX_START);
        if (
          shouldRemountForWindowReplacement({
            hasJumpTarget: jumpToMessageId != null,
            jumpTargetIndex: jumpTargetIdx,
          })
        ) {
          setWindowResetVersion(v => v + 1);
        }
      }
    }
    lastTopItemKeyRef.current = newTopKey;
  }, [items, itemKey, jumpTargetIdx, jumpToMessageId]);

  // Treat every resolved jump as a fresh positioning request. This keeps
  // saved-message jumps on the same channel on the same path as
  // cross-channel jumps: Virtuoso mounts with `initialTopMostItemIndex`
  // already pointing at the target, instead of reusing an old size cache
  // and issuing an imperative scroll that can land on the previous
  // around-window's local position.
  useLayoutEffect(() => {
    if (!jumpToMessageId) {
      lastJumpRemountKeyRef.current = null;
      return;
    }
    if (
      !shouldRemountForJump({
        hasJumpTarget: true,
        jumpTargetIndex: jumpTargetIdx,
      })
    ) {
      return;
    }
    const target = items[jumpTargetIdx];
    if (!target) return;
    const key = `${channelId}:${jumpToMessageId}:${itemKey(target)}`;
    if (lastJumpRemountKeyRef.current === key) return;
    lastJumpRemountKeyRef.current = key;
    setWindowResetVersion(v => v + 1);
  }, [channelId, items, itemKey, jumpTargetIdx, jumpToMessageId]);

  // Bottom button visibility tracks `isAtBottom`. Virtuoso fires
  // `atBottomStateChange` only when the boolean flips, so this stays
  // stable across rapid scroll events.
  useEffect(() => {
    setShowScrollBottom(!isAtBottom);
  }, [isAtBottom]);

  const handleStartReached = useCallback(() => {
    if (!hasMoreBefore || isFetchingEarlier) return;
    onLoadEarlier();
  }, [hasMoreBefore, isFetchingEarlier, onLoadEarlier]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      align: 'end',
      behavior: 'smooth',
    });
    setShowScrollBottom(false);
  }, []);
  const shouldResetToLatest = !isAtTail || hasNewerLiveGap;
  const initialTopMostItemIndex = getInitialTopMostItemIndex({
    jumpTargetIndex: jumpTargetIdx,
    hasJumpTarget: jumpToMessageId != null,
    itemCount: items.length,
  });

  // Jump-to-message completion gate. Actual positioning is declarative:
  // when the target exists, the layout effect above remounts Virtuoso and
  // `initialTopMostItemIndex` opens directly at that row. This effect only
  // decides whether to wait for prime, give up on a final miss, or start
  // the one-shot flash/onJumped sequence.
  //
  // `jumpPrimePending` lets us distinguish "target not in cache yet"
  // (App is priming an around-window — wait for the next render) from
  // "primed and not present" (App will have cleared `jumpTarget` on
  // 404; for any other miss, signal `onJumped` so the parent doesn't
  // sit on a stuck target).
  useEffect(() => {
    if (!jumpToMessageId) return;
    if (items.length === 0) {
      // Empty cache. If App is priming, wait; otherwise let the next
      // data update re-trigger this effect — clearing the target now
      // would lose the user's visual hint.
      return;
    }
    if (jumpTargetIdx === -1) {
      if (jumpPrimePending) return; // wait for prime
      onJumped?.();
      return;
    }
    if (isFetchingEarlier) return;

    setShowScrollBottom(true);
    setFlashedMessageId(jumpToMessageId);
  }, [
    jumpToMessageId,
    jumpPrimePending,
    jumpTargetIdx,
    items.length,
    isFetchingEarlier,
    onJumped,
  ]);

  // One-shot flash lifecycle. The flash *visual* is declarative — the row
  // renders `.msg-jump-flash` from its `jumpFlash` prop (see `renderItem`),
  // so whichever DOM node Virtuoso mounts for this id picks the animation
  // up. This is deliberately NOT an imperative `getElementById().classList`
  // toggle: a jump remounts Virtuoso (`shouldRemountForJump` fires even when
  // the target is already on-screen) and `markRead`'s refetch can reset the
  // window — both replace the target's DOM node, and an imperatively-added
  // class is lost on the new node while the effect (keyed only on
  // `flashedMessageId`) never re-runs. That was the "already-visible target
  // doesn't highlight" bug (#task:1076). Here we only hold the flag for the
  // 3s animation, then clear it and signal `onJumped` (the single jumpTarget
  // cleanup point). `flashedMessageId` is only ever set once the target is
  // present in `items` (completion gate above), so there is no "never
  // materialised" branch to guard.
  useEffect(() => {
    if (!flashedMessageId) return;
    const timer = setTimeout(() => {
      setFlashedMessageId(null);
      onJumped?.();
    }, 3000);
    return () => clearTimeout(timer);
  }, [flashedMessageId, onJumped]);

  // In-window find navigation (#task:1335) — the LOCAL half of "ensure the
  // match is visible" (Cindy). When the active find match is a row already in
  // the loaded window, scroll to it via the virtualizer INDEX (not a DOM
  // lookup: a loaded row may be unmounted by virtualization) — no jump, no
  // prime, so the list never remounts. That remount is the prev/next "white
  // flash"; off-window matches are the only ones that legitimately re-window,
  // and those come through `jumpToMessageId` (the branch below), which owns
  // positioning — so we bail while a jump is in flight. We only re-scroll when
  // the active id actually CHANGES (ref guard), never on unrelated `items`
  // churn (a new live message must not yank the reader back to the match).
  useEffect(() => {
    if (jumpToMessageId) return; // the jump/prime path owns scroll position
    const id = searchActiveMessageId;
    if (!id) {
      lastScrolledSearchIdRef.current = null;
      return;
    }
    if (id === lastScrolledSearchIdRef.current) return;
    const idx = items.findIndex(
      it => it.kind === 'message' && it.message.id === id,
    );
    if (idx === -1) return; // not in the loaded window — ChannelView escalates it
    lastScrolledSearchIdRef.current = id;
    virtuosoRef.current?.scrollToIndex({
      index: idx,
      align: 'center',
      behavior: 'auto',
    });
  }, [searchActiveMessageId, items, jumpToMessageId]);

  const renderItem = useCallback(
    (item: ReturnType<typeof groupMessages>[number]) => {
      if (item.kind === 'cluster') {
        return (
          <SystemActivityCluster
            messages={item.messages}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            humansByName={humansByName}
          />
        );
      }
      const m = item.message;
      // System rows are always committed; narrowing here keeps SystemMessage on
      // the plain MessageDto contract while pending rows fall through to the
      // message item below.
      if (isCommittedMessage(m) && m.from_kind === 'system') {
        return (
          <SystemMessage
            message={m}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            humansByName={humansByName}
          />
        );
      }
      return (
        <ChannelMessageItem
          message={m}
          conversationId={channelId}
          canReact={canReact}
          agentsById={agentsById}
          agentsByName={agentsByName}
          humansByName={humansByName}
          humansById={humansById}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          {...actions.rowActionProps(m)}
          onStartThread={onOpenThread ? handleOpenThread : undefined}
          threadReplyCount={
            (replyCountsByRoot?.[m.id] ?? 0) > 0
              ? replyCountsByRoot?.[m.id]
              : undefined
          }
          threadReplySummary={replySummariesByRoot?.[m.id]}
          threadUnread={threadUnreadByRoot?.[m.id]}
          viewerAvatarObjectUrl={viewerAvatarObjectUrl}
          viewer={viewer}
          humanAvatarUrls={humanAvatarUrls}
          agentAvatarUrls={agentAvatarUrls}
          highlighted={
            highlightedMessageId != null && m.id === highlightedMessageId
          }
          jumpFlash={flashedMessageId != null && m.id === flashedMessageId}
          userResolver={userResolver}
          searchQuery={searchQuery}
          searchActive={
            searchActiveMessageId != null && m.id === searchActiveMessageId
          }
        />
      );
    },
    [
      channelId,
      canReact,
      agentsById,
      agentsByName,
      humansByName,
      channelsByName,
      onOpenChannelRef,
      conversationRefsById,
      onOpenConversationRef,
      actions.rowActionProps,
      onOpenThread,
      handleOpenThread,
      replyCountsByRoot,
      replySummariesByRoot,
      threadUnreadByRoot,
      viewerAvatarObjectUrl,
      viewer,
      agentAvatarUrls,
      highlightedMessageId,
      flashedMessageId,
      userResolver,
      searchQuery,
      searchActiveMessageId,
    ],
  );

  return (
    <div className="relative min-h-0 min-w-0 flex-1 flex flex-col">
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
      />
      <div className="relative min-h-0 min-w-0 flex-1">
      {isLoading ? (
        // Initial window fetch: the message skeleton (shared with the full-view
        // skeleton) rather than a "加载消息…" line, so entering a channel reads
        // the same as every other conversation-loading surface. `absolute
        // inset-0` fills this `relative` box.
        <MessageRowsSkeleton className="absolute inset-0" />
      ) : items.length === 0 && !leadingSlot ? (
        <div className="px-4 py-3 text-sm text-text-muted">
          还没有消息。在下方输入。
        </div>
      ) : (
        <Virtuoso<typeof items[number]>
          // Remount on channel switches and full window replacements
          // (latest ↔ around-message). Prepends keep the same key so
          // Virtuoso can preserve scroll position; disjoint windows get
          // a fresh size/scroll queue and can use `initialTopMostItemIndex`.
          key={`${channelId}:${windowResetVersion}`}
          ref={virtuosoRef}
          data={items}
          firstItemIndex={firstItemIndex}
          // On fresh mount, anchor the list at the jump target when
          // there is one (and the around-window has already landed in
          // `items` so we have a real index). Bottom fallback belongs
          // only to ordinary channel opens. During a jump, `idx === -1`
          // means "target not in this window yet"; falling back to the
          // local window bottom is how we ended up stuck on stale
          // around-window tails.
          {...(initialTopMostItemIndex !== undefined
            ? { initialTopMostItemIndex }
            : {})}
          // Stick to bottom only for the real tail. During a saved-message
          // jump, or while browsing an around-message window, the window's
          // bottom is just "the last row we currently hold" — following it
          // would override the target-centered jump and land on stale history.
          followOutput={atBottom =>
            getFollowOutputBehavior({
              hasJumpTarget: jumpToMessageId != null,
              isAtTail,
              atBottom,
            })
          }
          atBottomStateChange={setIsAtBottom}
          atBottomThreshold={20}
          startReached={handleStartReached}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          computeItemKey={(_index, item) => itemKey(item)}
          components={{
            Header: () => (
              <>
                {isFetchingEarlier ? (
                  <div className="pb-2 text-center text-xs text-text-muted">
                    加载更早消息…
                  </div>
                ) : null}
                {leadingSlot ? (
                  <div className="mx-auto mb-1 max-w-[1200px] px-4">
                    {leadingSlot}
                  </div>
                ) : null}
              </>
            ),
            // Bottom padding spacer — keeps the last message off the
            // composer edge without baking the gutter into every item.
            // The activity status now lives inside the Composer's own
            // chrome (variant A), so there is no bottom overlay to
            // reserve space for.
            Footer: () => <div className="h-3" />,
          }}
          itemContent={(_index, item) => (
            <div className="mx-auto max-w-[1200px] px-4 py-0.5">
              {renderItem(item)}
            </div>
          )}
          className="h-full min-w-0"
        />
      )}

      {showScrollBottom || shouldResetToLatest ? (
        <button
          type="button"
          data-scroll-bottom
          aria-label={shouldResetToLatest ? '跳到最新消息' : '滚动到底部'}
          title={shouldResetToLatest ? '跳到最新消息' : '滚动到底部'}
          onClick={() => {
            // `scrollToBottom` is local to the mounted window. After
            // an around-message jump, newer rows can live outside that
            // window, so the button must reset the query to latest.
            if (shouldResetToLatest && onResetToLatest) {
              onResetToLatest();
              return;
            }
            scrollToBottom();
          }}
          className="absolute bottom-4 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-text-on-accent shadow-lg transition-all hover:opacity-90 active:opacity-75"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
      </div>
    </div>
  );
}
