import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Hash,
  Maximize2,
  Minimize2,
  Paperclip,
  Power,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { ThreadIcon } from '@/components/icons/conversation-icons';
import { Composer } from '@/components/chat/Composer';
import { ChannelJoinBar } from '@/components/chat/ChannelJoinBar';
import { QuotedMessagePreview } from '@/components/chat/QuotedMessagePreview';
import { findThreadAnchor, readAnchorMessageId } from '@/components/chat/threadAnchor';
import { ConversationViewSkeleton } from '@/components/layout/ConversationViewSkeleton';
import { AddConversationMemberPopover } from '@/features/conversations/AddConversationMemberPopover';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import {
  isBackendUnreachable,
  useViewerUser,
} from '@/features/me/hooks';
import { canEditAgentProfile } from '@/features/agents/permissions';
import {
  useChannelAgents,
  useChannelMessages,
  useConversationUnread,
  useMarkMessageChannelRead,
  useStartAgent,
  useStopAgent,
} from '@/features/channels/hooks';
import { useChannelMembership } from '@/features/channels/use-channel-membership';
import { useJoinChannel } from '@/features/workspaces/hooks';
import { lastCommittedSeq } from '@/features/channels/pending-message';
import { nextTailReadMark, type TailReadMark } from '@/lib/channel-read';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import { MemberStrip } from './channel-view/member-strip';
import { MessageList } from './channel-view/message-list';
import { InlineFindBar } from './InlineFindBar';
import {
  useInlineFindController,
  useInlineFindHotkey,
} from '@/features/search/useInlineFind';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelDescriptor {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel';
  closed_at: number | null;
  archived_at: number | null;
  workspace_id: string;
  /** Per-viewer membership, when the carrier (discovery-union list item)
   *  provides it. Absent on a cross-workspace `?side` ref / deep link →
   *  the view resolves it via a channel-detail fetch (see the membership
   *  derivation below). Drives the read-only-browse + Join gate for a
   *  public channel the viewer hasn't joined. */
  is_member?: boolean;
}

