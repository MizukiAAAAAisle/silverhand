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
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  CornerDownRight,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Power,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  AgentDto,
  AgentRunState,
  ConversationAgentDto,
  MessageDto,
  ThreadDto,
} from '@silverhand/shared';
import { Composer } from '@/components/chat/Composer';
import { MessageItem } from '@/components/chat/MessageItem';
import { AgentActivityStrip } from '@/components/chat/AgentActivityBubble';
import { QuotedMessagePreview } from '@/components/chat/QuotedMessagePreview';
import { findThreadAnchor, readAnchorMessageId } from '@/components/chat/threadAnchor';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { SystemActivityCluster } from '@/components/chat/SystemActivityCluster';
import { groupMessages } from '@/components/chat/groupMessages';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import {
  AppDropdownMenu,
  AppDropdownMenuItem,
} from '@/components/menus/AppContextMenu';
import { useAgents } from '@/features/agents/hooks';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  type ChannelListItem,
} from '@/features/workspaces/hooks';
import {
  useChannelThreads,
  useStartThread,
  type ThreadSummary,
} from '@/features/threads/hooks';
import { useSavedMessageIds, useToggleSave } from '@/features/saved/hooks';
import {
  useChannelAgents,
  useChannelMessages,
  useAgentRunStates,
  useMarkMessageChannelRead,
  useStartAgent,
  useStopAgent,
} from '@/features/channels/hooks';
import { useConversationStream } from '@/hooks/useConversationStream';
import type { ChannelReference } from '@/components/chat/ChannelRef';
import type { ConversationReference } from '@/components/chat/ConversationRef';

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
  onJumped?: () => void;
  /** Called when the user clicks Thread on a message. The parent owns
   *  thread-pane state — receives the freshly-created thread id
   *  and the conversation DTO (if available) for optimistic rendering.
   *  When this is undefined the Thread action is hidden (threads
   *  can't spawn sub-threads). */
  onThreadCreated?: (threadId: string, thread?: ThreadDto) => void;
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

