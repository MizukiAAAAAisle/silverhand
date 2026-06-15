import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { toast } from 'sonner';
import {
  ArrowDown,
  CornerDownRight,
  Maximize2,
  CornerUpLeft,
  Minimize2,
  Power,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import type {
  AgentDto,
  ConversationAgentDto,
  HumanMemberDto,
  MemberDto,
  MessageDto,
  ReplyBadgeSummary,
} from '@silverhand/shared';
import { Composer } from '@/components/chat/Composer';
import { ChannelMessageItem } from '@/components/chat/ChannelMessageItem';
import { useMessageRenderContext } from '@/components/chat/useMessageRenderContext';
import { QuotedMessagePreview } from '@/components/chat/QuotedMessagePreview';
import { findThreadAnchor, readAnchorMessageId } from '@/components/chat/threadAnchor';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { groupMessages } from '@/components/chat/groupMessages';
import { useMessageActionSurface } from '@/components/chat/useMessageActionSurface';
import { MessageActionChrome } from '@/components/chat/MessageActionChrome';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
import { HoverPopover } from '@/components/chat/HoverPopover';
import { useConversationMembers } from '@/features/conversations/useConversationMembers';
import { AddConversationMemberPopover } from '@/features/conversations/AddConversationMemberPopover';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import { ChannelSettingsDialog } from './ChannelSettingsDialog';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsersById } from '@/features/users/hooks';
import { usePresenceById, presenceDotStatus } from '@/features/presence/hooks';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { canEditAgentProfile } from '@/features/agents/permissions';
import {
  useChannelAgents,
  useChannelMessages,
  useMarkMessageChannelRead,
  useStartAgent,
  useStopAgent,
} from '@/features/channels/hooks';
import { useConversationStream } from '@/hooks/useConversationStream';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import {
  FIRST_ITEM_INDEX_START,
  getFollowOutputBehavior,
  getInitialTopMostItemIndex,
  shouldRemountForJump,
  shouldRemountForWindowReplacement,
} from './messageListVirtualization';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelDescriptor {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  parent_conversation_id: string | null;
  closed_at: number | null;
  archived_at: number | null;
  workspace_id: string;
}

interface ChannelViewProps {
  /** Kind of the parent workspace. DM and regular channels diverge in
   *  several places (agent strip, sub-thread affordances, member
   *  management). Threaded as a prop so the divergences stay local. */
  channelKind: WorkspaceUiKind | null;
  conversation: ChannelDescriptor | null;
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
  onOpenThread?: (rootMessageId: string) => void;
  /** Toggle the channel Threads-list pane (#task:1073) — opens when
   *  closed, closes when open (#task:1126 follow-up). When set, the header
   *  renders a Threads toggle. Only the primary channel pane passes this —
   *  thread/dm/side panes have no channel-scoped thread index. */
  onToggleThreadsList?: () => void;
  /** Whether the Threads-list pane is currently open (drives the toggle's
   *  active styling + aria-pressed). */
  threadsListActive?: boolean;
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
}