interface ChannelViewProps {
  /** Kind of the parent workspace. DM and regular channels diverge in
   *  several places (agent strip, sub-thread affordances, member
   *  management). Threaded as a prop so the divergences stay local. */
  channelKind: WorkspaceUiKind | null;
  conversation: ChannelDescriptor | null;
  /** True when a channel IS selected in the route but its workspace's channel
   *  list hasn't resolved yet (e.g. a cross-workspace jump from Activity's
   *  "back to source"): `conversation` is transiently null. Distinguishes this
   *  loading window from "no channel selected" so the pane shows a loader
   *  instead of the misleading "select a channel" empty state (#task:1269). */
  resolving?: boolean;
  parentTitle?: string | null;
  /** One-shot scroll-to target. When set and the target message is in
   *  the current channel, MessageList scrolls + flashes it, then calls
   *  `onJumped` so the parent can clear the target (otherwise switching
   *  workspaces and back would re-trigger the scroll). */
  jumpTarget?: { channelId: string; messageId: string } | null;
  /** When true, App is still fetching an `around_message_id` window
   *  for the current `jumpTarget` and the message may not yet be in
   *  cache. MessageList's jump effect uses this to distinguish
   *  "still priming, wait" from "primed and not present, give up"
   *  on `idx === -1`. Bound by App to the latest jump attempt's
   *  `(channelId, messageId)`; superseded by any newer jump. */
  jumpPrimePending?: boolean;
  onJumped?: () => void;
  /** Called when the user clicks Thread / the reply badge on a main-line
   *  message — opens that message's thread (reply cluster) in the right
   *  pane. Receives the root message id. When undefined the Thread action
   *  is hidden (secondary panes can't open nested threads). */
  onOpenThread?: (rootMessageId: string, jumpToMessageId?: string) => void;
  /** Toggle the channel Threads-list pane (#task:1073) — opens when
   *  closed, closes when open (#task:1126 follow-up). When set, the header
   *  renders a Threads toggle. Only the primary channel pane passes this —
   *  thread/dm/side panes have no channel-scoped thread index. */
  onToggleThreadsList?: () => void;
  /** Whether the Threads-list pane is currently open (drives the toggle's
   *  active styling + aria-pressed). */
  threadsListActive?: boolean;
  /** Toggle the channel Attachments-list pane — opens when
   *  closed, closes when open. When set, the header renders an Attachments
   *  toggle. Only the primary channel pane passes this — thread/dm/side
   *  panes have no channel-scoped attachments index. */
  onToggleFilesList?: () => void;
  /** Whether the Attachments-list pane is currently open (drives the
   *  toggle's active styling + aria-pressed). */
  filesListActive?: boolean;
  /** When set, renders an X button in the header that calls this back.
   *  Used by the right-side secondary pane to close itself. */
  onCloseChild?: () => void;
  /** Localized aria/title text for the close button. Defaults to
   *  `'关闭 Thread'` for back-compat. PR-1 secondary pane is generic
   *  (channel/thread/dm), so the caller decides — `'关闭 Thread'` for
   *  thread panes, `'关闭侧栏'` for `?side=<channel>` panes. Ignored
   *  when `onCloseChild` is undefined. */
  closeLabel?: string;
  /** "View in channel" handler — for thread panes, jumps the parent
   *  pane to the original anchor message. Receives the original
   *  message id (which lives in the thread_anchor system message). */
  onJumpToOriginal?: (messageId: string) => void;
  /** Reports this channel's thread anchor target back up so the caller
   *  can persistently highlight that message in the parent pane while
   *  this view is open. Fires with the id when known, null otherwise. */
  onThreadAnchorResolved?: (originalMessageId: string | null) => void;
  /** Persistently mark a message in this view's list with the hover
   *  frame — used by the parent pane to surface "the message a thread
   *  is anchored to". */
  highlightedMessageId?: string | null;
  /** Toggle thread fullscreen (parent pane hidden). Only meaningful
   *  alongside `onCloseChild` (i.e. when this view is the thread pane). */
  onToggleFullscreen?: () => void;
  /** Whether the thread pane is currently fullscreen. Drives the icon
   *  toggle (Maximize2 ↔ Minimize2). */
  isFullscreen?: boolean;
  /** Toggle archive state for top-level regular channels. Archive is
   *  organizational only — it does not disable messaging or agents. */
  onArchiveChannel?: (channelId: string, archived: boolean) => void;
  archivePending?: boolean;
  /** Persist a new channel title. Async so the rename dialog can surface
   *  save errors inline and stay open on failure. Only wired for
   *  top-level regular channels; absence hides the Rename entry. */
  onRenameChannel?: (channelId: string, title: string) => Promise<void>;
  /** Current-workspace top-level conversation id map for inline `#conv:<id>` refs. */
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** Click handler for inline `#<channel_name>` chips. The chip's
   *  resolution scope is this conversation's workspace, so the caller
   *  binds the workspace id and we hand it the resolved channel id. */
  onOpenChannelRef?: (workspaceId: string, channelId: string) => void;
  /** Click handler for inline `#task:<n>` chips. Receives both the
   *  numeric task and the workspace it should resolve against — that's
   *  always the conversation's workspace, since task numbers are
   *  workspace-scoped. App.tsx switches the selected workspace when
   *  needed (cross-workspace `?side` panes) and writes `?task=<n>`. */
  onOpenTask?: (taskNumber: number, workspaceId: string) => void;
  /** In-conversation header find (#task:1335). When provided, the header shows
   *  a search-toggle icon that opens the inline find bar below it. The callback
   *  navigates to a prev/next match in THIS channel via App's shared jump/prime
   *  path (`handleJumpToMessage`) — so off-window matches are materialised, not
   *  skipped. Absent → no find affordance (e.g. secondary panes, which don't
   *  support being jumped into). */
  onJumpToMessage?: (params: MessageJumpTarget) => void;
  /** Opens the advanced `SearchPanel`, carrying the current inline query AND
   *  this conversation's workspace so the advanced panel opens scoped to the
   *  same workspace (shiki #task:1335). Wired in App to prefill the query +
   *  workspace filter. */
  onOpenAdvancedSearch?: (query: string, workspaceId?: string) => void;
}