// Split out so the React-Query hooks below only mount once a channel
// exists — keeps hook order stable across the null transition.
function ActiveChannelView({
  channelKind,
  conversation,
  parentTitle,
  jumpTarget,
  onJumped,
  onThreadCreated,
  onCloseChild,
  closeLabel = '关闭 Thread',
  onJumpToOriginal,
  onThreadAnchorResolved,
  highlightedMessageId,
  onToggleFullscreen,
  isFullscreen,
  onArchiveChannel,
  archivePending = false,
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
  onOpenTask,
}: ChannelViewProps & { conversation: ChannelDescriptor }): JSX.Element {
  const routeKind = conversation.parent_conversation_id ? 'thread' : 'channel';
  const {
    data: messages = [],
    isLoading,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = useChannelMessages(conversation.id, routeKind);

  // Advance the message read cursor in real-time as new messages arrive.
  // ChannelView is only rendered when the channel is visible, so any
  // live message that lands here should be marked read immediately — no need
  // to wait for the 5 s polling window in App.tsx.
  const markRead = useMarkMessageChannelRead();
  const onStreamEvent = useCallback(
    (e: { kind: string }) => {
      if (e.kind === 'message') markRead.mutate({ id: conversation.id, kind: routeKind });
    },
    // markRead.mutate is stable; conversation.id drives re-subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation.id, routeKind],
  );
  useConversationStream(conversation.id, onStreamEvent, routeKind);
  const { data: runStates = [] } = useAgentRunStates(conversation.id, routeKind);

  // Active = non-terminal states only (idle/failed are removed by the hook).
  // Guard defensively in case a terminal event arrives just before re-render.
  const activeRunStates = useMemo(
    () => runStates.filter(s => s.status !== 'idle' && s.status !== 'failed'),
    [runStates],
  );
  const { data: agents = [] } = useAgents();
  const activityAgentsById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const agent of agents) m.set(agent.id, agent);
    return m;
  }, [agents]);

  const closed = conversation.closed_at !== null;
  const isArchived = conversation.archived_at !== null;
  const canToggleArchive =
    channelKind === 'regular' &&
    conversation.kind === 'channel' &&
    conversation.parent_conversation_id === null &&
    !!onArchiveChannel;
  const { data: channelAgents = [] } = useChannelAgents(conversation.id, routeKind);
  const startAgent = useStartAgent(conversation.id, routeKind);
  const stopAgent = useStopAgent(conversation.id, routeKind);
  const agentIds = useMemo(
    () => channelAgents.map(agent => agent.agent_id),
    [channelAgents],
  );
  const agentActionDisabled =
    closed ||
    agentIds.length === 0 ||
    startAgent.isPending ||
    stopAgent.isPending;
  const restartTitle =
    agentIds.length === 0
      ? 'No agents to restart'
      : `Restart ${routeKind === 'thread' ? 'Thread' : 'Channel'} agents`;
  const stopTitle =
    agentIds.length === 0
      ? 'No agents to stop'
      : `Stop ${routeKind === 'thread' ? 'Thread' : 'Channel'} agents`;
  const restartAgents = useCallback(async () => {
    if (agentActionDisabled) return;
    for (const agentId of agentIds) {
      await stopAgent.mutateAsync({ agentId, mode: 'hard' });
    }
    for (const agentId of agentIds) {
      await startAgent.mutateAsync(agentId);
    }
  }, [agentActionDisabled, agentIds, startAgent, stopAgent]);
  const stopAgents = useCallback(async () => {
    if (agentActionDisabled) return;
    for (const agentId of agentIds) {
      await stopAgent.mutateAsync({ agentId, mode: 'hard' });
    }
  }, [agentActionDisabled, agentIds, stopAgent]);
  const memberStrip = (
    <AgentStrip
      channelId={conversation.id}
      routeKind={routeKind}
      conversationAgents={channelAgents}
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
  const activityAnchorMessageId = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      const message = visibleMessages[i]!;
      if (message.from_kind === 'user') return message.id;
    }
    return null;
  }, [visibleMessages]);
  const [activityJumpMessageId, setActivityJumpMessageId] = useState<string | null>(null);
  useEffect(() => {
    setActivityJumpMessageId(null);
  }, [conversation.id]);
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
      : activityJumpMessageId;
  const handleMessageJumped = useCallback(() => {
    if (jumpTarget && jumpTarget.channelId === conversation.id) {
      onJumped?.();
      return;
    }
    setActivityJumpMessageId(null);
  }, [conversation.id, jumpTarget, onJumped]);

  // Open-thread summary for this channel — only fetched on parent
  // panes (where Thread is actionable). Thread panes can't have
  // sub-threads so the query is gated and stays disabled there.
  const isParentPane = !!onThreadCreated;
  const { data: threads = [] } = useChannelThreads(
    isParentPane ? conversation.id : null,
    isParentPane ? conversation.workspace_id : null,
  );
  const threadByAnchor = useMemo(() => {
    const m = new Map<string, ThreadSummary>();
    for (const t of threads) {
      if (t.anchor_message_id) m.set(t.anchor_message_id, t);
    }
    return m;
  }, [threads]);

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
      <header className="flex h-[var(--titlebar-height)] min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        {showThreadHeader ? (
          <>
            <CornerDownRight className="size-3.5 shrink-0 text-text-muted" />
            <span className="min-w-0 truncate font-serif text-sm font-semibold text-text-primary">
              #{parentTitle ?? conversation.title}
            </span>
            {memberStrip}
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
            <span className="min-w-0 truncate font-serif text-sm font-semibold text-text-primary">
              {conversation.title}
            </span>
            {memberStrip}
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

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void restartAgents()}
            disabled={agentActionDisabled}
            aria-label={restartTitle}
            title={restartTitle}
            className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void stopAgents()}
            disabled={agentActionDisabled}
            aria-label={stopTitle}
            title={stopTitle}
            className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Power className="size-3.5" />
          </button>
          {canToggleArchive ? (
            <AppDropdownMenu
              trigger={
                <button
                  type="button"
                  aria-label="Channel actions"
                  title="Channel actions"
                  className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              }
            >
              <AppDropdownMenuItem
                disabled={archivePending}
                icon={
                  isArchived ? (
                    <ArchiveRestore className="size-3.5" />
                  ) : (
                    <Archive className="size-3.5" />
                  )
                }
                onSelect={() => onArchiveChannel?.(conversation.id, !isArchived)}
              >
                {isArchived ? 'Restore' : 'Archive'}
              </AppDropdownMenuItem>
            </AppDropdownMenu>
          ) : null}
          {onToggleFullscreen ? (
            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏'}
              title={isFullscreen ? '退出全屏' : '全屏'}
              className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
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
              className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          channelId={conversation.id}
          workspaceId={conversation.workspace_id}
          messages={visibleMessages}
          isLoading={isLoading}
          hasMoreBefore={!!hasPreviousPage}
          isFetchingEarlier={isFetchingPreviousPage}
          onLoadEarlier={loadEarlierMessages}
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
          onJumped={handleMessageJumped}
          onThreadCreated={onThreadCreated}
          threadByAnchor={threadByAnchor}
          activeRunStates={activeRunStates}
          routeKind={routeKind}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          onOpenChannelRef={onOpenChannelRef ? handleOpenChannelRef : undefined}
        />

        {activeRunStates.length > 0 ? (
          <AgentActivityStrip
            states={activeRunStates}
            agentsById={activityAgentsById}
            anchorMessageId={activityAnchorMessageId}
            onJumpToAnchor={() => {
              if (activityAnchorMessageId) {
                setActivityJumpMessageId(activityAnchorMessageId);
              }
            }}
          />
        ) : null}

        <Composer
          key={conversation.id}
          conversationId={conversation.id}
          routeKind={routeKind}
          disabled={closed}
          archived={isArchived}
        />
      </div>
    </main>
    </TaskRefContextProvider>
  );
}

