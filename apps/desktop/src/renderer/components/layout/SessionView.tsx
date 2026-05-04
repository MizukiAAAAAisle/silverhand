import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDown, X } from 'lucide-react';
import type {
  AgentDto,
  AgentRunState,
  ChannelDto,
  ChannelKind,
  MessageDto,
  SessionAgentDto,
  SessionDto,
} from '@silverhand/shared';
import { Composer } from '@/components/chat/Composer';
import { MessageItem } from '@/components/chat/MessageItem';
import { AgentActivityBubble } from '@/components/chat/AgentActivityBubble';
import { QuotedMessagePreview } from '@/components/chat/QuotedMessagePreview';
import { findThreadAnchor, readAnchorMessageId } from '@/components/chat/threadAnchor';
import { SystemMessage } from '@/components/chat/SystemMessage';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { useAgents } from '@/features/agents/hooks';
import { useChannels } from '@/features/channels/hooks';
import {
  useSessionThreads,
  useStartThread,
  type ThreadSummary,
} from '@/features/thread/hooks';
import { useSavedMessageIds, useToggleSave } from '@/features/saved/hooks';
import {
  useSessionAgents,
  useSessionMessages,
  useAgentRunStates,
  useMarkMessageSessionRead,
} from '@/features/sessions/hooks';
import { useSessionStream } from '@/hooks/useSessionStream';

interface SessionDescriptor {
  id: string;
  title: string;
  parent_session_id: string | null;
  closed_at: number | null;
  channel_id: string;
}

interface SessionViewProps {
  /** Kind of the parent channel. DM and regular sessions diverge in
   *  several places (agent strip, sub-session affordances, member
   *  management). Threaded as a prop so the divergences stay local. */
  channelKind: ChannelKind | null;
  session: SessionDescriptor | null;
  parentTitle?: string | null;
  /** One-shot scroll-to target. When set and the target message is in
   *  the current session, MessageList scrolls + flashes it, then calls
   *  `onJumped` so the parent can clear the target (otherwise switching
   *  channels and back would re-trigger the scroll). */
  jumpTarget?: { sessionId: string; messageId: string } | null;
  onJumped?: () => void;
  /** Called when the user clicks Thread on a message. The parent owns
   *  child-pane state — receives the freshly-created child session id
   *  and the session DTO (if available) for optimistic rendering.
   *  When this is undefined the Thread action is hidden (child sessions
   *  can't spawn grandchildren). */
  onThreadCreated?: (childSessionId: string, session?: SessionDto) => void;
  /** When set, renders an X button in the header that calls this back.
   *  Used by the right-side child pane to close itself. */
  onCloseChild?: () => void;
  /** "View in session" handler — for thread children, jumps the parent
   *  pane to the original anchor message. Receives the original
   *  message id (which lives in the thread_anchor system message). */
  onJumpToOriginal?: (messageId: string) => void;
  /** Reports this session's thread anchor target back up so the caller
   *  can persistently highlight that message in the parent pane while
   *  this view is open. Fires with the id when known, null otherwise. */
  onThreadAnchorResolved?: (originalMessageId: string | null) => void;
  /** Persistently mark a message in this view's list with the hover
   *  frame — used by the parent pane to surface "the message a thread
   *  is anchored to". */
  highlightedMessageId?: string | null;
}

export function SessionView(props: SessionViewProps): JSX.Element {
  if (!props.session) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-bg-chat text-sm text-text-muted">
        从左侧侧栏选择一个会话
      </main>
    );
  }
  return <ActiveSessionView {...props} session={props.session} />;
}

