import { useEffect, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { Toaster } from 'sonner';
import { NavRail } from '@/components/layout/NavRail';
import { ComputersPanel } from '@/components/layout/ComputersPanel';
import { MembersPanel } from '@/components/layout/MembersPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChannelsSidebar } from '@/components/layout/ChannelsSidebar';
import { ChannelView } from '@/components/layout/ChannelView';
import { SavedListView } from '@/components/layout/SavedListView';
import { SearchPanel } from '@/components/layout/SearchPanel';
import { SplitPane } from '@/components/layout/SplitPane';
import { TasksSection } from '@/components/layout/TasksSection';
import { Titlebar } from '@/components/layout/Titlebar';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useAppearance } from '@/hooks/useAppearance';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
import { CreateChannelDialog } from '@/features/workspaces/CreateChannelDialog';
import { WorkspaceSettingsDialog } from '@/features/workspaces/WorkspaceSettingsDialog';
import { ChannelTasksDrawer } from '@/components/tasks/ChannelTasksDrawer';
import { useTasks } from '@/features/tasks/hooks';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AgentView } from '@/features/agents/AgentView';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  usePinChannel,
} from '@/features/workspaces/hooks';
import { useSavedMessages } from '@/features/saved/hooks';
import {
  useNotificationToasts,
  useUnreadCounts,
} from '@/features/notifications/hooks';
import {
  useMarkChannelRead,
  useMarkMessageChannelRead,
  useMessageUnreadCounts,
  useMessageUnreadSummary,
} from '@/features/channels/hooks';
import { useNav, useRouteState } from '@/router';
import type { SessionDto } from '@silverhand/shared';