// ── Agent strip ─────────────────────────────────────────────────────────

function AgentStrip({
  channelId,
  routeKind,
  conversationAgents,
}: {
  channelId: string;
  routeKind: 'channel' | 'thread';
  conversationAgents: ConversationAgentDto[];
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  const agentById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  if (conversationAgents.length === 0) {
    return (
      <span className="shrink-0 text-[10px] italic text-text-muted">
        {routeKind === 'thread' ? 'Thread' : 'Channel'} 还没有成员
      </span>
    );
  }
  // Plain inline roster: members sit beside the name. Each avatar keeps
  // its own presence dot and border, without overlapping the next member.
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {conversationAgents.map(s => {
        const agent = agentById.get(s.agent_id);
        if (!agent) return null;
        return (
          <AgentInfoPopover
            key={s.agent_id}
            agent={agent}
            conversationId={channelId}
            routeKind={routeKind}
            trigger="hover"
            side="bottom"
            align="end"
            management
          >
            <button
              type="button"
              aria-label={`@${agent.name}`}
              className="relative rounded-full border border-[#9ca3af] bg-bg-floating p-px shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            >
              <AgentAvatar runtime={agent.runtime} size={22} />
              <span
                className={
                  'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-bg-floating shadow-sm ' +
                  STATUS_DOT[s.status]
                }
              />
            </button>
          </AgentInfoPopover>
        );
      })}
    </div>
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
  leadingSlot,
  highlightedMessageId,
  jumpToMessageId,
  onJumped,
  onThreadCreated,
  threadByAnchor,
  activeRunStates,
  routeKind,
  conversationRefsById,
  onOpenConversationRef,
  onOpenChannelRef,
}: {
  channelId: string;
  workspaceId: string;
  messages: MessageDto[];
  isLoading: boolean;
  hasMoreBefore: boolean;
  isFetchingEarlier: boolean;
  onLoadEarlier: () => void;
  leadingSlot?: ReactNode;
  highlightedMessageId?: string | null;
  jumpToMessageId: string | null;
  onJumped?: () => void;
  onThreadCreated?: (threadId: string, thread?: ThreadDto) => void;
  /** Map of `original message id → open-thread summary` for the parent
   *  pane. Empty / absent on thread panes. Drives the per-message
   *  "{count} Reply" badge and short-circuits the POST when a thread
   *  already exists (just opens it). */
  threadByAnchor?: Map<string, ThreadSummary>;
  /** In-flight agent run states. The fixed strip renders outside this
   *  scroller; MessageList only uses runId changes to keep bottom-following
   *  stable when the strip appears. */
  activeRunStates?: AgentRunState[];
  routeKind: 'channel' | 'thread';
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  /** Pre-bound (workspace already resolved) click handler for inline
   *  `#<channel_name>` chips. */
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  // Resolve `#<channel_name>` against the message's workspace — not the
  // primary-selected workspace — so cross-workspace `?side` panes still
  // resolve refs that exist in their own workspace. Both the active
  // and archived channel lists feed the lookup so an archived channel's
  // name still resolves to a clickable chip (the chip dims via
  // `closed_at` for closed channels).
  const workspaceKind: 'regular' | 'dm' | null =
    workspaces.find(w => w.id === workspaceId)?.kind ?? null;
  const { data: liveChannels = [] } = useChannelsForWorkspace(
    workspaceId,
    workspaceKind,
  );
  const { data: archivedChannels = [] } = useArchivedChannelsForWorkspace(
    workspaceId,
    workspaceKind,
  );
  const savedIds = useSavedMessageIds();
  const { toggle: toggleSave } = useToggleSave();
  const startThread = useStartThread(workspaceId);
  // Three lookup maps used by the message renderer:
  //  - `agentsById`   → message author (avatar + display name)
  //  - `agentsByName` → inline `@handle` mention pills
  //  - `channelsByName` → inline `#<channel_name>` ref pills
  const { agentsById, agentsByName } = useMemo(() => {
    const byId = new Map<string, AgentDto>();
    const byName = new Map<string, AgentDto>();
    for (const a of agents) {
      byId.set(a.id, a);
      byName.set(a.name, a);
    }
    return { agentsById: byId, agentsByName: byName };
  }, [agents]);
  // Build the channel-name lookup keyed by channel `title`. Threads
  // aren't addressable by `#<name>` (use `#conv:<id>` for threads), so
  // we filter to top-level channels (`channel` / `dm_channel`). When
  // two channels in the same workspace share a title we record the
  // ambiguity sentinel `null` so `<ChannelRef>` degrades to inert text
  // — picking a destination silently is worse than asking the user to
  // disambiguate.
  //
  // Short-circuit when workspaces haven't hydrated yet (`workspaceKind
  // === null`): both channel queries are `enabled: false` in that
  // window, so they emit empty arrays. Returning the empty map directly
  // skips a wasted iteration and signals "still resolving" to
  // `<ChannelRef>`, which renders unresolved → inert text — same
  // observable outcome, one fewer allocation.
  const channelsByName = useMemo(() => {
    const m = new Map<string, ChannelReference | null>();
    if (workspaceKind === null) return m;
    const consider = (c: ChannelListItem): void => {
      if (c.kind === 'thread') return;
      const title = c.title;
      if (m.has(title)) {
        m.set(title, null);
        return;
      }
      m.set(title, {
        id: c.id,
        title: c.title,
        closed_at: c.closed_at ?? null,
        archived_at: c.archived_at ?? null,
      });
    };
    for (const c of liveChannels) consider(c);
    for (const c of archivedChannels) consider(c);
    return m;
  }, [workspaceKind, liveChannels, archivedChannels]);

  const handleStartThread = (msg: MessageDto): void => {
    if (!onThreadCreated) return;
    // Already a thread on this message → just open it; no POST needed.
    const existing = threadByAnchor?.get(msg.id);
    if (existing) {
      onThreadCreated(existing.thread_id);
      return;
    }
    if (startThread.isPending) return;
    startThread.mutate(msg.id, {
      onSuccess: res => onThreadCreated(res.thread_id, res.thread),
    });
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
  // We key on `activeRunIds` (a stable joined string of runIds) rather than
  // the full `activeRunStates` array so that heartbeat-only updates (which
  // don't change the set of running agents) don't trigger spurious scrolls.
  const activeRunIds = (activeRunStates ?? []).map(s => s.runId).join(',');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const programmaticBottomScrollRef = useRef(false);
  const programmaticBottomTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const loadEarlierSnapshotRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const loadEarlierInFlightRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Reset "near bottom" whenever the channel changes so every new channel
  // opens in follow-bottom mode regardless of the previous scroll position.
  useEffect(() => {
    wasNearBottomRef.current = true;
    programmaticBottomScrollRef.current = false;
    if (programmaticBottomTimerRef.current) {
      clearTimeout(programmaticBottomTimerRef.current);
      programmaticBottomTimerRef.current = null;
    }
    setShowScrollBottom(false);
    loadEarlierInFlightRef.current = false;
    return () => {
      if (programmaticBottomTimerRef.current) {
        clearTimeout(programmaticBottomTimerRef.current);
        programmaticBottomTimerRef.current = null;
      }
    };
  }, [channelId]);

  useEffect(() => {
    if (!isFetchingEarlier) {
      loadEarlierInFlightRef.current = false;
    }
  }, [isFetchingEarlier]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    let requestedEarlier = false;
    if (
      hasMoreBefore &&
      !isFetchingEarlier &&
      !loadEarlierInFlightRef.current &&
      el.scrollTop <= 80
    ) {
      loadEarlierInFlightRef.current = true;
      loadEarlierSnapshotRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      wasNearBottomRef.current = false;
      requestedEarlier = true;
      onLoadEarlier();
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!requestedEarlier) {
      wasNearBottomRef.current = distFromBottom <= 20;
    }
    if (programmaticBottomScrollRef.current) {
      setShowScrollBottom(false);
      if (distFromBottom <= 20) {
        programmaticBottomScrollRef.current = false;
        if (programmaticBottomTimerRef.current) {
          clearTimeout(programmaticBottomTimerRef.current);
          programmaticBottomTimerRef.current = null;
        }
      }
      return;
    }
    setShowScrollBottom(distFromBottom > 120);
  }, [hasMoreBefore, isFetchingEarlier, onLoadEarlier]);

  useLayoutEffect(() => {
    const snapshot = loadEarlierSnapshotRef.current;
    const el = scrollRef.current;
    if (!snapshot || !el) return;
    const delta = el.scrollHeight - snapshot.scrollHeight;
    el.scrollTop = snapshot.scrollTop + delta;
    loadEarlierSnapshotRef.current = null;
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticBottomScrollRef.current = true;
    if (programmaticBottomTimerRef.current) {
      clearTimeout(programmaticBottomTimerRef.current);
    }
    programmaticBottomTimerRef.current = setTimeout(() => {
      programmaticBottomScrollRef.current = false;
      programmaticBottomTimerRef.current = null;
      const current = scrollRef.current;
      if (!current) return;
      const distFromBottom =
        current.scrollHeight - current.scrollTop - current.clientHeight;
      setShowScrollBottom(distFromBottom > 120);
    }, 1_500);
    wasNearBottomRef.current = true;
    setShowScrollBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (jumpToMessageId) return;
    if (!wasNearBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollBottom(false);
  }, [messages, jumpToMessageId, activeRunIds, channelId]);

  // Jump to a specific message (typically from Saved view). Waits for
  // the message to be in the DOM, scrolls into view, briefly highlights
  // it, then signals completion so the parent clears the target.
  useEffect(() => {
    if (!jumpToMessageId) return;
    if (messages.length === 0) return; // wait for load
    const target = document.getElementById(`msg-${jumpToMessageId}`);
    if (!target) {
      // The target may live in an older page. Keep paging backward
      // before giving up; Saved and Tasks can point well outside the
      // latest message window.
      if (hasMoreBefore) {
        if (!isFetchingEarlier) {
          onLoadEarlier();
        }
        return;
      }
      // Message might have been deleted; clear the target once there is
      // no older history left to search.
      onJumped?.();
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Explicitly mark "not near bottom" so auto-scroll doesn't fire after
    // onJumped clears jumpToMessageId. The user must scroll back down
    // themselves to re-engage bottom-following.
    wasNearBottomRef.current = false;
    setShowScrollBottom(true);
    target.classList.add('msg-jump-flash');
    const t = setTimeout(() => {
      target.classList.remove('msg-jump-flash');
      onJumped?.();
    }, 1600);
    return () => clearTimeout(t);
  }, [
    hasMoreBefore,
    isFetchingEarlier,
    jumpToMessageId,
    messages,
    onLoadEarlier,
    onJumped,
  ]);

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full min-w-0 overflow-y-auto px-4 py-3"
      >
        {isFetchingEarlier ? (
          <div className="pb-2 text-center text-xs text-text-muted">
            加载更早消息…
          </div>
        ) : null}
        {leadingSlot ? <div className="mx-auto mb-1 max-w-[1200px]">{leadingSlot}</div> : null}
        {isLoading ? (
          <div className="text-sm text-text-muted">加载消息…</div>
        ) : messages.length === 0 ? (
          leadingSlot ? null : (
            <div className="text-sm text-text-muted">还没有消息。在下方输入。</div>
          )
        ) : (
          <ol className="mx-auto max-w-[1200px] space-y-1">
            {groupMessages(messages).map(item => {
              if (item.kind === 'cluster') {
                return (
                  <li key={item.id}>
                    <SystemActivityCluster
                      messages={item.messages}
                      conversationRefsById={conversationRefsById}
                      onOpenConversationRef={onOpenConversationRef}
                      channelsByName={channelsByName}
                      onOpenChannelRef={onOpenChannelRef}
                    />
                  </li>
                );
              }
              const m = item.message;
              return (
              <li key={m.id}>
                {m.from_kind === 'system' ? (
                  <SystemMessage
                    message={m}
                    conversationRefsById={conversationRefsById}
                    onOpenConversationRef={onOpenConversationRef}
                    channelsByName={channelsByName}
                    onOpenChannelRef={onOpenChannelRef}
                  />
                ) : (
                  <MessageItem
                    message={m}
                    conversationId={channelId}
                    routeKind={routeKind}
                    agentsById={agentsById}
                    agentsByName={agentsByName}
                    channelsByName={channelsByName}
                    onOpenChannelRef={onOpenChannelRef}
                    conversationRefsById={conversationRefsById}
                    onOpenConversationRef={onOpenConversationRef}
                    saved={savedIds.has(m.id)}
                    onSave={msg => toggleSave(msg.id)}
                    onStartThread={onThreadCreated ? handleStartThread : undefined}
                    threadReplyCount={threadByAnchor?.get(m.id)?.reply_count}
                    highlighted={
                      highlightedMessageId != null &&
                      m.id === highlightedMessageId
                    }
                  />
                )}
              </li>
              );
            })}
          </ol>
        )}
      </div>

      {showScrollBottom ? (
        <button
          type="button"
          aria-label="滚动到底部"
          title="滚动到底部"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-text-on-accent shadow-lg transition-opacity hover:opacity-90 active:opacity-75"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
