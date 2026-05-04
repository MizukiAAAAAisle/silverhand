import { useEffect, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { Toaster } from 'sonner';
import { NavRail } from '@/components/layout/NavRail';
import { ComputersPanel } from '@/components/layout/ComputersPanel';
import { MembersPanel } from '@/components/layout/MembersPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { SessionsSidebar } from '@/components/layout/SessionsSidebar';
import { SessionView } from '@/components/layout/SessionView';
import { SavedListView } from '@/components/layout/SavedListView';
import { SearchPanel } from '@/components/layout/SearchPanel';
import { SplitPane } from '@/components/layout/SplitPane';
import { TasksSection } from '@/components/layout/TasksSection';
import { Titlebar } from '@/components/layout/Titlebar';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useAppearance } from '@/hooks/useAppearance';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateChannelDialog } from '@/features/channels/CreateChannelDialog';
import { CreateSessionDialog } from '@/features/channels/CreateSessionDialog';
import { ChannelSettingsDialog } from '@/features/channels/ChannelSettingsDialog';
import { ChannelTasksDrawer } from '@/components/tasks/ChannelTasksDrawer';
import { useTasks } from '@/features/tasks/hooks';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AgentView } from '@/features/agents/AgentView';
import {
  useChannels,
  useSessionsForChannel,
  usePinSession,
} from '@/features/channels/hooks';
import { useSavedMessages } from '@/features/saved/hooks';
import {
  useNotificationToasts,
  useUnreadCounts,
} from '@/features/notifications/hooks';
import {
  useMarkSessionRead,
  useMarkMessageSessionRead,
  useMessageUnreadCounts,
  useMessageUnreadSummary,
} from '@/features/sessions/hooks';
import { useNav, useRouteState } from '@/router';
import type { SessionDto } from '@silverhand/shared';

export interface MessageJumpTarget {
  sessionId: string;
  messageId: string;
}