// Split out so the React-Query hooks below only mount once a session
// exists — keeps hook order stable across the null transition.
function ActiveSessionView({
  channelKind,
  session,
  parentTitle,
  jumpTarget,
  onJumped,
  onThreadCreated,
  onCloseChild,
  onJumpToOriginal,
  onThreadAnchorResolved,
  highlightedMessageId,
}: SessionViewProps & { session: SessionDescriptor }): JSX.Element {
  const {
    data: messages = [],
    isLoading,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = useSessionMessages(session.id);

  // Advance the message read cursor in real-time as new messages arrive via
  // SSE. SessionView is only rendered when the session is visible, so any
  // SSE message that lands here should be marked read immediately — no need
  // to wait for the 5 s polling window in App.tsx.
  const markRead = useMarkMessageSessionRead();
  const onStreamEvent = useCallback(
    (e: { kind: string }) => {
      if (e.kind === 'message') markRead.mutate(session.id);
    },
    // markRead.mutate is stable; session.id drives re-subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id],
  );
  useSessionStream(session.id, onStreamEvent);
  const { data: runStates = [] } = useAgentRunStates(session.id);

  // Active = non-terminal states only (idle/failed are removed by the hook).
  // Guard defensively in case a terminal event arrives just before re-render.
  const activeRunStates = useMemo(
    () => runStates.filter(s => s.status !== 'idle' && s.status !== 'failed'),
    [runStates],
  );

  const closed = session.closed_at !== null;
  const isDm = channelKind === 'dm';

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
  // view or the Tasks panel hands us a `{sessionId, messageId}` for a
  // message inside this session. Cleared by `onJumped` once the
  // message-list scroll completes.
  const effectiveJumpMessageId =
    jumpTarget && jumpTarget.sessionId === session.id
      ? jumpTarget.messageId
      : null;

  // Open-thread summary for this session — only fetched on parent
  // panes (where Thread is actionable). Child panes can't have
  // grandchildren so the query is gated and stays disabled there.
  const isParentPane = !!onThreadCreated;
  const { data: threads = [] } = useSessionThreads(
    isParentPane ? session.id : null,
    isParentPane ? session.channel_id : null,
  );
  const threadByAnchor = useMemo(() => {
    const m = new Map<string, ThreadSummary>();
    for (const t of threads) m.set(t.anchor_message_id, t);
    return m;
  }, [threads]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-chat">
      <header className="flex h-[var(--titlebar-height)] min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        {showThreadHeader ? (
          <>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              Thread
            </span>
            <span className="text-text-muted">—</span>
            <span className="min-w-0 truncate font-serif text-sm font-semibold text-text-primary">
              #{parentTitle ?? session.title}
            </span>
            {onJumpToOriginal && anchorMessageId ? (
              <button
                type="button"
                onClick={() => onJumpToOriginal(anchorMessageId)}
                className="text-xs text-accent hover:underline"
                title="跳转到原消息"
              >
                view in session
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span className="min-w-0 truncate font-serif text-sm font-semibold text-text-primary">
              {session.title}
            </span>
            {parentTitle ? (
              <span className="min-w-0 truncate text-xs text-text-muted">↳ child of {parentTitle}</span>
            ) : null}
          </>
        )}
        {closed ? (
          <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
            closed
          </span>
        ) : null}

        {/* Right-aligned cluster: agent roster + close-child. The chips
          * sit inline so the standalone strip below the header is gone
          * — DM channels still skip them since the sole agent is in
          * the channel name. */}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {isDm ? null : (
            <AgentStrip sessionId={session.id} disabled={closed} />
          )}
          {onCloseChild ? (
            <button
              type="button"
              onClick={onCloseChild}
              aria-label="关闭子会话"
              title="关闭子会话"
              className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageList
          sessionId={session.id}
          channelId={session.channel_id}
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
          onJumped={() => onJumped?.()}
          onThreadCreated={onThreadCreated}
          threadByAnchor={threadByAnchor}
          activeRunStates={activeRunStates}
        />

        <Composer sessionId={session.id} disabled={closed} />
      </div>
    </main>
  );
}

// ── Agent strip ─────────────────────────────────────────────────────────

function AgentStrip({
  sessionId,
}: {
  sessionId: string;
  /** Reserved for future close-state UI. The retry affordance for
   *  crashed agents now lives inside the AgentInfoPopover so the
   *  stacked-avatar surface stays purely informational. */
  disabled: boolean;
}): JSX.Element {
  const { data: sa = [] } = useSessionAgents(sessionId);
  const { data: agents = [] } = useAgents();
  const agentById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  if (sa.length === 0) {
    return (
      <span className="shrink-0 text-[10px] italic text-text-muted">
        会话还没有成员
      </span>
    );
  }
  // Overlapping avatar stack — each tile hover-opens the agent info
  // popover (with per-session presence). Status is communicated via
  // a small dot at the bottom-right of each avatar so the row stays
  // readable at-a-glance without text labels.
  return (
    <div className="flex shrink-0 items-center pl-1">
      {sa.map((s, i) => {
        const agent = agentById.get(s.agent_id);
        if (!agent) return null;
        return (
          <AgentInfoPopover
            key={s.agent_id}
            agent={agent}
            sessionId={sessionId}
            trigger="hover"
            side="bottom"
            align="end"
          >
            <button
              type="button"
              aria-label={`@${agent.name}`}
              // Negative margin overlaps each subsequent avatar onto the
              // previous one. The white ring separates them visually so
              // the stack reads as discrete heads, not a smear.
              className={
                'relative rounded-full ring-2 ring-bg-primary transition-transform hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:outline-none ' +
                (i === 0 ? '' : '-ml-2')
              }
              style={{ zIndex: i }}
            >
              <AgentAvatar runtime={agent.runtime} size={22} />
              <span
                className={
                  'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-bg-primary ' +
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

const STATUS_DOT: Record<SessionAgentDto['status'], string> = {
  active: 'bg-success',
  starting: 'bg-warning',
  crashed: 'bg-error',
  idle: 'bg-text-muted/50',
};

// ── Message list ────────────────────────────────────────────────────────

function MessageList({
  sessionId,
  channelId,
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
}: {
  sessionId: string;
  channelId: string;
  messages: MessageDto[];
  isLoading: boolean;
  hasMoreBefore: boolean;
  isFetchingEarlier: boolean;
  onLoadEarlier: () => void;
  leadingSlot?: ReactNode;
  highlightedMessageId?: string | null;
  jumpToMessageId: string | null;
  onJumped?: () => void;
  onThreadCreated?: (childSessionId: string, session?: SessionDto) => void;
  /** Map of `original message id → open-thread summary` for the parent
   *  pane. Empty / absent on child panes. Drives the per-message
   *  "{count} Reply" badge and short-circuits the POST when a thread
   *  already exists (just opens it). */
  threadByAnchor?: Map<string, ThreadSummary>;
  /** In-flight agent run states — rendered as activity bubbles below the
   *  last message so the user can see which agents are still working. */
  activeRunStates?: AgentRunState[];
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  const { data: channels = [] } = useChannels();
  const savedIds = useSavedMessageIds();
  const { toggle: toggleSave } = useToggleSave();
  const startThread = useStartThread(channelId);
  // Three lookup maps used by the message renderer:
  //  - `agentsById`   → message author (avatar + display name)
  //  - `agentsByName` → inline `@handle` mention pills
  //  - `channelsByName` → inline `#name` channel ref pills
  const { agentsById, agentsByName } = useMemo(() => {
    const byId = new Map<string, AgentDto>();
    const byName = new Map<string, AgentDto>();
    for (const a of agents) {
      byId.set(a.id, a);
      byName.set(a.name, a);
    }
    return { agentsById: byId, agentsByName: byName };
  }, [agents]);
  const channelsByName = useMemo(() => {
    const m = new Map<string, ChannelDto>();
    for (const c of channels) m.set(c.name, c);
    return m;
  }, [channels]);

  const handleStartThread = (msg: MessageDto): void => {
    if (!onThreadCreated) return;
    // Already a thread on this message → just open it; no POST needed.
    const existing = threadByAnchor?.get(msg.id);
    if (existing) {
      onThreadCreated(existing.child_session_id);
      return;
    }
    if (startThread.isPending) return;
    startThread.mutate(msg.id, {
      onSuccess: res => onThreadCreated(res.child_session_id, res.session),
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
  // On session switch, MessageList may not remount (React reuses the instance).
  // Reset to `true` whenever `sessionId` changes so switching to a new session
  // always starts in "follow bottom" mode regardless of the previous session's
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

  // Reset "near bottom" whenever the session changes so every new session
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
  }, [sessionId]);

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
  }, [messages, jumpToMessageId, activeRunIds, sessionId]);

  // Jump to a specific message (typically from Saved view). Waits for
  // the message to be in the DOM, scrolls into view, briefly highlights
  // it, then signals completion so the parent clears the target.
  useEffect(() => {
    if (!jumpToMessageId) return;
    if (messages.length === 0) return; // wait for load
    const target = document.getElementById(`msg-${jumpToMessageId}`);
    if (!target) {
      // Message might have been deleted; clear the target so we don't
      // loop forever.
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
  }, [jumpToMessageId, messages, onJumped]);

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
        {leadingSlot ? <div className="mb-1">{leadingSlot}</div> : null}
        {isLoading ? (
          <div className="text-sm text-text-muted">加载消息…</div>
        ) : messages.length === 0 ? (
          leadingSlot ? null : (
            <div className="text-sm text-text-muted">还没有消息。在下方输入。</div>
          )
        ) : (
          <ol className="space-y-1">
            {messages.map(m => (
              <li key={m.id}>
                {m.from_kind === 'system' ? (
                  <SystemMessage message={m} />
                ) : (
                  <MessageItem
                    message={m}
                    sessionId={sessionId}
                    agentsById={agentsById}
                    agentsByName={agentsByName}
                    channelsByName={channelsByName}
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
            ))}
          </ol>
        )}

        {/* Activity bubbles — one per agent with an in-flight run. Rendered
          * after messages so they naturally anchor to the bottom of the list.
          * A new runId in `activeRunIds` triggers the scroll-to-bottom effect
          * above, so the bubble is visible when it first appears. Heartbeat
          * updates (same runId) do not re-trigger the scroll. */}
        {activeRunStates && activeRunStates.length > 0 ? (
          <div className="mt-1 -mx-4 border-t border-border-subtle/50 pt-1">
            {activeRunStates.map(state => (
              <AgentActivityBubble
                key={state.runId}
                state={state}
                agent={agentsById.get(state.agentId)}
              />
            ))}
          </div>
        ) : null}
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