export const ChannelView = memo(function ChannelView(props: ChannelViewProps): JSX.Element {
  if (!props.conversation) {
    if (props.resolving) {
      // A channel IS selected but its descriptor is still resolving (a
      // cross-workspace jump waiting on the channels list). Show the full
      // conversation skeleton — same header/messages/composer shape the live
      // view will take — so the swap never jumps and we never flash the
      // "no channel" empty text during the 1-2s resolve.
      return <ConversationViewSkeleton />;
    }
    return (
      <main
        className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-chat text-sm text-text-muted"
        style={{
          borderRadius: 'var(--card-radius, 0)',
          boxShadow: 'var(--card-shadow, none)',
        }}
      >
        从左侧选择一个 Channel
      </main>
    );
  }
  return <ActiveChannelView {...props} conversation={props.conversation} />;
});

/**
 * Show the "+ add member" popover when the conversation can take
 * one. Regular channels support adding; DM channels are single-pair
 * by definition. Closed conversations are gated out — the route would
 * also reject with `conversation_closed`, but hiding the trigger keeps
 * the surface intentional.
 */
function canAddMember(
  conv: { kind: 'channel' | 'dm_channel' },
  closed: boolean,
): boolean {
  if (closed) return false;
  return conv.kind === 'channel';
}

// Split out so the React-Query hooks below only mount once a channel
// exists — keeps hook order stable across the null transition.
function ActiveChannelView({
  channelKind,
  conversation,
  parentTitle,
  jumpTarget,
  jumpPrimePending = false,
  onJumped,
  onOpenThread,
  onToggleThreadsList,
  threadsListActive = false,
  onToggleFilesList,
  filesListActive = false,
  onCloseChild,
  closeLabel = '关闭 Thread',
  onJumpToOriginal,
  onThreadAnchorResolved,
  highlightedMessageId,
  onToggleFullscreen,
  isFullscreen,
  onArchiveChannel,
  archivePending = false,
  onRenameChannel,
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  onOpenTask,
  onJumpToMessage,
  onOpenAdvancedSearch,
}: ChannelViewProps & { conversation: ChannelDescriptor }): JSX.Element {
  const {
    data: messages = [],
    isLoading,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
    isAtTail,
    hasNewerLiveGap,
    resetToLatest,
    replyCountsByRoot,
    replySummariesByRoot,
  } = useChannelMessages(conversation.id);

  // Per-viewer membership gate. A PUBLIC channel is readable by a
  // workspace user who has not joined it: they browse (message history + thread
  // content + inline attachment preview) with a Join affordance in place of the
  // composer, and every member effect / mutation is withheld. The three-state
  // (member | nonmember | unknown) is resolved by the shared hook from the
  // carrier's own authoritative `is_member` (or a channel-detail fetch when a
  // deep-link carrier lacks it). The gate is FAIL-CLOSED: until it resolves to
  // `member`, no member effect fires and no write affordance renders. DMs and
  // private channels always resolve to `member` (the backend stamps
  // `is_member: true`), so this is a no-op regression-wise there.
  const { gate } = useChannelMembership(conversation, conversation.id);
  const joinChannel = useJoinChannel(conversation.workspace_id);

  // Per-viewer server-scored unread for this conversation's reply-clusters
  // (#task:1226). The SINGLE source of the chip's "N new" + first-unread —
  // sparse (only roots with unread > 0). Settled from REST after
  // `unread_updated` or this client's successful observe(); the message-window
  // summary no longer carries unread. Gated OFF for a non-member (reading
  // per-viewer unread state is a member effect) — the hook disables its query +
  // WS interest when passed a null id.
  const threadUnreadByRoot = useConversationUnread(
    gate.allowMemberEffects ? conversation.id : null,
  ).data?.threads;

  // Advance the message read cursor as the visible mainline tail advances
  // (#task:1255 P1c). ChannelView is rendered only when the channel is visible,
  // but read advancement is VISIBILITY-driven, not frame-ARRIVAL-driven
  // (#task:1244 / #task:1251 read-inert axis) — so we mark read off the mainline
  // CACHE, not an `onWsFrame` handler (the hook is now a
  // pure reader; gate-(b)). We mark only when the window is genuinely at the
  // tail (`isAtTail && !hasNewerLiveGap`) and the newest mainline row actually
  // advanced. By construction `useChannelMessages` keeps reply-only rows OUT of
  // `messages` (they bump a badge, not the list) and does NOT append while the
  // window is off-tail (it sets the gap instead) — so scrolled-in-history and
  // reply-only frames never mark the mainline read. This is a deliberate read
  // tightening over the old "any message frame → markRead" (which marked on
  // arrival even off-tail / reply-only): see the dogfood handoff note.
  const markRead = useMarkMessageChannelRead();
  // Gate off the newest COMMITTED row — a pending optimistic tail has no
  // MessageSeq, and mark-read must advance on a real ordinal (§3.3/§3.5).
  const tailSeq = lastCommittedSeq(messages);
  const lastMarkedRef = useRef<TailReadMark | null>(null);

  useEffect(() => {
    // Mark-read is a member effect: a non-member browsing a public channel must
    // never advance a read cursor / write read-state (gate.allowMemberEffects).
    // This is a BEHAVIOR gate, not a hidden control — the auto-effect itself is
    // suppressed, not merely a button.
    if (!gate.allowMemberEffects) return;
    const next = nextTailReadMark(
      lastMarkedRef.current,
      conversation.id,
      tailSeq,
      isAtTail,
      hasNewerLiveGap,
    );
    if (!next) return;
    lastMarkedRef.current = next;
    markRead.mutate(conversation.id);
    // markRead.mutate is stable; nextTailReadMark encodes the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, tailSeq, isAtTail, hasNewerLiveGap, gate.allowMemberEffects]);

  const { data: agents = [] } = useAgents();
  // Single batch fetch for every agent avatar in this channel — threaded
  // down to MemberStrip and MessageList (→ MessageItem authors) so the
  // same blob URL is reused everywhere instead of independent hook
  // instances each firing the same network calls. The Composer's
  // activity header (variant A) sources run-state on its own.
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);

  const closed = conversation.closed_at !== null;
  const isArchived = conversation.archived_at !== null;
  // Rename / archive are channel-like organization behaviors (#task:1145):
  // they apply to any top-level channel-like conversation — `channel` in a
  // regular workspace AND `dm_channel` in an agent_home/DM. `conversation.kind`
  // is the precise discriminant (channel ⟺ regular workspace, dm_channel ⟺ DM
  // home), so we no longer gate on the workspace `channelKind` beyond "a
  // workspace is selected". The parent decides the actual permission by whether
  // it passes the handler at all; rename additionally requires "not closed" (a
  // closed channel is read-only).
  const isTopLevelChannelLike =
    channelKind !== null &&
    (conversation.kind === 'channel' || conversation.kind === 'dm_channel');
  const canToggleArchive =
    isTopLevelChannelLike && !!onArchiveChannel && gate.allowMutations;
  const canRenameChannel =
    isTopLevelChannelLike && !closed && !!onRenameChannel && gate.allowMutations;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: viewer } = useViewerUser();
  // The channel roster is a member surface — the roster/agent
  // strip + the restart/stop controls it feeds are join-gated. Disable the
  // fetch (query + WS interest) for a non-member by passing a null id.
  const { data: channelAgents = [] } = useChannelAgents(
    gate.allowMemberEffects ? conversation.id : null,
  );
  const startAgent = useStartAgent(conversation.id);
  const stopAgent = useStopAgent(conversation.id);
  const agentIds = useMemo(
    () => channelAgents.map(agent => agent.agent_id),
    [channelAgents],
  );
  const canManageAllChannelAgents = useMemo(() => {
    if (agentIds.length === 0) return false;
    const viewerForPermissions =
      viewer && isBackendUnreachable(viewer) ? undefined : viewer;
    const agentsById = new Map(agents.map(agent => [agent.id, agent]));
    for (const agentId of agentIds) {
      const agent = agentsById.get(agentId);
      if (!agent || !canEditAgentProfile(viewerForPermissions, agent)) return false;
    }
    return true;
  }, [agentIds, agents, viewer]);
  const agentActionDisabled =
    closed ||
    agentIds.length === 0 ||
    !canManageAllChannelAgents ||
    startAgent.isPending ||
    stopAgent.isPending;
  const restartTitle =
    agentIds.length === 0
      ? 'No agents to restart'
      : 'Restart Channel agents';
  const stopTitle =
    agentIds.length === 0
      ? 'No agents to stop'
      : 'Stop Channel agents';
  const restartAgents = useCallback(async () => {
    if (agentActionDisabled) return;
    for (const agent of channelAgents) {
      await stopAgent.mutateAsync({ agentId: agent.agent_id, mode: 'hard' });
    }
    try {
      for (const agentId of agentIds) {
        await startAgent.mutateAsync(agentId);
      }
    } catch {
      // useStartAgent owns the visible toast; suppress the discarded click promise.
    }
  }, [agentActionDisabled, agentIds, channelAgents, startAgent, stopAgent]);
  const stopAgents = useCallback(async () => {
    if (agentActionDisabled) return;
    for (const agentId of agentIds) {
      await stopAgent.mutateAsync({ agentId, mode: 'hard' });
    }
  }, [agentActionDisabled, agentIds, stopAgent]);
  // The roster/agent strip is a member surface — hidden for a
  // non-member (channelAgents is also empty there, the fetch being gated off).
  const memberStrip = gate.allowMemberEffects ? (
    <MemberStrip
      channelId={conversation.id}
      conversationAgents={channelAgents}
      agentAvatarUrls={agentAvatarUrls}
    />
  ) : null;

  // Thread children carry a single thread_anchor system message — the
  // header surfaces it as "Thread — #parent" + jump-back. The row
  // itself is filtered out of the message list below.
  const anchor = useMemo(() => findThreadAnchor(messages), [messages]);
  const anchorMessageId = anchor ? readAnchorMessageId(anchor.metadata) : null;
  const showThreadHeader = !!onCloseChild && !!anchor;

  // Tell the parent pane which original message this thread is anchored
  // to so it can highlight that row. Re-fires on anchor/id change;
  // cleanup clears the highlight when this view unmounts.
  useEffect(() => {
    if (!onThreadAnchorResolved) return;
    onThreadAnchorResolved(anchorMessageId);
    return () => onThreadAnchorResolved(null);
  }, [onThreadAnchorResolved, anchorMessageId]);

  const visibleMessages = useMemo(
    () => (anchor ? messages.filter(m => m.id !== anchor.id) : messages),
    [messages, anchor],
  );
  const loadEarlierMessages = useCallback(() => {
    if (!hasPreviousPage || isFetchingPreviousPage) return;
    void fetchPreviousPage();
  }, [fetchPreviousPage, hasPreviousPage, isFetchingPreviousPage]);

  // Resolve the prop-driven jump target — fires when the global Saved
  // view or the Tasks panel hands us a `{channelId, messageId}` for a
  // message inside this channel. Cleared by `onJumped` once the
  // message-list scroll completes.
  const effectiveJumpMessageId =
    jumpTarget && jumpTarget.channelId === conversation.id
      ? jumpTarget.messageId
      : null;
  const handleMessageJumped = useCallback(() => {
    if (jumpTarget && jumpTarget.channelId === conversation.id) {
      onJumped?.();
    }
  }, [conversation.id, jumpTarget, onJumped]);

  // The reply affordance (open thread + per-root reply badge) is
  // actionable only on the parent pane, gated by `onOpenThread` being
  // passed. The secondary `?side` pane passes it undefined
  // so the action is hidden. Per-root reply counts come from the message
  // window's cut3-6 sidecar (`replyCountsByRoot`) — there is no separate
  // threads query anymore.


  // Bind a TaskRefContext to this conversation's workspace. Inline
  // `#task:<n>` chips inside this pane resolve their numeric reference
  // against `conversation.workspace_id` — the message's workspace, not
  // the primary-selected workspace. Cross-workspace `?side` panes
  // therefore look up tasks in the foreign workspace transparently.
  const taskRefContext = useMemo(
    () => ({
      workspaceId: conversation.workspace_id,
      onOpenTask: onOpenTask
        ? (taskNumber: number) =>
            onOpenTask(taskNumber, conversation.workspace_id)
        : undefined,
    }),
    [conversation.workspace_id, onOpenTask],
  );
  const handleOpenChannelRef = useCallback(
    (channelId: string) => {
      onOpenChannelRef?.(conversation.workspace_id, channelId);
    },
    [conversation.workspace_id, onOpenChannelRef],
  );

  // In-conversation header find (#task:1335). Local to this pane. Navigation is
  // an "ensure the match is visible" op, NOT "reopen a message window" (Cindy):
  //   • match already in the LOADED window (data, not DOM — a virtualized row
  //     can be loaded-but-unmounted) → MessageList scrolls to it locally via
  //     `searchActiveMessageId` (no prime, no Virtuoso remount → no white flash).
  //   • match off the loaded window → App's jump/prime path materialises it.
  // Offered only when the pane supports being jumped into (`onJumpToMessage`
  // present) — secondary `?side` panes don't, so they show no find affordance.
  const findEnabled = !!onJumpToMessage;
  // In-channel find is a member surface — the allowlist restores it
  // only on join. Gate the toggle, the ⌘F hotkey, and the overlay together.
  const findAvailable = findEnabled && gate.allowMemberEffects;
  const loadedMessageIds = useMemo(
    () => new Set(visibleMessages.map(m => m.id)),
    [visibleMessages],
  );
  const inlineFindNavigate = useCallback(
    (messageId: string) => {
      // Ensure-visible: an in-window match needs no prime — the reactive local
      // scroll in MessageList (keyed on the active match id) positions it
      // without touching the message window. Only escalate genuine off-window
      // matches to the heavier jump/prime path.
      if (loadedMessageIds.has(messageId)) return;
      onJumpToMessage?.({
        workspaceId: conversation.workspace_id,
        channelId: conversation.id,
        messageId,
        // Main-stream ensure-visible: prime + locate in THIS already-open
        // channel without a route change, so an open thread side panel isn't
        // collapsed (shiki/Cindy #task:1335).
        preserveSidePanel: true,
      });
    },
    [loadedMessageIds, onJumpToMessage, conversation.workspace_id, conversation.id],
  );
  const find = useInlineFindController({
    conversationId: conversation.id,
    stream: 'mainline',
    onNavigate: inlineFindNavigate,
    // Gate the QUERY SOURCE, not just the toggle: a non-member must never reach
    // the member-only /api/search, and a downgrade while open force-clears it.
    enabled: findAvailable,
  });
  // ⌘F opens the find. Channel is the primary pane, so it also claims ⌘F when
  // focus is nowhere specific (see useInlineFindHotkey).
  const findRootRef = useRef<HTMLElement>(null);
  useInlineFindHotkey({
    rootRef: findRootRef,
    enabled: findAvailable,
    isPrimary: true,
    onOpen: find.openFind,
  });

  return (
    <TaskRefContextProvider value={taskRefContext}>
    <main
      ref={findRootRef}
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        {showThreadHeader ? (
          <>
            <ThreadIcon className="size-4 shrink-0 text-text-muted" />
            <span
              data-conversation-title
              className="min-w-0 truncate font-serif text-base font-semibold text-text-primary"
            >
              {/* A thread is a reply-cluster, not a channel: the
                  `ThreadIcon` above is its identity glyph, so the
                  channel `#` (`[data-conversation-hash-icon]`) does NOT
                  belong here — only true channel/DM headers carry it
                  (shiki, #task:1373). */}
              {parentTitle ?? conversation.title}
            </span>
            {memberStrip}
            {canAddMember(conversation, closed) && gate.allowMutations ? (
              <AddConversationMemberPopover
                workspaceId={conversation.workspace_id}
                conversationId={conversation.id}
              />
            ) : null}
            {onJumpToOriginal && anchorMessageId ? (
              <button
                type="button"
                onClick={() => onJumpToOriginal(anchorMessageId)}
                className="text-xs text-accent hover:underline"
                title="跳转到原消息"
              >
                view in channel
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span
              data-conversation-title
              className="min-w-0 truncate font-serif text-base font-semibold text-text-primary"
            >
              {/* Every conversation header carries the channel `#` — a
                  channel-like conversation always earns it, so there's no
                  branch: this else-branch is the main channel/DM header and
                  `conversation` is always `channel` | `dm_channel`. (Threads
                  take the showThreadHeader branch above, which shows the
                  `ThreadIcon` instead — no `#`.) Painted per
                  theme via `[data-conversation-hash-icon]` (shiki: "只要是
                  channel 都需要 # icon,逻辑上不需要分支", #task:1373). */}
              <Hash
                data-conversation-hash-icon
                className="size-4 shrink-0 align-[-0.15em]"
              />
              {conversation.title}
            </span>
            {memberStrip}
            {canAddMember(conversation, closed) && gate.allowMutations ? (
              <AddConversationMemberPopover
                workspaceId={conversation.workspace_id}
                conversationId={conversation.id}
              />
            ) : null}
            {parentTitle ? (
              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-text-muted">
                <ThreadIcon className="size-3 shrink-0 text-text-muted/60" />
                <span className="truncate">thread of {parentTitle}</span>
              </span>
            ) : null}
          </>
        )}
        {closed ? (
          <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
            closed
          </span>
        ) : null}
        {isArchived ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent">
            archived
          </span>
        ) : null}

        <div data-channel-actions className="ml-auto flex shrink-0 items-center gap-1.5">
          {findAvailable ? (
            <button
              type="button"
              onClick={find.open ? find.close : find.openFind}
              aria-label="Search this channel"
              aria-pressed={find.open}
              title="Search this channel"
              className={
                'flex size-7 shrink-0 items-center justify-center rounded-[6px] ' +
                (find.open
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary')
              }
            >
              <Search className="size-3.5" />
            </button>
          ) : null}
          {onToggleThreadsList && gate.allowMemberEffects ? (
            <button
              type="button"
              onClick={onToggleThreadsList}
              aria-label="Threads"
              aria-pressed={threadsListActive}
              title="Threads"
              className={
                'flex size-7 shrink-0 items-center justify-center rounded-[6px] ' +
                (threadsListActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary')
              }
            >
              <ThreadIcon className="size-3.5" />
            </button>
          ) : null}
          {onToggleFilesList && gate.allowMemberEffects ? (
            <button
              type="button"
              onClick={onToggleFilesList}
              aria-label="Attachments"
              aria-pressed={filesListActive}
              title="Attachments"
              className={
                'flex size-7 shrink-0 items-center justify-center rounded-[6px] ' +
                (filesListActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary')
              }
            >
              <Paperclip className="size-3.5" />
            </button>
          ) : null}
          {canManageAllChannelAgents ? (
            <>
              <button
                type="button"
                onClick={() => void restartAgents()}
                disabled={agentActionDisabled}
                aria-label={restartTitle}
                title={restartTitle}
                className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
              >
                <RefreshCw className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void stopAgents()}
                disabled={agentActionDisabled}
                aria-label={stopTitle}
                title={stopTitle}
                className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Power className="size-3.5" />
              </button>
            </>
          ) : null}
          {canRenameChannel || canToggleArchive ? (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Channel settings"
              title="Channel settings"
              className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <Settings className="size-3.5" />
            </button>
          ) : null}
          {onToggleFullscreen ? (
            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏'}
              title={isFullscreen ? '退出全屏' : '全屏'}
              className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              {isFullscreen ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          ) : null}
          {onCloseChild ? (
            <button
              type="button"
              onClick={onCloseChild}
              aria-label={closeLabel}
              title={closeLabel}
              className="flex size-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      {/* Inline find bar (#task:1335) — a header OVERLAY, not a flex sibling of
          the message list. Anchored just below the h-12 header (`top-12`) and
          taken out of flow (`absolute`) so opening / closing / typing NEVER
          changes the scroll container's height → no Virtuoso reflow / flicker
          (shiki: 搜索框不应挤压对话流、不应触发重渲染). It only drives the
          search controller + this overlay; the message window is untouched
          until the user navigates to a match (ensure-visible below). */}
      {findAvailable && find.open ? (
        <div className="absolute inset-x-0 top-12 z-20">
          <InlineFindBar
            controller={find}
            onOpenAdvanced={() =>
              onOpenAdvancedSearch?.(find.query, conversation.workspace_id)
            }
            placeholder="Search this channel"
          />
        </div>
      ) : null}

      {canRenameChannel || canToggleArchive ? (
        <ChannelSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          currentTitle={conversation.title}
          onRename={
            canRenameChannel && onRenameChannel
              ? title => onRenameChannel(conversation.id, title)
              : undefined
          }
          isArchived={isArchived}
          onToggleArchive={
            canToggleArchive && onArchiveChannel
              ? archived => onArchiveChannel(conversation.id, archived)
              : undefined
          }
          archivePending={archivePending}
        />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Message area + activity dock share a relative box so the dock
            can float out-of-flow at the bottom (above the composer). The
            scroller's viewport height never changes when the dock shows /
            hides / grows — no content judder. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList
            channelId={conversation.id}
            workspaceId={conversation.workspace_id}
            messages={visibleMessages}
            canReact={!closed && !isArchived && gate.allowMutations}
            canSave={gate.allowMutations}
            canParticipate={gate.allowMemberEffects}
            isLoading={isLoading}
            hasMoreBefore={!!hasPreviousPage}
            isFetchingEarlier={isFetchingPreviousPage}
            onLoadEarlier={loadEarlierMessages}
            agentAvatarUrls={agentAvatarUrls}
            leadingSlot={
              anchor ? (
                <QuotedMessagePreview
                  quoteMessage={anchor}
                  onJumpToOriginal={
                    onJumpToOriginal && anchorMessageId
                      ? () => onJumpToOriginal(anchorMessageId)
                      : undefined
                  }
                />
              ) : null
            }
            highlightedMessageId={highlightedMessageId ?? null}
            jumpToMessageId={effectiveJumpMessageId}
            jumpPrimePending={
              // Only pass `true` when this pane's prop-driven jump
              // (the App-orchestrated saved/task jump) is the one
              // App is currently priming. activity-strip jumps stay
              // local — those messages are by construction recent
              // and already in cache, so they never go through the
              // prime path.
              jumpPrimePending && !!jumpTarget && jumpTarget.channelId === conversation.id
            }
            onJumped={handleMessageJumped}
            isAtTail={isAtTail}
            hasNewerLiveGap={hasNewerLiveGap}
            onResetToLatest={resetToLatest}
            onOpenThread={onOpenThread}
            replyCountsByRoot={replyCountsByRoot}
            replySummariesByRoot={replySummariesByRoot}
            threadUnreadByRoot={threadUnreadByRoot}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            onOpenChannelRef={onOpenChannelRef ? handleOpenChannelRef : undefined}
            searchQuery={find.highlightQuery}
            searchActiveMessageId={find.activeMessageId}
          />
        </div>

        {gate.showComposer ? (
          <Composer
            key={conversation.id}
            conversationId={conversation.id}
            disabled={closed}
            archived={isArchived}
          />
        ) : gate.showJoin ? (
          // Resolved non-member browsing a public channel: Join replaces the
          // composer. `unknown` (membership still resolving) shows NEITHER — a
          // neutral state — so we never flash a Join affordance we might revoke.
          <ChannelJoinBar
            onJoin={() => joinChannel.mutate(conversation.id)}
            joining={joinChannel.isPending}
            channelTitle={conversation.title}
          />
        ) : null}
      </div>
    </main>
    </TaskRefContextProvider>
  );
}
