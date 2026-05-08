import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { ArchivedChannelsPanel } from '@/components/layout/ArchivedChannelsPanel';
import { SplitPane } from '@/components/layout/SplitPane';
import { TasksSection } from '@/components/layout/TasksSection';
import { Titlebar } from '@/components/layout/Titlebar';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useAppearance } from '@/hooks/useAppearance';
import { useLayoutSettings } from '@/hooks/useLayoutSettings';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
import { CreateChannelDialog } from '@/features/workspaces/CreateChannelDialog';
import { WorkspaceSettingsDialog } from '@/features/workspaces/WorkspaceSettingsDialog';
import { WorkspaceTasksDrawer } from '@/components/tasks/WorkspaceTasksDrawer';
import { useTasks } from '@/features/tasks/hooks';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AgentView } from '@/features/agents/AgentView';
import { useAgents } from '@/features/agents/hooks';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  usePinChannel,
  useArchiveChannel,
  type ChannelListItem,
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
import { cleanupAllComposerDrafts } from '@/lib/composer-draft-cache';
import { routes, useNav, useRouteState } from '@/router';

export interface MessageJumpTarget {
  workspaceId?: string;
  channelId: string;
  threadId?: string | null;
  messageId: string;
}

export function App(): JSX.Element {
  useAppearance();
  const {
    layout,
    toggleWorkspaceSidebar,
    toggleChannelSidebar,
  } = useLayoutSettings();

  // Shutdown overlay — shown when the main process starts its graceful
  // quit sequence. Steps arrive via IPC; null means not shutting down.
  const [shutdownStep, setShutdownStep] = useState<string | null>(null);
  useEffect(() => {
    return window.agentHub.onShutdownProgress(step => setShutdownStep(step));
  }, []);

  useEffect(() => {
    const cleanup = (): void => cleanupAllComposerDrafts();
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
    };
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
    storageKey: 'silverhand.layout.channels-sidebar-width',
    defaultWidth: 240,
    min: 200,
    max: 400,
    cssVar: '--channels-sidebar-width',
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
  const activeEventChannelId = openThreadId ?? selectedChannelId;
  const workspaceSidebarPane = layout.workspaceSidebar;
  const channelSidebarPane = layout.channelSidebar;
  const workspaceSidebarVisible = workspaceSidebarPane.visible;
  const channelSidebarVisible = channelSidebarPane.visible;

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
  const [ephemeralThread, setEphemeralThread] = useState<ChannelListItem | null>(null);

  // The original message id anchored by the currently-open thread. Set
  // by the child ChannelView via onThreadAnchorResolved; consumed by
  // the parent ChannelView to render that row with a persistent
  // highlight (the same frame as hover) so the user knows what the
  // thread is about.
  const [highlightedParentMessageId, setHighlightedParentMessageId] = useState<
    string | null
  >(null);
  const [threadFullscreen, setThreadFullscreen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code !== 'Backslash') return;
      event.preventDefault();
      if (event.shiftKey) {
        toggleWorkspaceSidebar();
      } else {
        toggleChannelSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleChannelSidebar, toggleWorkspaceSidebar]);

  // Per-workspace "last viewed channel" memory. Lives in-memory only —
  // resetting on app restart is fine; workspace switches inside one app run
  // shouldn't lose their place.
  const lastChannelByWorkspace = useRef<Map<string, string>>(new Map());
  const lastSelectedAgentId = useRef<string | null>(null);
  const lastSelectedMessageReadKey = useRef<string | null>(null);
  const lastThreadMessageReadKey = useRef<string | null>(null);
  const lastNotificationReadId = useRef<string | null>(null);

  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAgents();
  const selectedWorkspace = workspaces.find(w => w.id === selectedWorkspaceId) ?? null;
  const { data: activeChannels = [] as ChannelListItem[] } = useChannelsForWorkspace(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  const { data: archivedChannels = [] as ChannelListItem[] } = useArchivedChannelsForWorkspace(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  // Union for URL/jump/search resolution. The sidebar gets active and
  // archived as separate props (so it can render the Archived group with
  // its own sort order), but anything that asks "does channel X exist in
  // this workspace" — selectedChannel lookup, jump targets, breadcrumbs,
  // tasks drawer — needs to consider both.
  const channels = useMemo<ChannelListItem[]>(
    () => [...activeChannels, ...archivedChannels],
    [activeChannels, archivedChannels],
  );
  const pinChannel = usePinChannel(selectedWorkspaceId ?? null);
  const archiveChannel = useArchiveChannel(selectedWorkspaceId ?? null);
  // Shared cache with SavedListView and useToggleSave — invalidations
  // from save/unsave mutations propagate the count update here too.
  const { data: savedItems } = useSavedMessages();
  // Per-workspace notification unread count (mention / agent-failure alerts).
  const { data: unreadCounts } = useUnreadCounts();
  // Global message unread summary across all workspaces — drives workspace
  // sidebar badges via conversation_reads cursor (not notification system).
  const { data: messageUnreadSummary } = useMessageUnreadSummary();
  // Per-channel message unread counts for the currently selected workspace.
  // Drives channel sidebar badges; replaces the old notification-based counts.
  const { data: messageUnreadData } = useMessageUnreadCounts(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  const channelUnreadCounts = messageUnreadData?.by_conversation;
  // Notification-based read marker (mention/agent-failure alerts).
  const markChannelRead = useMarkChannelRead();
  // Message-unread read cursor — advances conversation_reads on navigation.
  const markMessageChannelRead = useMarkMessageChannelRead();
  // In-app + system notifications for new mentions and agent failures.
  useNotificationToasts(activeEventChannelId);
  // Active-task count for the titlebar Tasks badge — scoped to the
  // current workspace so the number matches what the panel will show
  // when opened (default filter = current channel, but the badge is
  // workspace-aggregate to match where the entry lives).
  const { data: workspaceTasks = [] } = useTasks(
    selectedWorkspaceId ? { workspace_id: selectedWorkspaceId } : {},
    {
      enabled: !!selectedWorkspaceId,
      workspaceScopeIds: selectedWorkspace?.workspace_scope_ids,
    },
  );
  const workspaceActiveTaskCount = workspaceTasks.filter(
    t => t.status !== 'done',
  ).length;

  const resolveNavWorkspaceId = (
    workspaceId: string | undefined,
    channelId?: string | null,
  ): string | null => {
    if (!workspaceId) return selectedWorkspaceId;
    if (workspaces.some(w => w.id === workspaceId)) return workspaceId;
    const dmWorkspace = workspaces.find(w => {
      if (w.kind !== 'dm') return false;
      if (w.dm_channel_ids.includes(workspaceId)) return true;
      return !!channelId && w.dm_channel_ids.includes(channelId);
    });
    return dmWorkspace?.id ?? workspaceId;
  };

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
    if (stillExists) {
      nav.go(`/chat/w/${selectedWorkspaceId}/c/${remembered}`, { replace: true });
      return;
    }
    // Default: pick the first ACTIVE top-level channel. We deliberately
    // don't fall through to archivedChannels[0] — opening an archived
    // channel that lives in the (default-collapsed) Archived group would
    // be invisible to the user. With no active channels, leave selection
    // empty and let the chat pane render an empty state.
    const fallback = activeChannels.find(s => s.parent_conversation_id === null);
    if (!fallback) return;
    nav.go(`/chat/w/${selectedWorkspaceId}/c/${fallback.id}`, { replace: true });
  }, [selectedWorkspaceId, selectedChannelId, channels, activeChannels, jumpTarget, nav]);

  // Record the user's selection so we can restore it next time they
  // come back to this workspace.
  useEffect(() => {
    if (selectedWorkspaceId && selectedChannelId) {
      lastChannelByWorkspace.current.set(selectedWorkspaceId, selectedChannelId);
    }
  }, [selectedWorkspaceId, selectedChannelId]);

  // Members panel defaults to a concrete agent: restore the last selected one
  // for this app run, or fall back to the first agent in the list.
  useEffect(() => {
    if (!selectedAgentId) return;
    if (!agents.some(a => a.id === selectedAgentId)) return;
    lastSelectedAgentId.current = selectedAgentId;
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (appSection !== 'members') return;
    if (agents.length === 0) return;
    if (selectedAgentId && agents.some(a => a.id === selectedAgentId)) return;

    const remembered = lastSelectedAgentId.current;
    const target = remembered && agents.some(a => a.id === remembered)
      ? remembered
      : agents[0]!.id;
    nav.go(routes.membersAgent(target), { replace: true });
  }, [agents, appSection, nav, selectedAgentId]);

  // If the open thread is loaded and its parent doesn't match the current
  // selection, drop it. Don't drop on "missing from list" — that fires
  // during the brief window after Thread when the channels query is
  // refetching and the freshly-created thread isn't in cache yet,
  // killing the split view before it ever appears.
  useEffect(() => {
    if (!openThreadId || !selectedWorkspaceId || !selectedChannelId) return;
    const thread = channels.find(s => s.id === openThreadId);
    if (thread?.kind === 'thread' && thread.parent_conversation_id !== selectedChannelId) {
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

  // Reset fullscreen when switching threads or closing the thread pane:
  // fullscreen is a per-open-thread interaction state, not a sticky preference.
  useEffect(() => {
    setThreadFullscreen(false);
  }, [openThreadId]);

  const selectedChannel = channels.find(s => s.id === selectedChannelId) ?? null;
  const selectedChannelResolvedId = selectedChannel?.id ?? null;
  const selectedChannelRouteKind =
    selectedChannel?.kind === 'thread' ? 'thread' : 'channel';
  const parentChannel = selectedChannel?.kind === 'thread'
    ? channels.find(s => s.id === selectedChannel.parent_conversation_id) ?? null
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

  useEffect(() => {
    void window.agentHub.setActiveConversation({
      workspaceId:
        appSection === 'chat' && view === 'channel' ? selectedWorkspaceId : null,
      conversationId:
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
    if (!selectedChannelId) {
      lastSelectedMessageReadKey.current = null;
      return;
    }
    if (selectedChannelId && selectedChannelResolvedId) {
      const readKey = `${selectedChannelRouteKind}:${selectedChannelId}`;
      if (lastSelectedMessageReadKey.current === readKey) return;
      lastSelectedMessageReadKey.current = readKey;
      markMessageChannelRead.mutate({
        id: selectedChannelId,
        kind: selectedChannelRouteKind,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, selectedChannelResolvedId, selectedChannelRouteKind]);
  useEffect(() => {
    if (!openThreadId) {
      lastThreadMessageReadKey.current = null;
      return;
    }
    const readKey = `thread:${openThreadId}`;
    if (lastThreadMessageReadKey.current === readKey) return;
    lastThreadMessageReadKey.current = readKey;
    markMessageChannelRead.mutate({ id: openThreadId, kind: 'thread' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId]);

  // Keep notification badges (mention_external / agent_start_failed) cleared
  // for whichever channel the user is actively viewing.
  useEffect(() => {
    if (!activeEventChannelId) {
      lastNotificationReadId.current = null;
      return;
    }
    if (lastNotificationReadId.current === activeEventChannelId) return;
    lastNotificationReadId.current = activeEventChannelId;
    markChannelRead.mutate(activeEventChannelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEventChannelId]);

  const handleSelectWorkspace = (id: string): void => {
    // If the workspace has unread mentions, jump straight to the latest
    // one (typically the Mentions channel in a DM) — that's what the
    // user clicked the badge to see. Falls back to the
    // remembered/default channel pick when there's no pointer.
    const workspace = workspaces.find(w => w.id === id);
    const pointer = unreadCounts?.latest_by_workspace?.[id];
    if (pointer) {
      handleJumpToMessage({
        channelId: pointer.conversation_id,
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
    // Read cursors are advanced by the navigation effects above. Keeping
    // this handler side-effect free avoids duplicate mark-read/refetch storms.
    if (target?.kind === 'thread') {
      // Picking a thread from the sidebar tree opens it as the thread pane
      // alongside its parent — not as a top-level selection.
      nav.toThread(selectedWorkspaceId, target.channel_id, id);
    } else {
      nav.toChannel(selectedWorkspaceId, id);
    }
  };

  const handleJumpToMessage = (
    params: {
      workspaceId?: string;
      channelId: string;
      threadId?: string | null;
      messageId: string;
    },
    options: { preserveThreadLayout?: boolean } = {},
  ): void => {
    const targetConversationId = params.threadId ?? params.channelId;
    setJumpTarget({
      workspaceId: params.workspaceId,
      channelId: params.channelId,
      threadId: params.threadId ?? null,
      messageId: params.messageId,
    });
    markChannelRead.mutate(targetConversationId);
    const wid = resolveNavWorkspaceId(params.workspaceId, params.channelId);
    if (!wid) return;
    if (
      options.preserveThreadLayout &&
      selectedWorkspaceId === wid &&
      selectedChannelId === params.channelId &&
      openThreadId
    ) {
      return;
    }
    if (params.threadId) {
      nav.toThread(wid, params.channelId, params.threadId);
    } else {
      nav.toChannel(wid, params.channelId);
    }
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

  const buildChannelDescriptor = useCallback(
    (s: ChannelListItem | null) =>
      s
        ? {
            id: s.id,
            title: s.title,
            kind: s.kind,
            parent_conversation_id:
              s.kind === 'thread' ? s.parent_conversation_id : null,
            closed_at: s.closed_at,
            archived_at: s.archived_at,
            workspace_id: s.workspace_id,
          }
        : null,
    [],
  );

  const closeThread = useCallback((): void => {
    if (selectedWorkspaceId && selectedChannelId) {
      nav.toChannel(selectedWorkspaceId, selectedChannelId);
    }
  }, [nav, selectedWorkspaceId, selectedChannelId]);

  // ── Stable refs for ChannelView (so React.memo can short-circuit when
  //    only sidebar visibility flips). Recompute deliberately when the
  //    underlying nav / channel / mutation identity changes. ──────────────
  const handleJumped = useCallback(() => setJumpTarget(null), []);

  const handleThreadCreated = useCallback(
    (threadId: string, thread?: ChannelListItem) => {
      if (selectedWorkspaceId && selectedChannelId) {
        // Optimistically store the thread so threadChannel is non-null
        // on the very first render after nav.toThread() fires, before
        // the channels-list query refetch has a chance to complete.
        if (thread) setEphemeralThread(thread);
        nav.toThread(selectedWorkspaceId, selectedChannelId, threadId);
      }
    },
    [nav, selectedWorkspaceId, selectedChannelId],
  );

  const handleArchiveChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      archiveChannel.mutate({
        channelId,
        archived,
        workspaceId: selectedWorkspaceId ?? undefined,
      });
    },
    [archiveChannel, selectedWorkspaceId],
  );

  const handleToggleFullscreen = useCallback(
    () => setThreadFullscreen(v => !v),
    [],
  );

  // Captured by handleJumpToOriginal below — must be stable so the thread
  // ChannelView's onJumpToOriginal prop doesn't churn each render.
  const handleJumpToOriginal = useCallback(
    (messageId: string) => {
      if (!threadChannel) return;
      handleJumpToMessage(
        {
          workspaceId: selectedWorkspaceId ?? undefined,
          channelId:
            threadChannel.kind === 'thread'
              ? threadChannel.channel_id
              : threadChannel.id,
          messageId,
        },
        { preserveThreadLayout: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedWorkspaceId, threadChannel?.id, threadChannel?.kind],
  );

  // Memoize the descriptor objects so ChannelView's `conversation` prop
  // keeps the same identity unless the underlying channel actually changes.
  const parentDescriptor = useMemo(
    () => buildChannelDescriptor(selectedChannel),
    [buildChannelDescriptor, selectedChannel],
  );
  const threadDescriptor = useMemo(
    () => buildChannelDescriptor(threadChannel),
    [buildChannelDescriptor, threadChannel],
  );

  // Same for the per-pane jumpTarget — the inline ternary recreated the
  // object each render, breaking memoization down the tree.
  const parentJumpTarget = useMemo(
    () =>
      jumpTarget && !jumpTarget.threadId && jumpTarget.channelId === selectedChannelId
        ? { channelId: jumpTarget.channelId, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, selectedChannelId],
  );
  const threadJumpTarget = useMemo(
    () =>
      jumpTarget && threadChannel && jumpTarget.threadId === threadChannel.id
        ? { channelId: threadChannel.id, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, threadChannel],
  );

  const channelKindForView = selectedWorkspace?.kind === 'dm'
    ? 'dm'
    : (selectedWorkspace ? 'regular' : null);
  const highlightedMessageIdForParent = openThreadId ? highlightedParentMessageId : null;

  const parentView = (
    <ChannelView
      channelKind={channelKindForView}
      conversation={parentDescriptor}
      parentTitle={parentChannel?.title ?? null}
      jumpTarget={parentJumpTarget}
      onJumped={handleJumped}
      onThreadCreated={handleThreadCreated}
      highlightedMessageId={highlightedMessageIdForParent}
      onArchiveChannel={handleArchiveChannelMutation}
      archivePending={archiveChannel.isPending}
    />
  );

  const threadView = threadChannel ? (
    <ChannelView
      channelKind={channelKindForView}
      conversation={threadDescriptor}
      parentTitle={selectedChannel?.title ?? null}
      jumpTarget={threadJumpTarget}
      onJumped={handleJumped}
      onCloseChild={closeThread}
      onJumpToOriginal={handleJumpToOriginal}
      onThreadAnchorResolved={setHighlightedParentMessageId}
      onToggleFullscreen={handleToggleFullscreen}
      isFullscreen={threadFullscreen}
      onArchiveChannel={handleArchiveChannelMutation}
      archivePending={archiveChannel.isPending}
      // No nested Thread: thread channels can't spawn sub-threads
      // (1-layer hard limit, schema-enforced too).
      onThreadCreated={undefined}
    />
  ) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Titlebar
        workspaceId={selectedWorkspace?.id ?? null}
        workspaceName={selectedWorkspace?.name ?? null}
        workspaceKind={selectedWorkspace?.kind === 'dm' ? 'dm' : (selectedWorkspace ? 'regular' : null)}
        workspacePath={selectedWorkspace?.workspace_path ?? null}
        workspaceArchivedAt={selectedWorkspace?.archived_at ?? null}
        onOpenWorkspaceSettings={
          selectedWorkspace ? () => setWorkspaceSettingsOpen(true) : undefined
        }
        onCreateChannel={
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
        workspaceSidebarVisible={workspaceSidebarVisible}
        channelSidebarVisible={channelSidebarVisible}
        onToggleWorkspaceSidebar={toggleWorkspaceSidebar}
        onToggleChannelSidebar={toggleChannelSidebar}
      />
      <div
        className="flex min-w-0 flex-1 overflow-hidden"
        style={{
          background: 'var(--bg-app, transparent)',
          padding: '0 var(--frame-padding, 0) var(--frame-padding, 0)',
          gap: 'var(--frame-padding, 0)',
        }}
      >
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
            <aside
              className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]"
              style={{
                borderRadius: 'var(--card-radius, 0)',
                boxShadow: 'var(--card-shadow, none)',
                overflow: 'hidden',
              }}
            >
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
                onOpenConversation={s => {
                  // Jump back to chat view, focusing the agent's channel/thread.
                  const workspaceId = resolveNavWorkspaceId(s.workspace_id, s.channel_id);
                  if (!workspaceId) return;
                  if (s.thread_id) {
                    nav.toThread(workspaceId, s.channel_id, s.thread_id);
                  } else {
                    nav.toChannel(workspaceId, s.channel_id);
                  }
                }}
              />
            ) : (
              <main
                className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
                style={{
                  borderRadius: 'var(--card-radius, 0)',
                  boxShadow: 'var(--card-shadow, none)',
                  overflow: 'hidden',
                }}
              >
                选一个 agent 看详情
              </main>
            )}
          </>
        ) : appSection === 'computers' ? (
          <>
            <aside
              className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]"
              style={{
                borderRadius: 'var(--card-radius, 0)',
                boxShadow: 'var(--card-shadow, none)',
                overflow: 'hidden',
              }}
            >
              <nav className="flex-1 overflow-y-auto py-1.5">
                <ComputersPanel />
              </nav>
            </aside>
            <main
              className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
              style={{
                borderRadius: 'var(--card-radius, 0)',
                boxShadow: 'var(--card-shadow, none)',
                overflow: 'hidden',
              }}
            >
              选一台 computer 看详情
            </main>
          </>
        ) : (
          <>
            <div
              className="sidebar-slot"
              style={{
                flexBasis: workspaceSidebarVisible
                  ? 'var(--sidebar-width)'
                  : '0px',
                // When hidden, eat the right-side flex gap so the parent's
                // `gap: var(--frame-padding)` doesn't render twice (once on
                // each side of the 0-width slot). Animates alongside
                // flex-basis so the collapse stays smooth end-to-end.
                marginRight: workspaceSidebarVisible
                  ? '0px'
                  : 'calc(-1 * var(--frame-padding, 0px))',
              }}
              // hidden subtree must not steal focus or grab pointer events
              // mid-slide; `inert` removes it from the a11y tree too.
              {...(workspaceSidebarVisible ? {} : { inert: '' })}
              aria-hidden={workspaceSidebarVisible ? undefined : true}
            >
              {workspaceSidebarPane.present ? (
                <div
                  className="sidebar-surface"
                  data-state={workspaceSidebarPane.surfaceState}
                  style={{ width: 'var(--sidebar-width)' }}
                >
                  <Sidebar
                    workspaces={workspaces.map(w => ({
                      id: w.id,
                      name: w.name,
                      kind: w.kind === 'dm' ? 'dm' as const : 'regular' as const,
                      workspace_path: w.workspace_path,
                      dm_agent_id: w.dm_agent_id,
                      unread: messageUnreadSummary?.by_workspace?.[w.id] ?? 0,
                      archived: w.archived_at !== null,
                    }))}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={handleSelectWorkspace}
                    onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
                    savedActive={view === 'saved'}
                    onSelectSaved={() => nav.toChatSaved()}
                    archivedActive={view === 'archived'}
                    onSelectArchived={() => nav.toChatArchived()}
                    searchActive={view === 'search'}
                    onSelectSearch={() => nav.toChatSearch()}
                    savedCount={savedItems?.length}
                  />
                </div>
              ) : null}
            </div>
            {/* Splitter stays mounted for the entire animation lifecycle —
              * keying it to `present` (not `visible`) avoids the 4 px
              * layout snap that happens if the splitter unmounts at frame
              * zero of the hide animation while the slot is still 220 ms
              * away from finishing its collapse. The splitter slides
              * leftward in lockstep with the slot's right edge and
              * unmounts together with the surface at the end. */}
            {workspaceSidebarPane.present ? (
              <VerticalSplitter
                onPointerDown={sidebar.startResize}
                active={sidebar.isDragging}
              />
            ) : null}
            {view === 'saved' ? (
              <SavedListView onJump={params => handleJumpToMessage(params)} />
            ) : view === 'search' ? (
              <SearchPanel
                workspaces={workspaces}
                onJumpMessage={params => handleJumpToMessage(params)}
                onOpenWorkspace={id => nav.toWorkspace(id)}
                onOpenConversation={(workspaceId, channelId, threadId) => {
                  const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                  if (!navWorkspaceId) return;
                  if (threadId) nav.toThread(navWorkspaceId, channelId, threadId);
                  else nav.toChannel(navWorkspaceId, channelId);
                }}
              />
            ) : view === 'archived' ? (
              <ArchivedChannelsPanel
                workspaces={workspaces}
                onOpenChannel={(workspaceId, channelId) =>
                  nav.toChannel(workspaceId, channelId)
                }
              />
            ) : (
              <>
                <div
                  className="sidebar-slot"
                  style={{
                    flexBasis: channelSidebarVisible
                      ? 'var(--channels-sidebar-width)'
                      : '0px',
                    marginRight: channelSidebarVisible
                      ? '0px'
                      : 'calc(-1 * var(--frame-padding, 0px))',
                  }}
                  {...(channelSidebarVisible ? {} : { inert: '' })}
                  aria-hidden={channelSidebarVisible ? undefined : true}
                >
                  {channelSidebarPane.present ? (
                    <div
                      className="sidebar-surface"
                      data-state={channelSidebarPane.surfaceState}
                      style={{ width: 'var(--channels-sidebar-width)' }}
                    >
                      <ChannelsSidebar
                        workspaceName={selectedWorkspace?.name ?? null}
                        channels={activeChannels.map(s => ({
                          id: s.id,
                          title: s.title,
                          kind: s.kind,
                          status:
                            s.status === 'active' || s.status === 'crashed' ? s.status : 'idle',
                          parent_channel_id: s.kind === 'thread' ? s.parent_conversation_id : null,
                          closed_at: s.closed_at,
                          pinned_at: s.pinned_at,
                          archived_at: s.archived_at,
                        }))}
                        workspaceKind={selectedWorkspace?.kind === 'dm' ? 'dm' : (selectedWorkspace ? 'regular' : null)}
                        // Highlight either the parent (top-level) or — when a thread
                        // pane is open — also the thread below it via tree indent.
                        // ChannelsSidebar already renders the tree; selection just
                        // points at "what's the active row".
                        selectedChannelId={openThreadId ?? selectedChannelId}
                        onSelectChannel={handleSelectChannel}
                        onPinChannel={(channelId, pinned) =>
                          pinChannel.mutate({ channelId, pinned })
                        }
                        onArchiveChannel={(channelId, archived) => {
                          archiveChannel.mutate({
                            channelId,
                            archived,
                            workspaceId: selectedWorkspaceId ?? undefined,
                          });
                        }}
                        archivePending={archiveChannel.isPending}
                        // Always wired — closeThread no-ops when there's
                        // no open thread pane (re-navigates to the same
                        // channel). Keeping the menu item shape constant
                        // avoids a "now you see it, now you don't" feel.
                        onCloseThread={closeThread}
                        unreadByChannel={channelUnreadCounts ?? {}}
                      />
                    </div>
                  ) : null}
                </div>
                {/* Splitter mounted across the full present lifecycle (see
                  * the workspace-sidebar block for rationale). */}
                {channelSidebarPane.present ? (
                  <VerticalSplitter
                    onPointerDown={channelsSidebar.startResize}
                    active={channelsSidebar.isDragging}
                  />
                ) : null}
                {threadView ? (
                  threadFullscreen ? (
                    threadView
                  ) : (
                    <SplitPane
                      left={parentView}
                      right={threadView}
                      storageKey="silverhand.layout.split-ratio"
                    />
                  )
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
        <WorkspaceTasksDrawer
          open={tasksDrawerOpen}
          onOpenChange={setTasksDrawerOpen}
          workspaceId={selectedWorkspace.id}
          workspaceName={selectedWorkspace.name}
          workspaceScopeIds={selectedWorkspace.workspace_scope_ids}
          conversations={channels.map(s => ({
            id: s.id,
            title: s.title,
            closed_at: s.closed_at,
            created_at: s.created_at,
          }))}
          defaultConversationId={selectedChannelId}
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
