import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Bell, BellOff, Search } from 'lucide-react';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import { authorGroupContinuations } from '@/components/chat/authorGrouping';
import { groupMessages } from '@/components/chat/groupMessages';
import { MessageItem } from '@/components/chat/MessageItem';
import { useAuthorAvatarObjectUrls } from '@/components/chat/author-avatar-hooks';
import { InlineFindBar } from './InlineFindBar';
import {
  useInlineFindController,
  useInlineFindHotkey,
} from '@/features/search/useInlineFind';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { Composer } from '@/components/chat/Composer';
import { SelectionQuoteToolbar } from '@/components/chat/SelectionQuoteToolbar';
import { ChannelJoinBar } from '@/components/chat/ChannelJoinBar';
import { MessageRowsSkeleton } from '@/components/layout/ConversationViewSkeleton';
import {
  SidePanelHeader,
  SidePanelHeaderTitle,
} from '@/components/layout/SidePanelHeader';
import { useMessageRenderContext } from '@/components/chat/useMessageRenderContext';
import { useMessageActionSurface } from '@/components/chat/useMessageActionSurface';
import { MessageActionChrome } from '@/components/chat/MessageActionChrome';
import {
  threadClusterShowsLoader,
  threadLiveMarkReadSeq,
  threadMarkReadSnapshot,
  threadOpenNeedsLatestRefetch,
  threadTailIsVisible,
} from './threadMarkRead';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import { type JumpPhase, jumpWindowLockedForPhase, threadLocateAllowed } from '@/features/channels/messageJumpPhase';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import {
  useFollowThread,
  useMarkThreadRead,
  useThreadCluster,
  useThreadFollowers,
  useThreadRoot,
  useUnfollowThread,
} from '@/features/channels/hooks';
import {
  isCommittedMessage,
  lastCommittedSeq,
} from '@/features/channels/pending-message';
import type { MessageSeq } from '@silverhand/shared';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useJoinChannel } from '@/features/workspaces/hooks';
import {
  channelGateFor,
  type MembershipState,
} from '@/features/channels/membership';
import { classifyTopShift } from '@/components/layout/messageListVirtualization';

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
  /** The PARENT channel's per-viewer membership, resolved by App
   *  from the SAME authority `ChannelView` uses (the shared
   *  `useChannelMembership` three-state — never a collapsed boolean). A thread
   *  shares its channel's membership: `member` participates fully; `nonmember`
   *  reads the thread but the composer is replaced by Join and every member
   *  affordance (follow / react / save / attachment export) hides; `unknown`
   *  (still resolving) is NEUTRAL — neither composer nor Join — so we never
   *  flash a Join we might revoke. Required (no default) so a caller can't
   *  silently fail open. */
  membership: MembershipState;
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
  /** `(taskId)` — App-level handler; wrapped into a
   *  `TaskRefContextProvider` scoped to this thread's workspace so inline
   *  `#task:<n>` chips resolve against it, then hand up the resolved id
   *  (which is workspace-free) to open the detail modal. */
  onOpenTask?: (taskId: string) => void;
  /** A reply inside this cluster to scroll-locate + flash. Set by App when
   *  a jump (task/saved/search/notification) targets a message whose
   *  `thread_root_id === rootMessageId`. App gates this to this cluster, so
   *  the panel just locates. Null = no pending jump. */
  jumpMessageId?: string | null;
  /** The jump's `primeAround` lifecycle PHASE for a first-unread jump into
   *  THIS thread (#task:1317), or null when no jump is active. The single
   *  source of truth from which this pane projects three independent signals: the
   *  shared phase projections `jumpWindowLockedForPhase` (→ holds the
   *  cluster query disabled so a latest fetch can't clobber the around-window,
   *  through `committed` until `clearJump`) and `threadLocateAllowed` (→ poll only
   *  once `committed`/`settled`, never against a still-priming/stale window), plus
   *  the loader `threadClusterShowsLoader` (→ cover only while `priming`). */
  jumpPhase?: JumpPhase | null;
  /** Called once the jump completes (flashed) or is given up (target not in
   *  the loaded window). App clears the jump target on this. */
  onJumped?: () => void;
  /** In-conversation header find (#task:1335), scoped to THIS thread stream.
   *  When provided, the thread header shows a search-toggle icon. The callback
   *  navigates to a prev/next match via App's shared jump/prime path (carrying
   *  `threadRootId` so the cluster window is primed + this pane scroll-locates
   *  the reply). Absent → no find affordance (e.g. docked source viewer). */
  onJumpToMessage?: (params: MessageJumpTarget) => void;
  /** Opens the advanced `SearchPanel`, carrying the current inline query AND
   *  this thread's workspace so the advanced panel opens scoped to it
   *  (shiki #task:1335). */
  onOpenAdvancedSearch?: (query: string, workspaceId?: string) => void;
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
  membership,
  onClose,
  onViewInChannel,
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  onOpenTask,
  jumpMessageId,
  jumpPhase = null,
  onJumped,
  onJumpToMessage,
  onOpenAdvancedSearch,
}: ThreadPanelProps): JSX.Element {
  // Derive the member gate from the authoritative parent-channel three-state
  // membership. `canParticipate` (member effects: follow / react / save /
  // attachment export + the mark-read effect below) is member-only. The
  // composer / Join slot uses the full gate so `unknown` shows NEITHER.
  const gate = channelGateFor(membership);
  const canParticipate = gate.allowMemberEffects;
  const rootCtx = useThreadRoot(channelId, rootMessageId);
  const cluster = useThreadCluster(channelId, rootMessageId, {
    jumpWindowLocked: jumpWindowLockedForPhase(jumpPhase),
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
  // Thread follow is a member surface: a non-member's fetch is
  // disabled (null root), and the activity bubble then stays empty-allow-listed.
  const followers = useThreadFollowers(
    channelId,
    canParticipate ? rootMessageId : null,
  );
  const viewerFollowing = followers.data?.viewer_following ?? false;
  // Until we have an authoritative follower snapshot, restrict the
  // (channel-scoped) activity bubble to an EMPTY allow-list so it shows
  // nothing — never fall back to unrestricted, which would leak main-line /
  // other-cluster agents into this thread. Showing full activity under
  // unknown state is wrong info, not a graceful fallback. `useThreadFollowers`
  // keeps this snapshot fresh against the thread message stream (auto-follow
  // side effects).
  const followerAgentIds = followers.data?.follower_agent_ids ?? [];
  const followThread = useFollowThread(channelId, rootMessageId);
  const unfollowThread = useUnfollowThread(channelId, rootMessageId);
  const markThreadRead = useMarkThreadRead();
  const followPending = followThread.isPending || unfollowThread.isPending;
  // Join the PARENT channel (the Composer-slot affordance for a non-member
  // browsing this public channel's thread).
  const joinChannel = useJoinChannel(workspaceId);
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
    viewerAvatarObjectUrl,
    viewer,
    userResolver,
    liveChannels,
    archivedChannels,
  } = useMessageRenderContext(workspaceId, channelId, canParticipate);
  const { data: agents = [] } = useAgents();
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  // Byline avatar bytes come STRICTLY from each rendered row's own author DTO
  // (#task:1792 B2) — the pinned root + every reply in this cluster — never the
  // workspace directory, so a deleted / departed author still renders its own
  // snapshot avatar or a neutral glyph. `agentAvatarUrls` (directory) stays the
  // source for the independent axis of inline `@handle` mention pills.
  const { agentAvatarUrls: authorAgentAvatarUrls, humanAvatarUrls: authorUserAvatarUrls } =
    useAuthorAvatarObjectUrls(messages.map(m => (isCommittedMessage(m) ? m.author : null)));

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
    canSave: canParticipate,
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
  // grown by prepend/append or trimmed at the head). A disjoint replacement —
  // reset-to-latest, an off-tail composer send rebuilding to a tail page, a
  // reconnect invalidate, or an around-reply jump — leaves `selection.selected`
  // holding rows that are no longer in view. ChannelView gets this for free
  // from `useMessageSelection`'s `windowResetVersion`; the cluster needs the
  // same signal. We classify the top-of-window shift with the shared helper so
  // all three shapes are told apart:
  //   • prepend / append — old rows still present, selection stays valid.
  //   • head-trim — a live-appended latest page refetched to its fixed size
  //     drops HEAD rows (the old top vanishes), but the selection below the
  //     trimmed head survives, so it must NOT clear. The old "top-id gone =
  //     disjoint" test wrongly cleared here.
  //   • replace — genuinely disjoint window; the selection is stale → clear.
  // We deliberately do NOT update the ref across a transient empty window
  // (`resetToLatest` clears the cache to [] before the tail refetch lands), so
  // the pre-reset window is still remembered when the fresh window arrives.
  const prevKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (messages.length === 0) return; // keep prevKeysRef across transient empties
    const keys = messages.map(m => m.id);
    const prevKeys = prevKeysRef.current;
    prevKeysRef.current = keys;
    if (classifyTopShift(prevKeys, keys).kind === 'replace') {
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
    () => ({ workspaceId, onOpenTask }),
    [workspaceId, onOpenTask],
  );

  // In-conversation header find (#task:1335) is set up below, after the scroll
  // controller it depends on (`pinBottomRef` / `setShowScrollBottom`).

  // The root is pinned separately (see below), so drop it from the
  // scrolled reply list to avoid rendering it twice — it can appear in
  // the cluster window for small threads (where the window reaches the
  // start) but not for large ones (tail-anchored window).
  const replyMessages = useMemo(
    () => messages.filter(m => m.id !== rootMessageId),
    [messages, rootMessageId],
  );
  const items = useMemo(() => groupMessages(replyMessages), [replyMessages]);
  // Consecutive-same-author runs (#task:1737) — the same rule the channel
  // stream applies, over the same post-clustering sequence. Computed from
  // `items` (replies only), so the separately pinned root above the divider is
  // never in the set and the first reply always leads its own group.
  const authorContinuations = useMemo(
    () => authorGroupContinuations(items),
    [items],
  );

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
    // Instant — same back-to-bottom command semantics as the channel.
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
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

  // Mirror the tail-retreat action into a ref so the jump-locate effect can call
  // it on GIVE-UP (#task:1317 §4.3) without taking window-position values
  // (`shouldResetToLatest`) as effect deps — which would cancel/restart the poll
  // on every scroll. Retreating to the TRUE thread tail (reset the window if
  // mid-history, else scroll to bottom) is exactly `handleScrollBottomClick`, so
  // the "jump to latest" button and the locate give-up degrade identically.
  const retreatToTailRef = useRef(handleScrollBottomClick);
  retreatToTailRef.current = handleScrollBottomClick;

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 20;
    pinBottomRef.current = atBottom;
    setShowScrollBottom(!atBottom);
  }, []);

  // In-conversation header find (#task:1335), scoped to THIS thread stream
  // (stream='thread' + thread_root_id). Navigation is "ensure the match is
  // visible", NOT "reopen a window" (Cindy). This pane is a plain (non-
  // virtualized) scroller, so every LOADED reply is mounted:
  //   • match in the loaded data (a reply in `messages`, or the pinned root) →
  //     scroll to its already-mounted node locally — no prime, no cluster
  //     re-window, no white flash. We decide on the loaded DATA, not DOM
  //     presence, to stay consistent with the channel pane.
  //   • match off the loaded window → App's jump/prime path (carrying
  //     `threadRootId`) primes the cluster window and this pane's rAF locate
  //     (below) scroll-flashes the reply once it lands.
  // Offered only when the pane supports being jumped into (`onJumpToMessage`).
  // `findRootRef` is declared before `inlineFindNavigate` so the local locate can
  // scope its node lookup to THIS pane (see below).
  const findRootRef = useRef<HTMLElement>(null);
  const findEnabled = !!onJumpToMessage;
  // In-thread search is a member surface — the allowlist restores
  // it only on join. Gate the toggle, the ⌘F hotkey, the bar, AND the query
  // source (via the controller's `enabled`) together, mirroring ChannelView.
  const findAvailable = findEnabled && canParticipate;
  const inlineFindNavigate = useCallback(
    (messageId: string) => {
      const inWindow =
        messageId === rootMessageId || messages.some(m => m.id === messageId);
      if (inWindow) {
        // Scope the lookup to THIS pane's root: the thread root is rendered in
        // BOTH the channel mainline and here with the same `id="msg-<root>"`, so
        // a global `document.getElementById` would resolve to the channel's copy
        // and scroll the WRONG pane (Cindy). Message ids are URL-safe, so the
        // attribute selector needs no escaping — its job is the pane SCOPE (dodge
        // the duplicate global id), not char-escaping.
        const node = findRootRef.current?.querySelector(
          `[id="msg-${messageId}"]`,
        );
        if (node) {
          // Hold position: stop follow-bottom from yanking away from the match
          // when the next reply arrives (mirrors the jump-locate effect).
          pinBottomRef.current = false;
          setShowScrollBottom(true);
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
      }
      onJumpToMessage?.({
        workspaceId,
        channelId,
        threadRootId: rootMessageId,
        messageId,
      });
    },
    [messages, onJumpToMessage, workspaceId, channelId, rootMessageId],
  );
  const find = useInlineFindController({
    conversationId: channelId,
    stream: 'thread',
    threadRootId: rootMessageId,
    onNavigate: inlineFindNavigate,
    enabled: findAvailable,
  });
  // ⌘F opens the thread find — but only when focus is inside this panel (the
  // channel handles the nowhere-focus default). See useInlineFindHotkey.
  useInlineFindHotkey({
    rootRef: findRootRef,
    enabled: findAvailable,
    isPrimary: false,
    onOpen: find.openFind,
  });

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
  // Thread mark-read forward-only gates. `null` = "nothing marked / in flight
  // yet" — explicit absence, not a 0 sentinel (#task:1267 Axis-B: never collapse
  // "none" into value 0). Both hold a MessageSeq for THIS thread stream.
  const markInflightSeqRef = useRef<MessageSeq | null>(null);
  const lastMarkedSeqRef = useRef<MessageSeq | null>(null);
  const liveMarkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest tail seq that PASSED the visible-live gate but has not been marked
  // yet — the debounce may still be pending. Kept in sync with the gate by the
  // visible-live effect (set to the gated seq, or null the moment the gate closes
  // — scrolled up / backgrounded). Read only by the close/switch flush below, so a
  // seen-but-not-yet-debounced reply still advances the cursor when the panel is
  // closed within the 300ms window, WITHOUT ever swallowing a tail the user
  // scrolled away from (that path already nulled this ref).
  const liveGatedSeqRef = useRef<MessageSeq | null>(null);
  const isJumpOpenRef = useRef(false);
  const openKey = `${channelId}::${rootMessageId}`;
  if (openKeyRef.current !== openKey) {
    openKeyRef.current = openKey;
    openedAtRef.current = Date.now();
    markedForOpenRef.current = false;
    markInflightSeqRef.current = null;
    lastMarkedSeqRef.current = null;
    // Whether THIS open began as a first-unread jump. Captured once at open so
    // a later `clearJump` (which nulls `jumpMessageId`) can't flip it and
    // trigger a latest refetch that clobbers the around-window mid-read.
    isJumpOpenRef.current = jumpMessageId != null;
  }

  // Issue a mark-read to `seq`: forward-only, once per seq. `lastMarkedSeqRef`
  // advances on mutation SUCCESS only — a pending/failed mark must not look
  // cleared locally while the server cursor hasn't moved. The in-flight guard
  // collapses re-fires while one is pending; on error the cursor is untouched so
  // the next trigger retries. Human-attention only — writes the viewer's read
  // cursor, never delivery/wake.
  const markThreadReadMutate = markThreadRead.mutate;
  const issueMarkRead = useCallback(
    (seq: MessageSeq, onMarked?: () => void) => {
      // Mark-read is a member effect: a non-member browsing a
      // public channel's thread must never advance thread read-state. Behavior
      // gate, not a hidden control — the auto-effect itself is suppressed.
      if (!canParticipate) return;
      // Same-stream (this thread) MessageSeq compares, guarded on explicit
      // absence: a null gate ("nothing marked / none in flight") never blocks
      // the first mark (#task:1267 Axis-B).
      if (lastMarkedSeqRef.current !== null && seq <= lastMarkedSeqRef.current) return;
      if (markInflightSeqRef.current !== null && seq <= markInflightSeqRef.current) return;
      markInflightSeqRef.current = seq;
      markThreadReadMutate(
        { channelId, threadRootId: rootMessageId, snapshotSeq: seq },
        {
          onSuccess: () => {
            if (lastMarkedSeqRef.current === null || seq > lastMarkedSeqRef.current)
              lastMarkedSeqRef.current = seq;
            onMarked?.();
          },
          onSettled: () => {
            if (markInflightSeqRef.current === seq) markInflightSeqRef.current = null;
          },
        },
      );
    },
    [channelId, rootMessageId, markThreadReadMutate, canParticipate],
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
  // SUCCESS only — NOT optimistically — so a failed open-time mark stays
  // retryable: `issueMarkRead` is forward-only + in-flight-guarded, so re-running
  // this effect while the mark is pending is a no-op, and on failure the guard
  // is never armed, so the next dep change (a new reply bumps `streamHeadSeq`, a
  // refetch bumps `windowFetchSucceededAt`) retries. The visible-live effect
  // below independently covers the pinned-tail case.
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

  // Document visibility as REACTIVE state. The live-mark gate reads visibility,
  // but `document.hidden` read inline isn't reactive — `visibilitychange` fires
  // no React render. Without this, a reply that arrives while the app is
  // backgrounded correctly stays unread, but when the user returns to the
  // foreground (tail reply now on screen) nothing re-runs the
  // gate, so it lingers unread until the next message/scroll/reopen. Mirroring
  // visibility into state makes the return-to-visible transition a dependency
  // that re-fires the live-mark effect.
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden,
  );
  useEffect(() => {
    const onVisibility = (): void => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () =>
      document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // VISIBLE-LIVE mark: a reply arriving while the panel is open + watched should
  // clear unread without a close/reopen. Follow the read cursor to the newest
  // reply ONLY while the committed DOM viewport reaches the true stream tail
  // AND the window is visible — never swallowing an unrendered tail (scrolled
  // up) or a backgrounded panel. The actual viewport is sampled here instead
  // of trusting `pinBottomRef`: that ref controls follow intent and can be stale
  // after a clamped/no-op jump scroll. `threadLiveMarkReadSeq` is the pure gate;
  // debounced so a
  // burst of replies collapses to one mark at the latest visible seq
  // (max-VISIBLE, not latest-known — `messages` is the loaded
  // window). `lastMarkedSeqRef` (advanced on success) keeps it forward-only.
  // `documentVisible` is a dep so returning to the foreground re-runs the gate.
  const maxLoadedSeq = lastCommittedSeq(messages);
  useEffect(() => {
    const viewport = scrollRef.current;
    const seq = threadLiveMarkReadSeq({
      tailVisible:
        viewport !== null &&
        threadTailIsVisible({
          streamAtTail: isAtTail,
          scrollHeight: viewport.scrollHeight,
          scrollTop: viewport.scrollTop,
          clientHeight: viewport.clientHeight,
        }),
      documentVisible,
      maxVisibleSeq: maxLoadedSeq,
      lastMarkedSeq: lastMarkedSeqRef.current,
    });
    // Track the gated seq for the close/switch flush. When the gate closes
    // (scrolled up / backgrounded → seq null) this clears, so a later close can
    // never flush a tail the user is no longer watching (no-swallow preserved).
    liveGatedSeqRef.current = seq;
    if (seq === null) return;
    if (liveMarkTimerRef.current) clearTimeout(liveMarkTimerRef.current);
    liveMarkTimerRef.current = setTimeout(() => {
      liveMarkTimerRef.current = null;
      // Re-check at fire time: the user may have scrolled up or backgrounded
      // the app during the debounce window.
      const currentViewport = scrollRef.current;
      if (
        currentViewport === null ||
        !threadTailIsVisible({
          streamAtTail: isAtTail,
          scrollHeight: currentViewport.scrollHeight,
          scrollTop: currentViewport.scrollTop,
          clientHeight: currentViewport.clientHeight,
        }) ||
        document.hidden
      ) {
        return;
      }
      issueMarkRead(seq);
    }, 300);
    return () => {
      if (liveMarkTimerRef.current) {
        clearTimeout(liveMarkTimerRef.current);
        liveMarkTimerRef.current = null;
      }
    };
  }, [
    showScrollBottom,
    documentVisible,
    maxLoadedSeq,
    isAtTail,
    issueMarkRead,
  ]);

  // Flush a SEEN-but-unmarked tail reply when THIS open ends — the panel closes
  // (unmount) or switches to another thread — before the 300ms visible-live
  // debounce fired. Without this, closing the panel within the debounce window
  // clears the pending timer and the read cursor stays behind the reply the user
  // already saw (the ghost-unread badge, #task:1519). Keyed on `issueMarkRead`,
  // which is itself keyed on (channelId, rootMessageId) — so the cleanup runs on
  // close (unmount) AND on switch-to-another-thread, but NOT on scroll/append.
  // Those change the gate inputs (a different effect) and already keep
  // `liveGatedSeqRef` truthful, so a tail the user scrolled away from is null here
  // and not flushed. `issueMarkRead` is forward-only + in-flight-guarded, so this
  // can only advance the cursor, never swallow the concurrent tail or double-mark.
  useEffect(() => {
    return () => {
      const seq = liveGatedSeqRef.current;
      liveGatedSeqRef.current = null;
      if (seq !== null) issueMarkRead(seq);
    };
  }, [issueMarkRead]);

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
    // Locate only once the around-window is the authoritative one for THIS open:
    // `committed` (window written to cache AND still locked, so it can't be
    // clobbered) or `settled` (best-effort fallback against whatever loaded).
    // NEVER while `priming` — polling a still-fetching / previous-open stale
    // window is the original mis-anchor bug (#task:1317). The effect re-runs
    // when the phase advances (dep below), so a committed prime kicks it off.
    if (!threadLocateAllowed(jumpPhase)) return;
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
        // Give up: the target isn't in the loaded window (a `settled` fallback
        // whose target is off-window, or an unexpected miss). Degrade to the
        // TRUE thread tail — reset the window if it's mid-history, else scroll
        // the loaded window to its bottom — never latch a half-way stale scroll
        // and never leave a stuck loader (#task:1317 §4.3). Then release the
        // jump so the phase clears (no "neither render nor release" state).
        retreatToTailRef.current();
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
  }, [jumpMessageId, jumpPhase, onJumped]);

  const renderMessage = (m: typeof messages[number]): JSX.Element =>
    isCommittedMessage(m) && m.from_kind === 'system' ? (
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
        canReact={!closed && !archived && canParticipate}
        canParticipate={canParticipate}
        canMutateLinkedTask={!closed && !archived && gate.allowMutations}
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
        authorAgentAvatarUrls={authorAgentAvatarUrls}
        authorUserAvatarUrls={authorUserAvatarUrls}
        agentAvatarUrls={agentAvatarUrls}
        userResolver={userResolver}
        searchQuery={find.highlightQuery}
        searchActive={
          find.activeMessageId != null && m.id === find.activeMessageId
        }
        continuesPrevious={authorContinuations.has(m.id)}
        {...actions.rowActionProps(m)}
      />
    );

  return (
    <TaskRefContextProvider value={taskRefContext}>
    <aside
      ref={findRootRef}
      data-pane="thread"
      className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-chat,transparent)]"
    >
      <SidePanelHeader
        onClose={onClose}
        actions={
          <>
            {findAvailable ? (
              <button
                type="button"
                onClick={find.open ? find.close : find.openFind}
                aria-label="Search this thread"
                aria-pressed={find.open}
                title="Search this thread"
                className={
                  'flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] ' +
                  (find.open
                    ? 'bg-bg-hover text-text-primary'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-primary')
                }
              >
                <Search className="size-3.5" />
              </button>
            ) : null}
            {followers.data && canParticipate ? (
              <button
                type="button"
                aria-label={viewerFollowing ? 'Unfollow thread' : 'Follow thread'}
                aria-pressed={viewerFollowing}
                title={viewerFollowing ? 'Unfollow thread' : 'Follow thread'}
                onClick={toggleFollow}
                disabled={followPending}
                className={
                  'flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] hover:bg-bg-hover disabled:opacity-50 ' +
                  (viewerFollowing
                    ? 'text-text-primary hover:text-text-primary'
                    : 'text-text-muted hover:text-text-primary')
                }
              >
                {viewerFollowing ? (
                  <BellOff className="size-3.5" />
                ) : (
                  <Bell className="size-3.5" />
                )}
              </button>
            ) : null}
            {onViewInChannel ? (
              <button
                type="button"
                aria-label="View in channel"
                title="View in channel"
                onClick={onViewInChannel}
                className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary"
              >
                <ArrowUpRight className="size-3.5" />
              </button>
            ) : null}
          </>
        }
      >
        <SidePanelHeaderTitle
          icon={<ThreadIcon className="size-3.5 shrink-0 text-text-muted" />}
          title={parentTitle || 'Thread'}
          subtitle={
            <>
              Thread · {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </>
          }
        />
      </SidePanelHeader>

      {/* Inline find bar (#task:1335) — a header OVERLAY, not a flex sibling of
          the reply scroller. Anchored just below the h-12 header (`top-12`) and
          out of flow (`absolute`) so opening / closing / typing never changes
          the scroller's height (shiki: 搜索框不应挤压对话流、不应触发重渲染).
          It drives only the search controller + overlay; the cluster window is
          untouched until the user navigates to a match (ensure-visible above). */}
      {findAvailable && find.open ? (
        <div className="absolute inset-x-0 top-12 z-[var(--z-sticky)]">
          <InlineFindBar
            controller={find}
            onOpenAdvanced={() => onOpenAdvancedSearch?.(find.query, workspaceId)}
            placeholder="Search this thread"
          />
        </div>
      ) : null}

      {rootCtx.isError ? (
        // Root unavailable (404 / legacy thread target / fetch failure).
        // Distinct from "no replies yet" — the thread can't be shown at
        // all, and replying would have no valid target.
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-text-muted">
          This message can't be loaded. It may have been deleted.
        </div>
      ) : rootCtx.isLoading && !rootCtx.root ? (
        // Root still loading: the shared message skeleton under the thread
        // header, matching every other conversation-loading surface.
        <MessageRowsSkeleton />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageActionChrome
            surface={actions}
            renderCtx={{
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
                {cluster.isFetchingPreviousPage ? 'Loading…' : 'Load earlier replies'}
              </button>
            ) : null}

            {/* Root message — the cluster anchor, rendered inline as the
                first message in the stream. No longer pinned (#task:1050
                item 1) so replies get the panel's full height. */}
            {rootCtx.root ? renderMessage(rootCtx.root) : null}

            {/* Root's bottom divider — sets the thread's originating message
                (its subject) apart from the replies below it (#task:1735). It is
                the SAME kind of element as the panel header's bottom rule (an
                internal separator between stacked regions of one surface), so it
                speaks the same language: `border-border-subtle`, the 1px neutral
                hairline, in every theme — matching `SidePanelHeader`. forza6's
                2px poster ink is reserved for FRAME borders (things enclosed on
                all sides + hard shadow); using it here read as a frame fragment
                next to the header hairline (#task:1735 shiki feedback). Full-bleed
                horizontally (`-mx-1` cancels the scroll container's `px-1`) so it
                runs edge to edge. `shrink-0` keeps it a hairline in the flex
                column even when the "No replies yet" empty state claims the
                remaining height. Gated on the root so it reads as the root's own
                bottom edge — present whether or not there are replies yet. */}
            {rootCtx.root ? (
              <div className="-mx-1 my-2 shrink-0 border-t border-border-subtle" />
            ) : null}

            {threadClusterShowsLoader({
              isLoading: cluster.isLoading,
              jumpPhase,
            }) ? (
              // Loader only while there is genuinely nothing THIS open can render
              // yet: a real in-flight fetch, OR a jump still `priming` (its
              // around-window has not committed). Once the prime advances to
              // `committed` the (still-locked) query's cache carries the
              // around-window and we render it even though the jump isn't done —
              // the controller keeps the window LOCKED until the visual
              // locate/flash calls `onJumped → clearJump`, and hiding the
              // messages would starve that locate of its DOM node.
              // `threadClusterShowsLoader` is a pure projection of `jumpPhase`
              // (committed-fact, zero wall-clock) — no deadlock (#task:1317).
              <MessageRowsSkeleton />
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
              aria-label={shouldResetToLatest ? 'Jump to latest reply' : 'Scroll to bottom'}
              title={shouldResetToLatest ? 'Jump to latest reply' : 'Scroll to bottom'}
              onClick={handleScrollBottomClick}
              className="absolute bottom-4 left-1/2 z-[var(--z-sticky)] flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-text-on-accent shadow-lg transition-all hover:opacity-90 active:opacity-75"
            >
              <ArrowDown className="size-4" />
            </button>
          ) : null}
        </div>
      )}

      <SelectionQuoteToolbar
        boundaryRef={scrollRef}
        draftKey={`${channelId}#cluster#${rootMessageId}`}
      />

      {gate.showComposer ? (
        <Composer
          key={`${channelId}#cluster#${rootMessageId}`}
          conversationId={channelId}
          threadRootId={rootMessageId}
          disabled={closed || rootCtx.isError || !rootCtx.root}
          archived={archived}
          activityAgentIds={followerAgentIds}
        />
      ) : gate.showJoin ? (
        // Resolved non-member browsing a public channel's thread: Join (the
        // parent channel) replaces the reply composer. `unknown` (still
        // resolving) shows NEITHER — a neutral state — so we never flash a Join
        // affordance we might revoke.
        <ChannelJoinBar
          onJoin={() => joinChannel.mutate(channelId)}
          joining={joinChannel.isPending}
          channelTitle={channelMeta.title}
        />
      ) : null}
    </aside>
    </TaskRefContextProvider>
  );
}