export interface MessageJumpTarget {
  channelId: string;
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
  const channelsSidebar = useResizableWidth({
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
    workspaceId: selectedWorkspaceId,
    channelId: selectedChannelId,
    threadId: openThreadId,
    agentId: selectedAgentId,
  } = route;

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  // One-shot jump target consumed by ChannelView once messages are
  // loaded for the target channel. Cleared after handling. Kept in
  // memory rather than the URL because it's truly ephemeral —
  // refresh/back doesn't need to re-trigger the scroll.
  const [jumpTarget, setJumpTarget] = useState<MessageJumpTarget | null>(null);

  // Holds the newly-created thread for the brief window between
  // nav.toThread() firing and the channels query refetch completing.
  // Without this, thread would be null on the first render after
  // navigation and the split pane wouldn't appear until the refetch lands.
  // Keyed by threadId so we never leak a stale channel into the
  // wrong split pane.
  const [ephemeralThread, setEphemeralThread] = useState<SessionDto | null>(null);

  // The original message id anchored by the currently-open thread. Set
  // by the child ChannelView via onThreadAnchorResolved; consumed by
  // the parent ChannelView to render that row with a persistent
  // highlight (the same frame as hover) so the user knows what the
  // thread is about.
  const [highlightedParentMessageId, setHighlightedParentMessageId] = useState<
    string | null
  >(null);

  // Per-workspace "last viewed channel" memory. Lives in-memory only —
  // resetting on app restart is fine; workspace switches inside one session
  // shouldn't lose their place.
  const lastChannelByWorkspace = useRef<Map<string, string>>(new Map());

  const { data: workspaces = [] } = useWorkspaces();
  const { data: channels = [] } = useChannelsForWorkspace(selectedWorkspaceId);
  const pinChannel = usePinChannel(selectedWorkspaceId ?? null);
  // Shared cache with SavedListView and useToggleSave — invalidations
  // from save/unsave mutations propagate the count update here too.
  const { data: savedItems } = useSavedMessages();
  // Per-workspace notification unread count (mention / agent-failure alerts).
  const { data: unreadCounts } = useUnreadCounts();
  // Global message unread summary across all workspaces — drives workspace
  // sidebar badges via session_reads cursor (not notification system).
  const { data: messageUnreadSummary } = useMessageUnreadSummary();
  // Per-channel message unread counts for the currently selected workspace.
  // Drives channel sidebar badges; replaces the old notification-based counts.
  const { data: messageUnreadData } = useMessageUnreadCounts(selectedWorkspaceId ?? null);
  const channelUnreadCounts = messageUnreadData?.by_session;
  // Notification-based read marker (mention/agent-failure alerts).
  const markChannelRead = useMarkChannelRead();
  // Message-unread read cursor — advances session_reads on navigation.
  const markMessageChannelRead = useMarkMessageChannelRead();
  // In-app + system notifications for new mentions and agent failures.
  useNotificationToasts(selectedWorkspaceId ?? null);
  // Active-task count for the titlebar Tasks badge — scoped to the
  // current workspace so the number matches what the panel will show
  // when opened (default filter = current channel, but the badge is
  // workspace-aggregate to match where the entry lives).
  const { data: workspaceTasks = [] } = useTasks(
    selectedWorkspaceId ? { channel_id: selectedWorkspaceId } : {},
    { enabled: !!selectedWorkspaceId },
  );
  const workspaceActiveTaskCount = workspaceTasks.filter(
    t => t.status !== 'done',
  ).length;

  // Auto-select first workspace when chat is open without a workspace id.
  // Replace so the bare /chat URL doesn't pile up in history.
  useEffect(() => {
    if (appSection !== 'chat' || view !== 'channel') return;
    if (selectedWorkspaceId) return;
    if (workspaces.length === 0) return;
    nav.go(`/chat/w/${workspaces[0]!.id}`, { replace: true });
  }, [appSection, view, selectedWorkspaceId, workspaces, nav]);

  // If the URL's workspaceId no longer exists (deleted in another window,
  // bad bookmark), bounce to /chat so the auto-pick effect can take over.
  useEffect(() => {
    if (!selectedWorkspaceId || workspaces.length === 0) return;
    if (!workspaces.some(w => w.id === selectedWorkspaceId)) {
      nav.go('/chat', { replace: true });
    }
  }, [selectedWorkspaceId, workspaces, nav]);

  // When switching workspaces (or when channels arrive for the current
  // workspace), restore the last-viewed channel, fall back to the first one.
  // Wait for `channels` to populate so we don't race the empty placeholder.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (selectedChannelId) return;
    if (channels.length === 0) return;
    // If a jump asked for a specific channel, honor it instead of the
    // remembered/default — Saved → jump shouldn't snap back.
    if (jumpTarget && channels.some(s => s.id === jumpTarget.channelId)) {
      nav.go(`/chat/w/${selectedWorkspaceId}/c/${jumpTarget.channelId}`, {
        replace: true,
      });
      return;
    }
    const remembered = lastChannelByWorkspace.current.get(selectedWorkspaceId);
    const stillExists = remembered && channels.some(s => s.id === remembered);
    const target = stillExists ? remembered! : channels[0]!.id;
    nav.go(`/chat/w/${selectedWorkspaceId}/c/${target}`, { replace: true });
  }, [selectedWorkspaceId, selectedChannelId, channels, jumpTarget, nav]);

  // Record the user's selection so we can restore it next time they
  // come back to this workspace.
  useEffect(() => {
    if (selectedWorkspaceId && selectedChannelId) {
      lastChannelByWorkspace.current.set(selectedWorkspaceId, selectedChannelId);
    }
  }, [selectedWorkspaceId, selectedChannelId]);

  // If the open thread is loaded and its parent doesn't match the current
  // selection, drop it. Don't drop on "missing from list" — that fires
  // during the brief window after Thread when the channels query is
  // refetching and the freshly-created thread isn't in cache yet,
  // killing the split view before it ever appears.
  useEffect(() => {
    if (!openThreadId || !selectedWorkspaceId || !selectedChannelId) return;
    const thread = channels.find(s => s.id === openThreadId);
    if (thread && thread.parent_session_id !== selectedChannelId) {
      nav.go(`/chat/w/${selectedWorkspaceId}/c/${selectedChannelId}`, {
        replace: true,
      });
    }
  }, [
    openThreadId,
    channels,
    selectedChannelId,
    selectedWorkspaceId,
    nav,
  ]);

  // Clear the parent-message highlight whenever the thread pane closes
  // — the highlight only makes sense alongside an open thread.
  useEffect(() => {
    if (!openThreadId) setHighlightedParentMessageId(null);
  }, [openThreadId]);

  const selectedWorkspace = workspaces.find(w => w.id === selectedWorkspaceId) ?? null;
  const selectedChannel = channels.find(s => s.id === selectedChannelId) ?? null;
  const parentChannel = selectedChannel?.parent_session_id
    ? channels.find(s => s.id === selectedChannel.parent_session_id) ?? null
    : null;
  const threadChannel =
    (openThreadId
      ? channels.find(s => s.id === openThreadId) ?? null
      : null) ??
    // Ephemeral fallback: the channel was just created and isn't in the
    // channels cache yet. Used until the invalidateQueries refetch lands.
    (ephemeralThread?.id === openThreadId ? ephemeralThread : null);

  // Clear ephemeral once the real channels list includes this thread,
  // or when the URL no longer points at this thread.
  useEffect(() => {
    if (!ephemeralThread) return;
    if (ephemeralThread.id !== openThreadId) {
      setEphemeralThread(null);
      return;
    }
    if (channels.some(s => s.id === ephemeralThread.id)) {
      setEphemeralThread(null);
    }
  }, [ephemeralThread, openThreadId, channels]);

  const activeEventChannelId = openThreadId ?? selectedChannelId;

  useEffect(() => {
    void window.agentHub.setActiveSession({
      channelId:
        appSection === 'chat' && view === 'channel' ? selectedWorkspaceId : null,
      sessionId:
        appSection === 'chat' && view === 'channel'
          ? activeEventChannelId
          : null,
    });
  }, [appSection, view, selectedWorkspaceId, activeEventChannelId]);

  // Auto-advance the message read cursor whenever the user is looking at a
  // channel. In split-view both parent (selectedChannelId) and thread
  // (openThreadId) are visible simultaneously, so both cursors must be
  // advanced — not just the "active event" channel.
  useEffect(() => {
    if (selectedChannelId) markMessageChannelRead.mutate(selectedChannelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId]);
  useEffect(() => {
    if (openThreadId) markMessageChannelRead.mutate(openThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId]);

  // Keep notification badges (mention_external / agent_start_failed) cleared
  // for whichever channel the user is actively viewing.
  useEffect(() => {
    if (!activeEventChannelId) return;
    markChannelRead.mutate(activeEventChannelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEventChannelId]);

  const handleSelectWorkspace = (id: string): void => {
    // If the workspace has unread mentions, jump straight to the latest
    // one (typically the Mentions channel in a DM) — that's what the
    // user clicked the badge to see. Falls back to the
    // remembered/default channel pick when there's no pointer.
    const pointer = unreadCounts?.latest_by_channel?.[id];
    if (pointer) {
      handleJumpToMessage({
        channelId: pointer.session_id,
        messageId: pointer.message_id,
        workspaceId: id,
      });
      return;
    }
    nav.toWorkspace(id);
  };

  const handleSelectChannel = (id: string): void => {
    const target = channels.find(s => s.id === id);
    if (!selectedWorkspaceId) return;
    // Clear both notification badge and message unread cursor on navigation.
    markChannelRead.mutate(id);
    markMessageChannelRead.mutate(id);
    if (target?.parent_session_id) {
      // Picking a thread from the sidebar tree opens it as the thread pane
      // alongside its parent — not as a top-level selection.
      nav.toThread(selectedWorkspaceId, target.parent_session_id, id);
    } else {
      nav.toChannel(selectedWorkspaceId, id);
    }
  };

  const handleJumpToMessage = (
    params: {
      workspaceId?: string;
      channelId: string;
      messageId: string;
    },
    options: { preserveThreadLayout?: boolean } = {},
  ): void => {
    setJumpTarget({ channelId: params.channelId, messageId: params.messageId });
    markChannelRead.mutate(params.channelId);
    const wid = params.workspaceId ?? selectedWorkspaceId;
    if (!wid) return;
    if (
      options.preserveThreadLayout &&
      selectedWorkspaceId === wid &&
      selectedChannelId === params.channelId &&
      openThreadId
    ) {
      return;
    }
    nav.toChannel(wid, params.channelId);
  };

  const handleWorkspaceDeleted = (): void => {
    // Pick the next workspace in the same kind-group as the deleted one,
    // wrapping to the first when the deleted entry was last. Falls back
    // across groups if the kind-group is now empty, then to /chat when
    // nothing remains. Computed from the pre-invalidate snapshot — the
    // workspaces query refetch hasn't landed yet at this point.
    const deletedId = selectedWorkspaceId;
    const deleted = workspaces.find(w => w.id === deletedId);
    const sameKind = deleted
      ? workspaces.filter(w => w.kind === deleted.kind)
      : [];
    const idxInGroup = deleted
      ? sameKind.findIndex(w => w.id === deletedId)
      : -1;
    const nextInGroup =
      sameKind.length > 1 && idxInGroup >= 0
        ? sameKind[(idxInGroup + 1) % sameKind.length]
        : null;
    const nextOverall =
      nextInGroup ??
      workspaces.find(w => w.id !== deletedId) ??
      null;
    if (nextOverall) {
      nav.toWorkspace(nextOverall.id);
    } else {
      nav.toChat();
    }
  };

  const buildChannelDescriptor = (s: typeof selectedChannel) =>
    s
      ? {
          id: s.id,
          title: s.title,
          parent_session_id: s.parent_session_id,
          closed_at: s.closed_at,
          channel_id: s.channel_id,
        }
      : null;

  const closeThread = (): void => {
    if (selectedWorkspaceId && selectedChannelId) {
      nav.toChannel(selectedWorkspaceId, selectedChannelId);
    }
  };

  const parentView = (
    <ChannelView
      channelKind={selectedWorkspace?.kind === 'dm' ? 'dm' : (selectedWorkspace ? 'regular' : null)}
      session={buildChannelDescriptor(selectedChannel)}
      parentTitle={parentChannel?.title ?? null}
      jumpTarget={
        jumpTarget && jumpTarget.channelId === selectedChannelId
          ? { sessionId: jumpTarget.channelId, messageId: jumpTarget.messageId }
          : null
      }
      onJumped={() => setJumpTarget(null)}
      onThreadCreated={(threadId, session) => {
        if (selectedWorkspaceId && selectedChannelId) {
          // Optimistically store the session so threadChannel is non-null
          // on the very first render after nav.toThread() fires, before
          // the channels-list query refetch has a chance to complete.
          if (session) setEphemeralThread(session);
          nav.toThread(selectedWorkspaceId, selectedChannelId, threadId);
        }
      }}
      highlightedMessageId={
        openThreadId ? highlightedParentMessageId : null
      }
    />
  );

  const threadView = threadChannel ? (
    <ChannelView
      channelKind={selectedWorkspace?.kind === 'dm' ? 'dm' : (selectedWorkspace ? 'regular' : null)}
      session={buildChannelDescriptor(threadChannel)}
      parentTitle={selectedChannel?.title ?? null}
      onCloseChild={closeThread}
      onJumpToOriginal={messageId => {
        handleJumpToMessage(
          {
            channelId: threadChannel.channel_id,
            messageId,
          },
          { preserveThreadLayout: true },
        );
      }}
      onThreadAnchorResolved={setHighlightedParentMessageId}
      // No nested Thread: thread channels can't spawn sub-threads
      // (1-layer hard limit, schema-enforced too).
      onThreadCreated={undefined}
    />
  ) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Titlebar
        channelId={selectedWorkspace?.id ?? null}
        channelName={selectedWorkspace?.name ?? null}
        channelKind={selectedWorkspace?.kind === 'dm' ? 'dm' : (selectedWorkspace ? 'regular' : null)}
        workspacePath={selectedWorkspace?.workspace_path ?? null}
        channelArchivedAt={selectedWorkspace?.archived_at ?? null}
        onOpenChannelSettings={
          selectedWorkspace ? () => setWorkspaceSettingsOpen(true) : undefined
        }
        onCreateSession={
          appSection === 'chat' && view === 'channel' && selectedWorkspace
            ? () => setCreateChannelOpen(true)
            : undefined
        }
        onOpenTasks={
          appSection === 'chat' && view === 'channel' && selectedWorkspace
            ? () => setTasksDrawerOpen(true)
            : undefined
        }
        taskCount={workspaceActiveTaskCount}
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
          <TasksSection onJump={params => handleJumpToMessage(params)} />
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
                  nav.toChannel(s.channel_id, s.session_id);
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
              workspaces={workspaces.map(w => ({
                id: w.id,
                name: w.name,
                kind: w.kind === 'dm' ? 'dm' as const : 'regular' as const,
                dm_agent_id: null,
                unread: messageUnreadSummary?.by_channel?.[w.id] ?? 0,
                archived: w.archived_at !== null,
              }))}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
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
              <SavedListView onJump={params => handleJumpToMessage(params)} />
            ) : view === 'search' ? (
              <SearchPanel
                channels={workspaces.map(w => ({
                  id: w.id,
                  name: w.name,
                  kind: w.kind === 'dm' ? 'dm' as const : 'regular' as const,
                  dm_agent_id: null,
                  workspace_path: w.workspace_path,
                  workspace_host_id: w.workspace_host_id,
                  archived_at: w.archived_at,
                  created_at: w.created_at,
                  updated_at: w.updated_at,
                  description: w.description,
                }))}
                onJumpMessage={params => handleJumpToMessage(params)}
                onOpenChannel={id => nav.toWorkspace(id)}
                onOpenSession={(workspaceId, channelId) =>
                  nav.toChannel(workspaceId, channelId)
                }
              />
            ) : (
              <>
                <ChannelsSidebar
                  workspaceName={selectedWorkspace?.name ?? null}
                  channels={channels.map(s => ({
                    id: s.id,
                    title: s.title,
                    status:
                      s.status === 'active' || s.status === 'crashed' ? s.status : 'idle',
                    parent_session_id: s.parent_session_id,
                    closed_at: s.closed_at,
                    pinned_at: s.pinned_at,
                  }))}
                  // Highlight either the parent (top-level) or — when a thread
                  // pane is open — also the thread below it via tree indent.
                  // ChannelsSidebar already renders the tree; selection just
                  // points at "what's the active row".
                  selectedChannelId={openThreadId ?? selectedChannelId}
                  onSelectChannel={handleSelectChannel}
                  onPinChannel={(channelId, pinned) =>
                    pinChannel.mutate({ sessionId: channelId, pinned })
                  }
                  unreadByChannel={channelUnreadCounts ?? {}}
                />
                <VerticalSplitter
                  onPointerDown={channelsSidebar.startResize}
                  active={channelsSidebar.isDragging}
                />
                {threadView ? (
                  <SplitPane
                    left={parentView}
                    right={threadView}
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

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={({ workspaceId, channelId }) =>
          nav.toChannel(workspaceId, channelId)
        }
      />
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
        workspaceId={selectedWorkspaceId}
        workspaceKind={selectedWorkspace?.kind ?? null}
        onCreated={id => {
          if (selectedWorkspaceId) nav.toChannel(selectedWorkspaceId, id);
        }}
      />
      <WorkspaceSettingsDialog
        open={workspaceSettingsOpen}
        onOpenChange={setWorkspaceSettingsOpen}
        workspaceId={selectedWorkspace?.id ?? null}
        workspaceName={selectedWorkspace?.name ?? null}
        workspaceKind={selectedWorkspace?.kind ?? null}
        workspacePath={selectedWorkspace?.workspace_path ?? null}
        archivedAt={selectedWorkspace?.archived_at ?? null}
        onDeleted={handleWorkspaceDeleted}
      />
      {selectedWorkspace ? (
        <ChannelTasksDrawer
          open={tasksDrawerOpen}
          onOpenChange={setTasksDrawerOpen}
          channelId={selectedWorkspace.id}
          channelName={selectedWorkspace.name}
          sessions={channels.map(s => ({
            id: s.id,
            title: s.title,
            closed_at: s.closed_at,
            created_at: s.created_at,
          }))}
          defaultSessionId={selectedChannelId}
          onJumpToMessage={params => handleJumpToMessage(params)}
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