export const ChannelView = memo(function ChannelView(props: ChannelViewProps): JSX.Element {
  if (!props.conversation) {
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
 * one. Channels and threads both support adding (a thread inherits
 * its parent channel's workspace and has its own membership row);
 * DM channels are single-pair by definition. Closed conversations
 * are gated out — the route would also reject with
 * `conversation_closed`, but hiding the trigger keeps the surface
 * intentional.
 */
function canAddMember(
  conv: { kind: 'channel' | 'dm_channel' | 'thread' },
  closed: boolean,
): boolean {
  if (closed) return false;
  return conv.kind === 'channel' || conv.kind === 'thread';
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

  // Advance the message read cursor in real-time as new messages arrive.
  // ChannelView is only rendered when the channel is visible, so any
  // live message that lands here should be marked read immediately — no need
  // to wait for the 5 s polling window in App.tsx.
  const markRead = useMarkMessageChannelRead();
  const onStreamEvent = useCallback(
    (e: { kind: string }) => {
      if (e.kind === 'message') markRead.mutate(conversation.id);
    },
    // markRead.mutate is stable; conversation.id drives re-subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation.id],
  );
  useConversationStream(conversation.id, onStreamEvent);

  const { data: agents = [] } = useAgents();
  // Single batch fetch for every agent avatar in this channel — threaded
  // down to MemberStrip and MessageList (→ MessageItem authors) so the
  // same blob URL is reused everywhere instead of independent hook
  // instances each firing the same network calls. The Composer's
  // activity header (variant A) sources run-state on its own.
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);

  const closed = conversation.closed_at !== null;
  const isArchived = conversation.archived_at !== null;
  const canToggleArchive =
    channelKind === 'regular' &&
    conversation.kind === 'channel' &&
    conversation.parent_conversation_id === null &&
    !!onArchiveChannel;
  // Rename shares archive's structural gate (top-level regular channel),
  // minus the archive-specific bits, plus "not closed" — a closed channel
  // is read-only. The parent decides the permission by whether it passes
  // `onRenameChannel` at all.
  const canRenameChannel =
    channelKind === 'regular' &&
    conversation.kind === 'channel' &&
    conversation.parent_conversation_id === null &&
    !closed &&
    !!onRenameChannel;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: viewer } = useViewerUser();
  const { data: channelAgents = [] } = useChannelAgents(conversation.id);
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
      if (agent.status !== 'active' && agent.status !== 'starting') continue;
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
  const memberStrip = (
    <MemberStrip
      channelId={conversation.id}
      conversationAgents={channelAgents}
      agentAvatarUrls={agentAvatarUrls}
    />
  );

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
  // passed. Secondary panes (legacy thread / `?side`) pass it undefined
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

  return (
    <TaskRefContextProvider value={taskRefContext}>
    <main
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
      }}
    >
      <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        {showThreadHeader ? (
          <>
            <CornerDownRight className="size-4 shrink-0 text-text-muted" />
            <span
              data-conversation-title
              className="min-w-0 truncate font-serif text-base font-semibold text-text-primary"
            >
              <span data-conversation-hash>#</span>
              {parentTitle ?? conversation.title}
            </span>
            {memberStrip}
            {canAddMember(conversation, closed) ? (
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
              {conversation.kind === 'channel' ? (
                <span data-conversation-hash>#</span>
              ) : null}
              {conversation.title}
            </span>
            {memberStrip}
            {canAddMember(conversation, closed) ? (
              <AddConversationMemberPopover
                workspaceId={conversation.workspace_id}
                conversationId={conversation.id}
              />
            ) : null}
            {parentTitle ? (
              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-text-muted">
                <CornerDownRight className="size-3 shrink-0 text-text-muted/60" />
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

        <div data-channel-actions className="ml-auto flex shrink-0 items-center gap-1">
          {onToggleThreadsList ? (
            <button
              type="button"
              onClick={onToggleThreadsList}
              aria-label="Threads"
              aria-pressed={threadsListActive}
              title="Threads"
              className={
                'flex size-8 shrink-0 items-center justify-center rounded-[6px] ' +
                (threadsListActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary')
              }
            >
              <CornerUpLeft className="size-4" />
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
                className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
              >
                <RefreshCw className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => void stopAgents()}
                disabled={agentActionDisabled}
                aria-label={stopTitle}
                title={stopTitle}
                className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Power className="size-4" />
              </button>
            </>
          ) : null}
          {canRenameChannel || canToggleArchive ? (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Channel settings"
              title="Channel settings"
              className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <Settings className="size-4" />
            </button>
          ) : null}
          {onToggleFullscreen ? (
            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏'}
              title={isFullscreen ? '退出全屏' : '全屏'}
              className="flex size-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              {isFullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </button>
          ) : null}
          {onCloseChild ? (
            <button
              type="button"
              onClick={onCloseChild}
              aria-label={closeLabel}
              title={closeLabel}
              className="flex size-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

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
            canReact={!closed && !isArchived}
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
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            onOpenChannelRef={onOpenChannelRef ? handleOpenChannelRef : undefined}
          />
        </div>

        <Composer
          key={conversation.id}
          conversationId={conversation.id}
          disabled={closed}
          archived={isArchived}
        />
      </div>
    </main>
    </TaskRefContextProvider>
  );
}

// ── Member strip ────────────────────────────────────────────────────────

/** Maximum number of chips rendered inline; overflow collapses into a
 *  `+N` chip whose hover popover lists the remaining members. Header
 *  height must not jitter as channels grow membership, so this cap
 *  exists even though current channels rarely exceed it. */
const MEMBER_STRIP_VISIBLE_CAP = 8;

function MemberStrip({
  channelId,
  conversationAgents,
  agentAvatarUrls,
}: {
  channelId: string;
  conversationAgents: ConversationAgentDto[];
  agentAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  const agentById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);
  const conversationAgentById = useMemo(() => {
    const m = new Map<string, ConversationAgentDto>();
    for (const ca of conversationAgents) m.set(ca.agent_id, ca);
    return m;
  }, [conversationAgents]);

  // Members come from the same backend source-of-truth that the
  // platform prompt's "Members in this conversation:" block renders, so
  // chips and prompt can never drift. Self-filter is the renderer's
  // job: the *current human viewer* is dropped here. Agent self has no
  // UI meaning for chips and is intentionally not filtered.
  const membersResult = useConversationMembers(channelId);
  const { data: viewer } = useViewerUser();
  const viewerUserId = viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer) ? viewer.id : null;

  const visibleMembers = useMemo(() => {
    if (membersResult.status !== 'resolved') return [];
    return membersResult.members.filter(m => {
      if (m.kind !== 'human') return true;
      // Drop the current viewer — UI-self has no meaning in a chip strip
      // pointing at "who else is in this room with me".
      return m.user_id !== viewerUserId;
    });
  }, [membersResult, viewerUserId]);

  // Resolve avatars for the human members so HumanMemberChip can render
  // real images instead of letter placeholders (multi-human audit
  // 2026-06-03 #task:857 P0.8). Prefer the conversation member's
  // denormalized avatar URL, and fall back to the global users directory
  // for older responses while mixed builds are still possible.
  const usersById = useUsersById();
  const humanAvatarSources = useMemo(
    () =>
      visibleMembers
        .filter((m): m is Extract<MemberDto, { kind: 'human' }> => m.kind === 'human')
        .map(m => ({
          id: m.user_id,
          avatar_url: m.avatar_url ?? usersById.get(m.user_id)?.avatar_url ?? null,
        })),
    [visibleMembers, usersById],
  );
  const humanMemberAvatarUrls = useUserAvatarObjectUrls(humanAvatarSources);

  // Empty-state: no agents AND no other humans. Keep the original copy
  // when only the agent side is empty (the strip's pre-PR-C contract).
  if (visibleMembers.length === 0 && conversationAgents.length === 0) {
    return (
      <span className="shrink-0 text-[10px] italic text-text-muted">
        Channel 还没有成员
      </span>
    );
  }

  const inline = visibleMembers.slice(0, MEMBER_STRIP_VISIBLE_CAP);
  const overflow = visibleMembers.slice(MEMBER_STRIP_VISIBLE_CAP);

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      data-member-strip
      data-member-count={visibleMembers.length}
    >
      {inline.map(member => {
        if (member.kind === 'agent') {
          const agent = agentById.get(member.agent_id);
          if (!agent) return null;
          const ca = conversationAgentById.get(member.agent_id);
          // No conversation_agents row → agent is in `conversation_users`-style
          // membership but never spawned in this conversation. Render
          // a faint dot (idle) so the chip stays uniform shape.
          const status: ConversationAgentDto['status'] = ca?.status ?? 'idle';
          return (
            <AgentInfoPopover
              key={`agent:${member.agent_id}`}
              agent={agent}
              conversationId={channelId}
              trigger="hover"
              side="bottom"
              align="end"
              avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
            >
              <button
                type="button"
                aria-label={`@${agent.name}`}
                data-member-chip="agent"
                data-member-id={member.agent_id}
                className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-none border border-border-subtle bg-bg-floating p-0 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                <AgentAvatar
                  runtime={agent.runtime}
                  size={20}
                  avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
                  alt={agent.display_name || agent.name}
                />
                <span
                  className={
                    'pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating shadow-sm '
                    + STATUS_DOT[status]
                  }
                />
              </button>
            </AgentInfoPopover>
          );
        }
        return (
          <HumanMemberChip
            key={`human:${member.user_id}`}
            human={member}
            avatarObjectUrl={humanMemberAvatarUrls.get(member.user_id) ?? null}
          />
        );
      })}
      {overflow.length > 0 ? (
        <MemberOverflowChip
          overflow={overflow}
          totalVisible={visibleMembers.length}
        />
      ) : null}
    </div>
  );
}

/**
 * Human chip — same footprint as the agent chip (24px square). Renders
 * the human's actual avatar when the parent has resolved one (multi-human
 * audit 2026-06-03 #task:857 P0.8) and falls back to the display-name
 * initial when no avatar is available yet. Hover popover mirrors
 * `HumanMention`'s content so inline `@handle` mentions and header chips
 * read the same.
 */
function HumanMemberChip({
  human,
  avatarObjectUrl,
}: {
  human: HumanMemberDto;
  avatarObjectUrl: string | null;
}): JSX.Element {
  const label = human.display_name?.trim() || human.name;
  const initial = label.charAt(0).toUpperCase();
  const presence = usePresenceById().get(human.user_id);
  const dot = presenceDotStatus(presence?.presence);
  return (
    <HumanInfoPopover
      human={human}
      userId={human.user_id}
      trigger="hover"
      side="bottom"
      align="end"
      avatarObjectUrl={avatarObjectUrl}
    >
      <button
        type="button"
        aria-label={`@${human.name}`}
        data-member-chip="human"
        data-member-id={human.user_id}
        className="relative inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-none border border-border-subtle bg-bg-elevated p-0 text-xs font-medium text-text-muted transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        {avatarObjectUrl ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={avatarObjectUrl}
            alt=""
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          <span aria-hidden>{initial}</span>
        )}
        <span
          className={
            'pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating shadow-sm '
            + STATUS_DOT[dot]
          }
        />
      </button>
    </HumanInfoPopover>
  );
}

/**
 * `+N` overflow chip. Hover opens a popover listing the collapsed
 * members so the cap doesn't hide the room. Click is a no-op (v1):
 * the design rejects navigation from chips, and a dedicated members
 * panel/route is out of scope here.
 */
function MemberOverflowChip({
  overflow,
  totalVisible,
}: {
  overflow: MemberDto[];
  totalVisible: number;
}): JSX.Element {
  const trigger = (
    <button
      type="button"
      aria-label={`+${overflow.length} more members`}
      data-member-chip="overflow"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated p-0 text-[10px] font-semibold text-text-muted transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      +{overflow.length}
    </button>
  );
  return (
    <HoverPopover
      trigger={trigger}
      isContentReady
      openDelayMs={80}
      content={
        <div
          className="flex flex-col gap-2"
          data-member-overflow-list
          data-member-total={totalVisible}
        >
          <div className="text-[11px] uppercase tracking-wider text-text-muted">
            +{overflow.length} more
          </div>
          {overflow.map(m => {
            const id = m.kind === 'agent' ? m.agent_id : m.user_id;
            const label = m.display_name?.trim() || m.name;
            return (
              <div
                key={`${m.kind}:${id}`}
                className="flex items-center gap-2"
                data-member-overflow-row
                data-member-id={id}
                data-member-kind={m.kind}
              >
                <span className="truncate text-sm text-text-primary">
                  {label}
                </span>
                <span className="truncate font-mono text-xs text-text-muted">
                  @{m.name}
                </span>
              </div>
            );
          })}
        </div>
      }
    />
  );
}

const STATUS_DOT: Record<ConversationAgentDto['status'], string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  crashed: 'bg-error',
  idle: 'bg-text-muted/50',
};

// ── Message list ────────────────────────────────────────────────────────

function MessageList({
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
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  canReact,
}: {
  channelId: string;
  workspaceId: string;
  messages: MessageDto[];
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
  onOpenThread?: (rootMessageId: string) => void;
  /** Per-root reply counts from the message window's cut3-6 sidecar
   *  (`reply_counts_by_root`). Drives the inline "{count} Reply" badge.
   *  A root with 0 (or absent) shows the hover "Thread" action instead. */
  replyCountsByRoot?: Record<string, number>;
  /** Per-root enriched reply-badge summaries (P1, #task:1073). Optional —
   *  when a root has an entry the badge upgrades to avatars + last-reply
   *  time; absent → count-only fallback. */
  replySummariesByRoot?: Record<string, ReplyBadgeSummary>;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** Pre-bound (workspace already resolved) click handler for inline
   *  `#<channel_name>` chips. */
  onOpenChannelRef?: (channelId: string) => void;
  /** Whether the viewer may react in this channel — false when closed or
   *  archived. Threaded down to each MessageItem so the reaction write
   *  affordances hide in a read-only channel (#task:1122 dogfood). */
  canReact: boolean;
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
  const handleOpenThread = (msg: MessageDto): void => {
    onOpenThread?.(msg.id);
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
  // markChannelRead → invalidate → first page only), `prevTopKey` is no
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
      if (m.from_kind === 'system') {
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
          viewerAvatarObjectUrl={viewerAvatarObjectUrl}
          viewer={viewer}
          humanAvatarUrls={humanAvatarUrls}
          agentAvatarUrls={agentAvatarUrls}
          highlighted={
            highlightedMessageId != null && m.id === highlightedMessageId
          }
          jumpFlash={flashedMessageId != null && m.id === flashedMessageId}
          userResolver={userResolver}
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
      viewerAvatarObjectUrl,
      viewer,
      agentAvatarUrls,
      highlightedMessageId,
      flashedMessageId,
      userResolver,
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
        channelKind={channelMeta.kind}
      />
      <div className="relative min-h-0 min-w-0 flex-1">
      {isLoading ? (
        <div className="px-4 py-3 text-sm text-text-muted">加载消息…</div>
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