export function App(): JSX.Element {
  useAppearance();

  // Shutdown overlay — shown when the main process starts its graceful
  // quit sequence. Steps arrive via IPC; null means not shutting down.
  const [shutdownStep, setShutdownStep] = useState<string | null>(null);
  useEffect(() => {
    return window.agentHub.onShutdownProgress(step => setShutdownStep(step));
  }, []);

  // Sidebar widths persist across launches and mirror into CSS vars so
  // existing `var(--sidebar-width)` consumers (Titlebar pad, Sidebar
  // <aside>) re-flow without prop-drilling.
  const sidebar = useResizableWidth({
    storageKey: 'silverhand.layout.sidebar-width',
    defaultWidth: 240,
    min: 200,
    max: 360,
    cssVar: '--sidebar-width',
  });
  const sessionsSidebar = useResizableWidth({
    storageKey: 'silverhand.layout.sessions-sidebar-width',
    defaultWidth: 240,
    min: 200,
    max: 400,
    cssVar: '--sessions-sidebar-width',
  });

  const route = useRouteState();
  const nav = useNav();
  const {
    section: appSection,
    chatView: view,
    channelId: selectedChannelId,
    sessionId: selectedSessionId,
    childSessionId: openChildSessionId,
    agentId: selectedAgentId,
  } = route;

  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  // One-shot jump target consumed by SessionView once messages are
  // loaded for the target session. Cleared after handling. Kept in
  // memory rather than the URL because it's truly ephemeral —
  // refresh/back doesn't need to re-trigger the scroll.
  const [jumpTarget, setJumpTarget] = useState<MessageJumpTarget | null>(null);

  // Holds the newly-created child session for the brief window between
  // nav.toThread() firing and the sessions query refetch completing.
  // Without this, childSession would be null on the first render after
  // navigation and the split pane wouldn't appear until the refetch lands.
  // Keyed by childSessionId so we never leak a stale session into the
  // wrong split pane.
  const [ephemeralChildSession, setEphemeralChildSession] = useState<SessionDto | null>(null);

  // The original message id anchored by the currently-open thread. Set
  // by the child SessionView via onThreadAnchorResolved; consumed by
  // the parent SessionView to render that row with a persistent
  // highlight (the same frame as hover) so the user knows what the
  // thread is about.
  const [highlightedParentMessageId, setHighlightedParentMessageId] = useState<
    string | null
  >(null);

  // Per-channel "last viewed session" memory. Lives in-memory only —
  // resetting on app restart is fine; channel switches inside one session
  // shouldn't lose their place.
  const lastSessionByChannel = useRef<Map<string, string>>(new Map());

  const { data: channels = [] } = useChannels();
  const { data: sessions = [] } = useSessionsForChannel(selectedChannelId);
  const pinSession = usePinSession(selectedChannelId ?? null);
  // Shared cache with SavedListView and useToggleSave — invalidations
  // from save/unsave mutations propagate the count update here too.
  const { data: savedItems } = useSavedMessages();
  // Per-channel notification unread count (mention / agent-failure alerts).
  const { data: unreadCounts } = useUnreadCounts();
  // Global message unread summary across all channels — drives channel
  // sidebar badges via session_reads cursor (not notification system).
  const { data: messageUnreadSummary } = useMessageUnreadSummary();
  // Per-session message unread counts for the currently selected channel.
  // Drives session sidebar badges; replaces the old notification-based counts.
  const { data: messageUnreadData } = useMessageUnreadCounts(selectedChannelId ?? null);
  const sessionUnreadCounts = messageUnreadData?.by_session;
  // Notification-based read marker (mention/agent-failure alerts).
  const markSessionRead = useMarkSessionRead();
  // Message-unread read cursor — advances session_reads on navigation.
  const markMessageSessionRead = useMarkMessageSessionRead();
  // In-app + system notifications for new mentions and agent failures.
  useNotificationToasts(selectedChannelId ?? null);
  // Active-task count for the titlebar Tasks badge — scoped to the
  // current channel so the number matches what the panel will show
  // when opened (default filter = current session, but the badge is
  // channel-aggregate to match where the entry lives).
  const { data: channelTasks = [] } = useTasks(
    selectedChannelId ? { channel_id: selectedChannelId } : {},
    { enabled: !!selectedChannelId },
  );
  const channelActiveTaskCount = channelTasks.filter(
    t => t.status !== 'done',
  ).length;

  // Auto-select first channel when chat is open without a channel id.
  // Replace so the bare /chat URL doesn't pile up in history.
  useEffect(() => {
    if (appSection !== 'chat' || view !== 'channel') return;
    if (selectedChannelId) return;
    if (channels.length === 0) return;
    nav.go(`/chat/c/${channels[0]!.id}`, { replace: true });
  }, [appSection, view, selectedChannelId, channels, nav]);

  // If the URL's channelId no longer exists (deleted in another window,
  // bad bookmark), bounce to /chat so the auto-pick effect can take over.
  useEffect(() => {
    if (!selectedChannelId || channels.length === 0) return;
    if (!channels.some(c => c.id === selectedChannelId)) {
      nav.go('/chat', { replace: true });
    }
  }, [selectedChannelId, channels, nav]);

  // When switching channels (or when sessions arrive for the current
  // channel), restore the last-viewed session, fall back to the first one.
  // Wait for `sessions` to populate so we don't race the empty placeholder.
  useEffect(() => {
    if (!selectedChannelId) return;
    if (selectedSessionId) return;
    if (sessions.length === 0) return;
    // If a jump asked for a specific session, honor it instead of the
    // remembered/default — Saved → jump shouldn't snap back.
    if (jumpTarget && sessions.some(s => s.id === jumpTarget.sessionId)) {
      nav.go(`/chat/c/${selectedChannelId}/s/${jumpTarget.sessionId}`, {
        replace: true,
      });
      return;
    }
    const remembered = lastSessionByChannel.current.get(selectedChannelId);
    const stillExists = remembered && sessions.some(s => s.id === remembered);
    const target = stillExists ? remembered! : sessions[0]!.id;
    nav.go(`/chat/c/${selectedChannelId}/s/${target}`, { replace: true });
  }, [selectedChannelId, selectedSessionId, sessions, jumpTarget, nav]);

  // Record the user's selection so we can restore it next time they
  // come back to this channel.
  useEffect(() => {
    if (selectedChannelId && selectedSessionId) {
      lastSessionByChannel.current.set(selectedChannelId, selectedSessionId);
    }
  }, [selectedChannelId, selectedSessionId]);

  // If the open child is loaded and its parent doesn't match the current
  // selection, drop it. Don't drop on "missing from list" — that fires
  // during the brief window after Thread when the sessions query is
  // refetching and the freshly-created child isn't in cache yet,
  // killing the split view before it ever appears.
  useEffect(() => {
    if (!openChildSessionId || !selectedChannelId || !selectedSessionId) return;
    const child = sessions.find(s => s.id === openChildSessionId);
    if (child && child.parent_session_id !== selectedSessionId) {
      nav.go(`/chat/c/${selectedChannelId}/s/${selectedSessionId}`, {
        replace: true,
      });
    }
  }, [
    openChildSessionId,
    sessions,
    selectedSessionId,
    selectedChannelId,
    nav,
  ]);

  // Clear the parent-message highlight whenever the thread pane closes
  // — the highlight only makes sense alongside an open child.
  useEffect(() => {
    if (!openChildSessionId) setHighlightedParentMessageId(null);
  }, [openChildSessionId]);

  const selectedChannel = channels.find(c => c.id === selectedChannelId) ?? null;
  const selectedSession = sessions.find(s => s.id === selectedSessionId) ?? null;
  const parentSession = selectedSession?.parent_session_id
    ? sessions.find(s => s.id === selectedSession.parent_session_id) ?? null
    : null;
  const childSession =
    (openChildSessionId
      ? sessions.find(s => s.id === openChildSessionId) ?? null
      : null) ??
    // Ephemeral fallback: the session was just created and isn't in the
    // sessions cache yet. Used until the invalidateQueries refetch lands.
    (ephemeralChildSession?.id === openChildSessionId ? ephemeralChildSession : null);

  // Clear ephemeral once the real sessions list includes this child,
  // or when the URL no longer points at this child.
  useEffect(() => {
    if (!ephemeralChildSession) return;
    if (ephemeralChildSession.id !== openChildSessionId) {
      setEphemeralChildSession(null);
      return;
    }
    if (sessions.some(s => s.id === ephemeralChildSession.id)) {
      setEphemeralChildSession(null);
    }
  }, [ephemeralChildSession, openChildSessionId, sessions]);

  const activeEventSessionId = openChildSessionId ?? selectedSessionId;

  useEffect(() => {
    void window.agentHub.setActiveSession({
      channelId:
        appSection === 'chat' && view === 'channel' ? selectedChannelId : null,
      sessionId:
        appSection === 'chat' && view === 'channel'
          ? activeEventSessionId
          : null,
    });
  }, [appSection, view, selectedChannelId, activeEventSessionId]);

  // Auto-advance the message read cursor whenever the user is looking at a
  // session. In split-view both parent (selectedSessionId) and child
  // (openChildSessionId) are visible simultaneously, so both cursors must be
  // advanced — not just the "active event" session.
  useEffect(() => {
    if (selectedSessionId) markMessageSessionRead.mutate(selectedSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);
  useEffect(() => {
    if (openChildSessionId) markMessageSessionRead.mutate(openChildSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChildSessionId]);

  // Keep notification badges (mention_external / agent_start_failed) cleared
  // for whichever session the user is actively viewing.
  useEffect(() => {
    if (!activeEventSessionId) return;
    markSessionRead.mutate(activeEventSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEventSessionId]);

  const handleSelectChannel = (id: string): void => {
    // If the channel has unread mentions, jump straight to the latest
    // one (typically the Mentions session in a DM) — that's what the
    // user clicked the badge to see. Falls back to the
    // remembered/default session pick when there's no pointer.
    const pointer = unreadCounts?.latest_by_channel?.[id];
    if (pointer) {
      handleJumpToMessage({
        channelId: id,
        sessionId: pointer.session_id,
        messageId: pointer.message_id,
      });
      return;
    }
    nav.toChannel(id);
  };

  const handleSelectSession = (id: string): void => {
    const target = sessions.find(s => s.id === id);
    if (!selectedChannelId) return;
    // Clear both notification badge and message unread cursor on navigation.
    markSessionRead.mutate(id);
    markMessageSessionRead.mutate(id);
    if (target?.parent_session_id) {
      // Picking a child from the sidebar tree opens it as the child pane
      // alongside its parent — not as a top-level selection.
      nav.toThread(selectedChannelId, target.parent_session_id, id);
    } else {
      nav.toSession(selectedChannelId, id);
    }
  };

  const handleJumpToMessage = (
    params: {
      channelId: string;
      sessionId: string;
      messageId: string;
    },
    options: { preserveThreadLayout?: boolean } = {},
  ): void => {
    setJumpTarget({ sessionId: params.sessionId, messageId: params.messageId });
    markSessionRead.mutate(params.sessionId);
    if (
      options.preserveThreadLayout &&
      selectedChannelId === params.channelId &&
      selectedSessionId === params.sessionId &&
      openChildSessionId
    ) {
      return;
    }
    nav.toSession(params.channelId, params.sessionId);
  };

  const handleChannelDeleted = (): void => {
    // Pick the next channel in the same kind-group as the deleted one,
    // wrapping to the first when the deleted entry was last. Falls back
    // across groups if the kind-group is now empty, then to /chat when
    // nothing remains. Computed from the pre-invalidate snapshot — the
    // channels query refetch hasn't landed yet at this point.
    const deletedId = selectedChannelId;
    const deleted = channels.find(c => c.id === deletedId);
    const sameKind = deleted
      ? channels.filter(c => c.kind === deleted.kind)
      : [];
    const idxInGroup = deleted
      ? sameKind.findIndex(c => c.id === deletedId)
      : -1;
    const nextInGroup =
      sameKind.length > 1 && idxInGroup >= 0
        ? sameKind[(idxInGroup + 1) % sameKind.length]
        : null;
    const nextOverall =
      nextInGroup ??
      channels.find(c => c.id !== deletedId) ??
      null;
    if (nextOverall) {
      nav.toChannel(nextOverall.id);
    } else {
      nav.toChat();
    }
  };

  const buildSessionDescriptor = (s: typeof selectedSession) =>
    s
      ? {
          id: s.id,
          title: s.title,
          parent_session_id: s.parent_session_id,
          closed_at: s.closed_at,
          channel_id: s.channel_id,
        }
      : null;

  const closeChild = (): void => {
    if (selectedChannelId && selectedSessionId) {
      nav.toSession(selectedChannelId, selectedSessionId);
    }
  };

  const parentView = (
    <SessionView
      channelKind={selectedChannel?.kind ?? null}
      session={buildSessionDescriptor(selectedSession)}
      parentTitle={parentSession?.title ?? null}
      jumpTarget={
        jumpTarget && jumpTarget.sessionId === selectedSessionId
          ? jumpTarget
          : null
      }
      onJumped={() => setJumpTarget(null)}
      onThreadCreated={(childId, session) => {
        if (selectedChannelId && selectedSessionId) {
          // Optimistically store the session so childSession is non-null
          // on the very first render after nav.toThread() fires, before
          // the sessions-list query refetch has a chance to complete.
          if (session) setEphemeralChildSession(session);
          nav.toThread(selectedChannelId, selectedSessionId, childId);
        }
      }}
      highlightedMessageId={
        openChildSessionId ? highlightedParentMessageId : null
      }
    />
  );

  const childView = childSession ? (
    <SessionView
      channelKind={selectedChannel?.kind ?? null}
      session={buildSessionDescriptor(childSession)}
      parentTitle={selectedSession?.title ?? null}
      onCloseChild={closeChild}
      onJumpToOriginal={messageId => {
        handleJumpToMessage(
          {
            channelId: childSession.channel_id,
            sessionId: childSession.parent_session_id!,
            messageId,
          },
          { preserveThreadLayout: true },
        );
      }}
      onThreadAnchorResolved={setHighlightedParentMessageId}
      // No nested Thread: child sessions can't spawn grandchildren
      // (1-layer hard limit, schema-enforced too).
      onThreadCreated={undefined}
    />
  ) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Titlebar
        channelId={selectedChannel?.id ?? null}
        channelName={selectedChannel?.name ?? null}
        channelKind={selectedChannel?.kind ?? null}
        workspacePath={selectedChannel?.workspace_path ?? null}
        channelArchivedAt={selectedChannel?.archived_at ?? null}
        onOpenChannelSettings={
          selectedChannel ? () => setChannelSettingsOpen(true) : undefined
        }
        onCreateSession={
          appSection === 'chat' && view === 'channel' && selectedChannel
            ? () => setCreateSessionOpen(true)
            : undefined
        }
        onOpenTasks={
          appSection === 'chat' && view === 'channel' && selectedChannel
            ? () => setTasksDrawerOpen(true)
            : undefined
        }
        taskCount={channelActiveTaskCount}
      />
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <NavRail
          current={appSection}
          onChange={section => {
            if (section === 'chat') nav.toChat();
            else if (section === 'tasks') nav.toTasks();
            else if (section === 'members') nav.toMembers();
            else if (section === 'settings') nav.toSettings();
            else nav.toComputers();
          }}
        />
        {appSection === 'settings' ? (
          <SettingsPage />
        ) : appSection === 'tasks' ? (
          <TasksSection onJump={handleJumpToMessage} />
        ) : appSection === 'members' ? (
          <>
            <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]">
              <nav className="flex-1 overflow-y-auto py-1.5">
                <MembersPanel
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={id => nav.toMembers(id)}
                />
              </nav>
            </aside>
            {selectedAgentId ? (
              <AgentView
                key={selectedAgentId}
                agentId={selectedAgentId}
                onDeleted={() => nav.toMembers()}
                onOpenSession={s => {
                  // Jump back to chat view, focus the agent's session.
                  nav.toSession(s.channel_id, s.session_id);
                }}
              />
            ) : (
              <main className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted">
                选一个 agent 看详情
              </main>
            )}
          </>
        ) : appSection === 'computers' ? (
          <>
            <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]">
              <nav className="flex-1 overflow-y-auto py-1.5">
                <ComputersPanel />
              </nav>
            </aside>
            <main className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted">
              选一台 computer 看详情
            </main>
          </>
        ) : (
          <>
            <Sidebar
              channels={channels.map(c => ({
                id: c.id,
                name: c.name,
                kind: c.kind,
                dm_agent_id: c.dm_agent_id,
                unread: messageUnreadSummary?.by_channel?.[c.id] ?? 0,
                archived: c.archived_at !== null,
              }))}
              selectedChannelId={selectedChannelId}
              onSelectChannel={handleSelectChannel}
              onCreateChannel={() => setCreateChannelOpen(true)}
              savedActive={view === 'saved'}
              onSelectSaved={() => nav.toChatSaved()}
              searchActive={view === 'search'}
              onSelectSearch={() => nav.toChatSearch()}
              savedCount={savedItems?.length}
            />
            <VerticalSplitter
              onPointerDown={sidebar.startResize}
              active={sidebar.isDragging}
            />
            {view === 'saved' ? (
              <SavedListView onJump={handleJumpToMessage} />
            ) : view === 'search' ? (
              <SearchPanel
                channels={channels}
                onJumpMessage={handleJumpToMessage}
                onOpenChannel={id => nav.toChannel(id)}
                onOpenSession={(channelId, sessionId) =>
                  nav.toSession(channelId, sessionId)
                }
              />
            ) : (
              <>
                <SessionsSidebar
                  channelName={selectedChannel?.name ?? null}
                  sessions={sessions.map(s => ({
                    id: s.id,
                    title: s.title,
                    status:
                      s.status === 'active' || s.status === 'crashed' ? s.status : 'idle',
                    parent_session_id: s.parent_session_id,
                    closed_at: s.closed_at,
                    pinned_at: s.pinned_at,
                  }))}
                  // Highlight either the parent (top-level) or — when a child
                  // pane is open — also the child below it via tree indent.
                  // SessionsSidebar already renders the tree; selection just
                  // points at "what's the active row".
                  selectedSessionId={openChildSessionId ?? selectedSessionId}
                  onSelectSession={handleSelectSession}
                  onPinSession={(sessionId, pinned) =>
                    pinSession.mutate({ sessionId, pinned })
                  }
                  unreadBySession={sessionUnreadCounts ?? {}}
                />
                <VerticalSplitter
                  onPointerDown={sessionsSidebar.startResize}
                  active={sessionsSidebar.isDragging}
                />
                {childView ? (
                  <SplitPane
                    left={parentView}
                    right={childView}
                    storageKey="silverhand.layout.split-ratio"
                  />
                ) : (
                  parentView
                )}
              </>
            )}
          </>
        )}
      </div>

      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
        onCreated={({ channelId, sessionId }) =>
          nav.toSession(channelId, sessionId)
        }
      />
      <CreateSessionDialog
        open={createSessionOpen}
        onOpenChange={setCreateSessionOpen}
        channelId={selectedChannelId}
        channelKind={selectedChannel?.kind ?? null}
        dmAgentId={selectedChannel?.dm_agent_id ?? null}
        onCreated={id => {
          if (selectedChannelId) nav.toSession(selectedChannelId, id);
        }}
      />
      <ChannelSettingsDialog
        open={channelSettingsOpen}
        onOpenChange={setChannelSettingsOpen}
        channelId={selectedChannel?.id ?? null}
        channelName={selectedChannel?.name ?? null}
        channelKind={selectedChannel?.kind ?? null}
        workspacePath={selectedChannel?.workspace_path ?? null}
        archivedAt={selectedChannel?.archived_at ?? null}
        onDeleted={handleChannelDeleted}
      />
      {selectedChannel ? (
        <ChannelTasksDrawer
          open={tasksDrawerOpen}
          onOpenChange={setTasksDrawerOpen}
          channelId={selectedChannel.id}
          channelName={selectedChannel.name}
          sessions={sessions.map(s => ({
            id: s.id,
            title: s.title,
            closed_at: s.closed_at,
            created_at: s.created_at,
          }))}
          defaultSessionId={selectedSessionId}
          onJumpToMessage={handleJumpToMessage}
        />
      ) : null}
      <Toaster position="bottom-right" richColors />

      {/* Shutdown progress overlay — shown during graceful quit so the
        * user sees activity instead of a frozen window. Rendered above
        * everything and not dismissible — the app is closing. */}
      {shutdownStep !== null ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-bg-base/30 backdrop-blur-[1px]">
          <div className="w-[420px] max-w-[calc(100vw-48px)] rounded-md border border-border bg-bg-floating/95 px-5 py-4 shadow-modal">
            <div className="flex items-center gap-4">
              <div className="relative flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <span
                  aria-hidden
                  className="absolute -inset-1 rounded-full border-2 border-accent/25 border-t-accent animate-spin"
                />
                <Power className="size-5" strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text-primary">
                  正在安全退出
                </p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  {shutdownStep}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
