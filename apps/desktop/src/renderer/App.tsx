import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { Toaster } from 'sonner';
import { NavRail } from '@/components/layout/NavRail';
import { ComputersPanel } from '@/components/layout/ComputersPanel';
import { HostDetailView } from '@/features/hosts/HostDetailView';
import {
  useBackendInfoSnapshot,
  useHostsQuery,
} from '@/features/hosts/hooks';
import { MembersPanel } from '@/components/layout/MembersPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChannelsSidebar } from '@/components/layout/ChannelsSidebar';
import { ChannelView } from '@/components/layout/ChannelView';
import { ThreadPanel } from '@/components/layout/ThreadPanel';
import { SavedListView } from '@/components/layout/SavedListView';
import { SearchPanel } from '@/components/layout/SearchPanel';
import { ArchivedChannelsPanel } from '@/components/layout/ArchivedChannelsPanel';
import { SplitPane } from '@/components/layout/SplitPane';
import { TasksSection } from '@/components/layout/TasksSection';
import { Titlebar } from '@/components/layout/Titlebar';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useAppearance } from '@/hooks/useAppearance';
import { useLayoutSettings } from '@/hooks/useLayoutSettings';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { RegistrationGate } from '@/features/me/RegistrationGate';
import { BackendUnreachableGate } from '@/features/me/BackendUnreachableGate';
import { BackendUnreachableBanner } from '@/features/me/BackendUnreachableBanner';
import { SetupWizardModal } from '@/features/setup/SetupWizard';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
import { CreateChannelDialog } from '@/features/workspaces/CreateChannelDialog';
import { WorkspaceSettingsDialog } from '@/features/workspaces/WorkspaceSettingsDialog';
import { WorkspaceTasksDrawer } from '@/components/tasks/WorkspaceTasksDrawer';
import { useTasks } from '@/features/tasks/hooks';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AgentView } from '@/features/agents/AgentView';
import { HumanView } from '@/features/me/HumanView';
import { SideUnresolvedPlaceholder } from '@/components/layout/SideUnresolvedPlaceholder';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import { useConversationById } from '@/features/conversations/useConversationById';
import { useAgents } from '@/features/agents/hooks';
import {
  useWorkspaces,
  useViewerWorkspacesSync,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  usePinWorkspace,
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
import {
  useMessageJumpController,
  type MessageJumpTarget,
} from '@/features/channels/useMessageJumpController';
import { cleanupAllComposerDrafts } from '@/lib/composer-draft-cache';
import {
  selectFocusedConversation,
  selectSecondaryDescriptor,
  selectSecondaryViewInputs,
  selectVisibleConversations,
  shouldSecondaryFullscreen,
  type ConversationPointer,
  type SecondaryDescriptor,
} from '@/lib/secondary-pane';
import {
  buildChannelPathPreservingSide,
  routes,
  useNav,
  useRouteState,
  withClusterQuery,
} from '@/router';

// Per-workspace "last viewed channel" + per-channel "last open thread"
// memory. The maps + persistence helpers live in
// `lib/place-memory.ts` so `useLogout` can also import them without a
// circular dep on this module (multi-human audit 2026-06-03
// #task:857 P0.7). The exports are re-exported here for callers that
// already imported them from App.
import {
  LAST_CHANNEL_KEY,
  LAST_THREAD_KEY,
  clearPlaceMemory,
  lastChannelByWorkspace,
  lastThreadByChannel,
  persistLastChannel,
  persistLastThread,
} from '@/lib/place-memory';
export {
  LAST_CHANNEL_KEY,
  LAST_THREAD_KEY,
  clearPlaceMemory,
};

export function App(): JSX.Element {
  useAppearance();
  // Hydrate the viewer profile from the main-process auth session so
  // `isCurrentUserId` resolves correctly. Returns either the resolved
  // UserDto or the setup-required shape that mounts the auth wizard.
  const viewer = useViewerUser();

  // Three-way render: loading → registration gate → registered shell.
  // Critical: each branch returns BEFORE any further hooks, and the
  // shell lives in a separate component (`RegisteredAppShell`) so the
  // hook order is stable inside `App` across re-renders. If we kept
  // the shell hooks inline here, the post-registration render would
  // call dozens more hooks than the pre-registration render and React
  // would crash with "Rendered more hooks than during the previous
  // render".
  //
  // D4.a Commit 2 — `SetupWizardModal` is mounted at this fixed
  // position regardless of branch so the App menu's
  // "Connect to backend…" item can pop it open in any state (pre-auth
  // registration gate, loading, or post-auth shell). The modal owns
  // its own hooks; App's hook order is unchanged.
  if (!viewer.data) {
    return (
      <>
        <div className="grid h-screen w-screen place-items-center bg-bg-base text-xs text-text-muted">
          Loading…
        </div>
        <SetupWizardModal />
      </>
    );
  }
  // D4.a Commit 5d-fixup (Cindy P1-2): backend-unreachable gate
  // takes precedence over the registration / setup wizard. The
  // user MUST repair the connection (or clear the saved profile)
  // before any further auth state can be inferred — pretending the
  // user is "unauthenticated, signup_enabled=false" would push them
  // toward the wrong CTA.
  if (isBackendUnreachable(viewer.data)) {
    return (
      <>
        <BackendUnreachableGate
          serverUrl={viewer.data.server_url}
          message={viewer.data.message}
          onRetry={() => {
            void viewer.refetch();
          }}
        />
        <SetupWizardModal />
      </>
    );
  }
  if (isRegistrationRequired(viewer.data)) {
    return (
      <>
        <RegistrationGate signupEnabled={viewer.data.signup_enabled} />
        <SetupWizardModal />
      </>
    );
  }
  return (
    <>
      <RegisteredAppShell />
      <SetupWizardModal />
    </>
  );
}

function RegisteredAppShell(): JSX.Element {
  const {
    layout,
    toggleWorkspaceSidebar,
    toggleChannelSidebar,
  } = useLayoutSettings();

  // Keep the viewer's workspace list live when their cross-workspace
  // membership/role changes from any source (added/removed/role-changed).
  // Mounted here — post-auth and independent of workspace selection — so it
  // also catches "added to your first workspace". See
  // docs/viewer-visibility-sync-v1.md.
  useViewerWorkspacesSync();

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
    sideConversationId,
    clusterRootId,
    focusedTaskNumber,
    fullscreen: routeFullscreen,
    threadFullscreen,
    agentId: selectedAgentId,
    userId: selectedUserId,
  } = route;
  const workspaceSidebarPane = layout.workspaceSidebar;
  const channelSidebarPane = layout.channelSidebar;
  const workspaceSidebarVisible = workspaceSidebarPane.visible;
  const channelSidebarVisible = channelSidebarPane.visible;

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  // #task:808 slice 4 — selected host in the Computers section. In-memory
  // (no URL persistence in v1; no other surface deep-links to a specific
  // host). Auto-defaults to the local host once the host list lands so
  // the right pane isn't empty on first visit. Selection is cleared if
  // the host disappears (e.g. revoke) so the detail view doesn't render
  // a stale row.
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const {
    jumpTarget,
    requestJump,
    clearJump,
    isPrimePendingFor,
  } = useMessageJumpController();

  // The original message id anchored by the currently-open thread. Set
  // by the child ChannelView via onThreadAnchorResolved; consumed by
  // the parent ChannelView to render that row with a persistent
  // highlight (the same frame as hover) so the user knows what the
  // thread is about.
  const [highlightedParentMessageId, setHighlightedParentMessageId] = useState<
    string | null
  >(null);
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

  // App menu's "Settings…" item (Cmd+,) — main process focuses the
  // window and pushes this; renderer just navigates. `nav.toSettings`
  // is stable across renders (memoized inside `useNav`).
  useEffect(() => {
    return window.agentHub.onNavigateSettings(() => nav.toSettings());
  }, [nav.toSettings]);

  // Per-workspace "last viewed channel" memory and per-channel "last
  // open thread" memory both live as module singletons above (persisted
  // via localStorage). The recording effects below write through to
  // storage on every mutation; the restore effect reads from them when
  // hydrating from a workspaceId-only URL.
  const lastSelectedAgentId = useRef<string | null>(null);
  const lastSelectedMessageReadKey = useRef<string | null>(null);
  const lastThreadMessageReadKey = useRef<string | null>(null);
  const lastNotificationReadId = useRef<string | null>(null);

  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAgents();
  // Stable id → agent lookup shared with the sidebar (DM avatar
  // resolution) and any future agent-keyed surface. Memoized on the
  // list reference so render of a different surface in the tree
  // doesn't rebuild the Map. #task:919
  const agentsById = useMemo(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
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
  const pinWorkspace = usePinWorkspace();
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

  // ── Dock badge sync ────────────────────────────────────────────────────
  // macOS dock icon shows total unread messages across every workspace.
  // `useMessageUnreadSummary` already aggregates `conversation_reads`
  // globally and self-invalidates on viewer-scoped `unread_updated`,
  // so summing here gives a reactive total without any extra wiring.
  // Notification unread (mentions / agent_start_failed) is intentionally
  // excluded — it's a different concept and would double-count mentions
  // that are also unread messages.
  const dockBadgeCount = useMemo(() => {
    if (!messageUnreadSummary) return 0;
    let total = 0;
    for (const n of Object.values(messageUnreadSummary.by_workspace)) {
      total += n;
    }
    return total;
  }, [messageUnreadSummary]);
  useEffect(() => {
    void window.agentHub.setBadgeCount(dockBadgeCount);
  }, [dockBadgeCount]);

  // ── Secondary pane state (PR-1) ───────────────────────────────────────
  // The right-hand pane is no longer thread-only. URL state combines
  // `?side=<id>` (overlay) with the legacy `/t/<tid>` path; selectors
  // in `lib/secondary-pane` resolve them into:
  //   - `secondaryDescriptor`  what the right pane renders (resolved
  //     channel/thread, an unresolved placeholder, or null).
  //   - `visibleConversations` { primary, secondary } drives message
  //     read-cursor advancement.
  //   - `focusedConversation`  single id for toast suppression / IPC
  //     setActiveConversation / notification badge clearing. Preserves
  //     the legacy `openThreadId ?? selectedChannelId` semantic by
  //     letting a resolved secondary win over primary.
  //
  const primaryPointer = useMemo<ConversationPointer | null>(() => {
    if (!selectedChannelId) return null;
    const hit = channels.find(c => c.id === selectedChannelId);
    if (!hit) return null;
    return { id: hit.id, kind: hit.kind };
  }, [channels, selectedChannelId]);
  // PR-2: cross-workspace `?side=<id>` resolution. The ref hook is the
  // single source of truth for the right pane's identity & workspace —
  // same-workspace and cross-workspace ids both flow through it. The
  // fetch is React-Query–cached (30s stale, 5min gc) so navigating
  // back to a recently-opened side hits the cache without a round-trip.
  const sideRef = useConversationById(sideConversationId);
  const secondaryDescriptor = useMemo<SecondaryDescriptor | null>(
    () =>
      selectSecondaryDescriptor(
        { sideConversationId, threadId: openThreadId },
        channels,
        sideRef,
      ),
    [sideConversationId, openThreadId, channels, sideRef],
  );
  // Workspace metadata for a `?side` resolved descriptor flows through
  // `secondaryViewInputs` below — no separate memo needed. The four
  // cross-workspace wiring sites (channelKind, archive invalidation,
  // handleJumpToOriginal parent navigation, sidebar selected-row gate)
  // each pull what they need straight from the descriptor.
  const visibleConversations = useMemo(
    () =>
      selectVisibleConversations({
        primary: primaryPointer,
        secondary: secondaryDescriptor,
        fullscreen: routeFullscreen,
      }),
    [primaryPointer, secondaryDescriptor, routeFullscreen],
  );
  const focusedConversation = useMemo(
    () =>
      selectFocusedConversation({
        primary: primaryPointer,
        primaryWorkspaceId: selectedWorkspaceId,
        secondary: secondaryDescriptor,
        fullscreen: routeFullscreen,
      }),
    [primaryPointer, selectedWorkspaceId, secondaryDescriptor, routeFullscreen],
  );
  // Notification-based read marker (mention/agent-failure alerts).
  const markChannelRead = useMarkChannelRead();
  // Message-unread read cursor — advances conversation_reads on navigation.
  const markMessageChannelRead = useMarkMessageChannelRead();
  // In-app + system notifications for new mentions and agent failures.
  // Suppression is focused-only on purpose — even when both primary and
  // secondary are visible, only the user-attentive pane (= focused) gets
  // toasts silenced. Improving to "any visible pane silences" is a
  // future polish.
  //
  // Click handler: notifications carrying a navigation target (mention_*)
  // route through `handleJumpToMessage`, the same primitive we use for
  // search hits / Saved / task chips. The hook stashes the callback in
  // an `onJumpRef` internally so the inline arrow's identity churn is
  // a non-issue (no useCallback needed; trying to memoize would risk
  // stale closures since `handleJumpToMessage` is declared below in the
  // same function body).
  useNotificationToasts(focusedConversation?.id ?? null, target =>
    handleJumpToMessage(target),
  );
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
  // Exclude both terminal statuses: `done` (completed) and `closed`
  // (shelved). After the closed-as-status cutover `closed` is the 5th
  // status, so the badge must drop it too — otherwise every shelved task
  // counts as "active" (matches TasksSection's channelActiveCounts).
  const workspaceActiveTaskCount = workspaceTasks.filter(
    t => t.status !== 'done' && t.status !== 'closed',
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
  }, [appSection, view, selectedWorkspaceId, workspaces, nav.go]);

  // If the URL's workspaceId no longer exists (deleted in another window,
  // bad bookmark), bounce to /chat so the auto-pick effect can take over.
  useEffect(() => {
    if (!selectedWorkspaceId || workspaces.length === 0) return;
    if (!workspaces.some(w => w.id === selectedWorkspaceId)) {
      nav.go('/chat', { replace: true });
    }
  }, [selectedWorkspaceId, workspaces, nav.go]);

  // When switching workspaces (or when channels arrive for the current
  // workspace), restore the last-viewed channel, fall back to the first one.
  // Wait for `channels` to populate so we don't race the empty placeholder.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (selectedChannelId) return;
    if (channels.length === 0) return;
    // Helper: pick the right URL for the restored channel — if we
    // remember an open thread for it that still exists in the channels
    // cache, restore the split layout too. Otherwise just open the
    // channel. Threads opened from a different parent are ignored
    // defensively (parent mismatch effect would close them anyway).
    const navForRestoredChannel = (channelId: string): string => {
      const rememberedThread = lastThreadByChannel.get(channelId);
      const thread = rememberedThread
        ? channels.find(s => s.id === rememberedThread)
        : null;
      if (
        thread &&
        thread.kind === 'thread' &&
        thread.parent_conversation_id === channelId
      ) {
        return `/chat/w/${selectedWorkspaceId}/c/${channelId}/t/${thread.id}`;
      }
      return `/chat/w/${selectedWorkspaceId}/c/${channelId}`;
    };
    // If a jump asked for a specific channel, honor it instead of the
    // remembered/default — Saved → jump shouldn't snap back.
    if (jumpTarget && channels.some(s => s.id === jumpTarget.channelId)) {
      nav.go(`/chat/w/${selectedWorkspaceId}/c/${jumpTarget.channelId}`, {
        replace: true,
      });
      return;
    }
    const remembered = lastChannelByWorkspace.get(selectedWorkspaceId);
    const stillExists = remembered && channels.some(s => s.id === remembered);
    if (stillExists) {
      nav.go(navForRestoredChannel(remembered), { replace: true });
      return;
    }
    // Default: pick the first ACTIVE top-level channel. We deliberately
    // don't fall through to archivedChannels[0] — opening an archived
    // channel that lives in the (default-collapsed) Archived group would
    // be invisible to the user. With no active channels, leave selection
    // empty and let the chat pane render an empty state.
    const fallback = activeChannels.find(s => s.parent_conversation_id === null);
    if (!fallback) return;
    nav.go(navForRestoredChannel(fallback.id), { replace: true });
  }, [
    selectedWorkspaceId,
    selectedChannelId,
    channels,
    activeChannels,
    jumpTarget,
    nav.go,
  ]);

  // Record the user's selection so we can restore it next time they
  // come back to this workspace. Persist on every change so quitting
  // mid-session doesn't lose the entry.
  useEffect(() => {
    if (selectedWorkspaceId && selectedChannelId) {
      if (lastChannelByWorkspace.get(selectedWorkspaceId) === selectedChannelId) return;
      lastChannelByWorkspace.set(selectedWorkspaceId, selectedChannelId);
      persistLastChannel();
    }
  }, [selectedWorkspaceId, selectedChannelId]);

  // Same for the open thread within a channel — recorded so leaving the
  // chat section (NavRail → Tasks / Members / Settings) and coming back
  // re-mounts the split pane instead of dropping it. Cleared explicitly
  // by `closeThread` when the user dismisses the pane on purpose; we
  // intentionally do NOT clear here on null, because that would erase
  // the memo every time the app section flips.
  useEffect(() => {
    if (selectedChannelId && openThreadId) {
      if (lastThreadByChannel.get(selectedChannelId) === openThreadId) return;
      lastThreadByChannel.set(selectedChannelId, openThreadId);
      persistLastThread();
    }
  }, [selectedChannelId, openThreadId]);

  // Members panel defaults to a concrete agent: restore the last selected one
  // for this app run, or fall back to the first agent in the list.
  useEffect(() => {
    if (!selectedAgentId) return;
    if (!agents.some(a => a.id === selectedAgentId)) return;
    lastSelectedAgentId.current = selectedAgentId;
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (appSection !== 'members') return;
    // A human-route resolution is its own valid landing. Skip the
    // agent-first default so `/members/u/<userId>` doesn't get clobbered
    // back to an agent on first paint.
    if (selectedUserId) return;
    if (agents.length === 0) return;
    if (selectedAgentId && agents.some(a => a.id === selectedAgentId)) return;

    const remembered = lastSelectedAgentId.current;
    const target = remembered && agents.some(a => a.id === remembered)
      ? remembered
      : agents[0]!.id;
    nav.go(routes.membersAgent(target), { replace: true });
  }, [agents, appSection, nav, selectedAgentId, selectedUserId]);

  // #task:808 slice 4 — host list + auto-default selection. We own the
  // hosts/backend-info queries here so the master `ComputersPanel` and
  // the right-pane `HostDetailView` both read from a single resolved
  // list (no double React Query subscription, no race between them
  // mid-update). ComputersPanel takes the data as props; HostDetailView
  // gets the resolved `selectedHost` directly.
  const hostsQuery = useHostsQuery();
  const backendInfoQuery = useBackendInfoSnapshot();
  const computerHosts = hostsQuery.data?.hosts ?? [];
  const localHostIdForComputers =
    backendInfoQuery.data?.local_host_id ?? null;
  const localHostAttached =
    backendInfoQuery.data?.local_host_ws_attached_at !== null &&
    backendInfoQuery.data?.local_host_ws_attached_at !== undefined;
  useEffect(() => {
    if (computerHosts.length === 0) return;
    // Drop a stale selection (e.g. the host was revoked from another
    // surface) before falling through to the default-picker.
    if (
      selectedHostId &&
      !computerHosts.some(h => h.id === selectedHostId)
    ) {
      setSelectedHostId(null);
    }
    if (selectedHostId) return;
    const localHit = localHostIdForComputers
      ? computerHosts.find(h => h.id === localHostIdForComputers)
      : null;
    setSelectedHostId(localHit?.id ?? computerHosts[0]!.id);
  }, [computerHosts, localHostIdForComputers, selectedHostId]);
  const selectedHost = useMemo(
    () =>
      selectedHostId
        ? computerHosts.find(h => h.id === selectedHostId) ?? null
        : null,
    [computerHosts, selectedHostId],
  );

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

  // Clear the parent-message highlight whenever the thread side pane
  // closes — the highlight only makes sense alongside an open thread.
  // Channel-typed `?side` panes never anchor to a parent message, so
  // this also fires when secondary flips from thread to channel.
  const secondaryDescriptorKind =
    secondaryDescriptor?.status === 'resolved' ? secondaryDescriptor.kind : null;
  useEffect(() => {
    if (secondaryDescriptorKind !== 'thread') setHighlightedParentMessageId(null);
  }, [secondaryDescriptorKind]);

  const selectedChannel = channels.find(s => s.id === selectedChannelId) ?? null;
  const parentChannel = selectedChannel?.kind === 'thread'
    ? channels.find(s => s.id === selectedChannel.parent_conversation_id) ?? null
    : null;
  // Secondary pane: resolved channel object for ChannelView.
  // PR-1: thread-path source resolves through the workspace channel list. PR-2:
  // `?side` source resolves through the ref hook — secondaryChannel is
  // null in that case (the lookup may not contain a cross-workspace
  // conversation), and the secondary ChannelDescriptor is built from
  // the ref data instead (see `secondaryConversationDescriptor` below).
  const secondaryChannel = useMemo<ChannelListItem | null>(() => {
    if (!secondaryDescriptor || secondaryDescriptor.status !== 'resolved') {
      return null;
    }
    if (secondaryDescriptor.source !== 'thread-path') return null;
    return channels.find(c => c.id === secondaryDescriptor.id) ?? null;
  }, [secondaryDescriptor, channels]);
  // PR-1: only enable the fullscreen toggle for the legacy thread-path
  // source. `?side` panes don't get fullscreen toggle yet — that lives
  // in a follow-up that needs to teach `useNav` to write `?fullscreen=1`
  // alongside `?side`.
  const secondarySupportsFullscreenToggle =
    secondaryDescriptor?.source === 'thread-path';
  const conversationRefsById = useMemo(() => {
    const m = new Map<string, ConversationReference>();
    const topLevelById = new Map(
      channels
        .filter(item => item.kind !== 'thread')
        .map(item => [item.id, item] as const),
    );
    for (const item of channels) {
      if (item.kind === 'thread') {
        const parent = topLevelById.get(item.channel_id);
        m.set(item.id, {
          id: item.id,
          kind: item.kind,
          title: item.title,
          parent_channel_id: item.channel_id,
          parent_title: parent?.title ?? null,
        });
      } else {
        m.set(item.id, {
          id: item.id,
          kind: item.kind,
          title: item.title,
        });
      }
    }
    return m;
  }, [channels]);

  // IPC: tell the main process which conversation the user is focused
  // on. Drives tray/dock badging and the events window. Schema is
  // single-id (`{workspaceId, conversationId}`); we feed it the focused
  // selector. Nulls out when the chat view isn't active so the events
  // window doesn't keep highlighting a stale row after the user
  // navigates to Members/Tasks/Settings.
  const focusedActive =
    appSection === 'chat' && view === 'channel' ? focusedConversation : null;
  useEffect(() => {
    void window.agentHub.setActiveConversation({
      workspaceId: focusedActive?.workspaceId ?? null,
      conversationId: focusedActive?.id ?? null,
    });
  }, [focusedActive?.workspaceId, focusedActive?.id]);

  // Auto-advance the message read cursor for every visible pane. The
  // `visibleConversations` selector already handles the "fullscreen
  // hides primary" case and the "unresolved side has no id to mark
  // read" case — the effects below just plumb the resulting pointers
  // into the markRead mutation.
  const visiblePrimary = visibleConversations.primary;
  const visibleSecondary = visibleConversations.secondary;
  useEffect(() => {
    if (!visiblePrimary) {
      lastSelectedMessageReadKey.current = null;
      return;
    }
    const kind = visiblePrimary.kind === 'thread' ? 'thread' : 'channel';
    const readKey = `${kind}:${visiblePrimary.id}`;
    if (lastSelectedMessageReadKey.current === readKey) return;
    lastSelectedMessageReadKey.current = readKey;
    markMessageChannelRead.mutate({ id: visiblePrimary.id, kind });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePrimary?.id, visiblePrimary?.kind]);
  useEffect(() => {
    if (!visibleSecondary) {
      lastThreadMessageReadKey.current = null;
      return;
    }
    const kind = visibleSecondary.kind === 'thread' ? 'thread' : 'channel';
    const readKey = `${kind}:${visibleSecondary.id}`;
    if (lastThreadMessageReadKey.current === readKey) return;
    lastThreadMessageReadKey.current = readKey;
    markMessageChannelRead.mutate({ id: visibleSecondary.id, kind });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSecondary?.id, visibleSecondary?.kind]);

  // Keep notification badges (mention_external / agent_start_failed) cleared
  // for whichever channel the user is actively focused on.
  useEffect(() => {
    const focusedId = focusedConversation?.id ?? null;
    if (!focusedId) {
      lastNotificationReadId.current = null;
      return;
    }
    if (lastNotificationReadId.current === focusedId) return;
    lastNotificationReadId.current = focusedId;
    markChannelRead.mutate(focusedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedConversation?.id]);

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

  // Open the workspace tasks drawer focused on a specific task. Wired
  // to inline `#task:<n>` chips via `TaskRefContextProvider` inside
  // ChannelView. The chip's workspace is the message's workspace —
  // when that differs from the primary-selected workspace (cross-
  // workspace `?side` panes), we navigate to the foreign workspace's
  // top-level path with `?task=<n>` attached so the drawer opens
  // against the right task list.
  const handleOpenTask = useCallback(
    (taskNumber: number, workspaceId: string) => {
      if (selectedWorkspaceId === workspaceId) {
        nav.openTask(taskNumber);
      } else {
        nav.go(`${routes.chatWorkspace(workspaceId)}?task=${taskNumber}`);
      }
    },
    [selectedWorkspaceId, nav.go, nav.openTask],
  );

  // Open a `#<channel_name>` chip click. The chip's resolution scope is
  // the message's workspace (so cross-workspace `?side` panes can still
  // click their own refs), so we navigate the right workspace explicitly
  // even when it doesn't match the primary selection.
  const handleOpenChannelByName = useCallback(
    (workspaceId: string, channelId: string) => {
      nav.toChannel(workspaceId, channelId);
    },
    [nav.toChannel],
  );

  // Auto-open the tasks drawer when `?task=<n>` lands in the URL. The
  // drawer's own scroll/highlight effect reacts to `focusedTaskNumber`;
  // we just need to make it visible. `?task` clears once the highlight
  // has been delivered (drawer fires `onClearFocus` → `nav.closeTask`).
  useEffect(() => {
    if (focusedTaskNumber !== null && !tasksDrawerOpen) {
      setTasksDrawerOpen(true);
    }
  }, [focusedTaskNumber, tasksDrawerOpen]);

  const handleJumpToMessage = (
    params: MessageJumpTarget,
    options: { preserveThreadLayout?: boolean; threadFullscreen?: boolean } = {},
  ): void => {
    requestJump(params);
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
    // Reply-cluster target (new model): the message lives in the parent
    // channel; open the cluster pane to its root and let ThreadPanel
    // scroll-locate the message (requestJump already primed the channel).
    // Navigate channel + `?cluster` atomically — a `toChannel` then
    // `openCluster` would build the cluster query off the pre-navigation
    // location and drop it. Mutually exclusive with the legacy thread path.
    if (params.threadRootId) {
      nav.go(
        withClusterQuery(
          routes.chatChannel(wid, params.channelId),
          '',
          params.threadRootId,
        ),
      );
    } else if (params.threadId) {
      nav.toThread(wid, params.channelId, params.threadId, {
        fullscreen: options.threadFullscreen,
      });
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
      // Explicit close clears the per-channel memo (and persists the
      // deletion) so navigating away and back doesn't re-open the
      // just-dismissed thread, even across an app restart.
      if (lastThreadByChannel.delete(selectedChannelId)) {
        persistLastThread();
      }
      nav.toChannel(selectedWorkspaceId, selectedChannelId);
    }
  }, [nav.toChannel, selectedWorkspaceId, selectedChannelId]);

  // Dispatching close handler for the secondary pane's X button. Routes
  // by the descriptor's source so a `?side` overlay closes via
  // `nav.closeSide()` (clears query, leaves any path-thread underneath
  // untouched — the overlay semantic), while a legacy `/t/<tid>` path
  // closes via `closeThread` (clears the path AND the per-channel
  // memo). PR-1 keeps both paths so existing thread close affordances
  // (sidebar context menu, etc.) continue to work unchanged.
  const closeSecondary = useCallback((): void => {
    if (!secondaryDescriptor) return;
    if (secondaryDescriptor.source === 'side') {
      nav.closeSide();
      return;
    }
    closeThread();
  }, [secondaryDescriptor, nav.closeSide, closeThread]);

  // ── Stable refs for ChannelView (so React.memo can short-circuit when
  //    only sidebar visibility flips). Recompute deliberately when the
  //    underlying nav / channel / mutation identity changes. ──────────────
  const handleJumped = useCallback(() => {
    clearJump();
  }, [clearJump]);

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

  // Fullscreen toggle for the secondary pane. PR-1 only enables it for
  // the legacy thread-path source (the original IM affordance);
  // `?side` panes don't get a fullscreen toggle yet — wiring that
  // requires teaching `useNav` to write `?fullscreen=1` alongside
  // `?side`. Tracked as deferred; the toggle button is hidden via
  // `secondarySupportsFullscreenToggle` below.
  const handleToggleFullscreen = useCallback(() => {
    if (!selectedWorkspaceId || !selectedChannelId || !openThreadId) return;
    nav.toThread(selectedWorkspaceId, selectedChannelId, openThreadId, {
      fullscreen: !threadFullscreen,
      replace: true,
    });
  }, [
    nav.toThread,
    selectedWorkspaceId,
    selectedChannelId,
    openThreadId,
    threadFullscreen,
  ]);

  // "View in channel" — only meaningful when the secondary pane is a
  // thread (channel-typed sides have no parent to jump to). PR-2:
  // cross-workspace threads jump primary to the *foreign* workspace's
  // parent channel — `secondaryDescriptor.workspaceId` carries the
  // truth for both `?side` (set from the ref payload) and
  // `thread-path` (set from the channels lookup).
  //
  // For `?side` source, we navigate via `buildChannelPathPreservingSide`
  // so the side overlay (`?side=<thread>`) survives the primary jump —
  // the user's intent is "show me the parent channel"; closing the
  // thread they're reading would defeat that. `handleJumpToMessage`'s
  // existing preserveThreadLayout early-return only fires for
  // same-workspace + same-channel + open path-thread, which doesn't
  // hold cross-workspace.
  //
  // For `thread-path` source (legacy same-workspace `/t/<tid>`), we
  // still go through `handleJumpToMessage` so the existing
  // preserveThreadLayout no-op fires when applicable.
  const handleJumpToOriginal = useCallback(
    (messageId: string) => {
      if (!secondaryDescriptor || secondaryDescriptor.status !== 'resolved') {
        return;
      }
      if (secondaryDescriptor.kind !== 'thread') return;
      const parentChannelId = secondaryDescriptor.parentChannelId;
      if (!parentChannelId) return;
      if (secondaryDescriptor.source === 'side') {
        const wid = secondaryDescriptor.workspaceId;
        requestJump({
          workspaceId: wid,
          channelId: parentChannelId,
          threadId: null,
          messageId,
        });
        nav.go(
          buildChannelPathPreservingSide(
            wid,
            parentChannelId,
            secondaryDescriptor.id,
          ),
          { replace: true },
        );
        return;
      }
      handleJumpToMessage(
        {
          workspaceId: secondaryDescriptor.workspaceId,
          channelId: parentChannelId,
          messageId,
        },
        { preserveThreadLayout: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      secondaryDescriptor?.status,
      secondaryDescriptor?.status === 'resolved'
        ? secondaryDescriptor.source
        : null,
      secondaryDescriptor?.status === 'resolved'
        ? secondaryDescriptor.kind
        : null,
      secondaryDescriptor?.status === 'resolved'
        ? secondaryDescriptor.workspaceId
        : null,
      secondaryDescriptor?.status === 'resolved'
        ? secondaryDescriptor.parentChannelId
        : null,
      secondaryDescriptor?.status === 'resolved' &&
      secondaryDescriptor.source === 'side'
        ? secondaryDescriptor.id
        : null,
      nav.go,
      requestJump,
    ],
  );

  // Memoize the descriptor objects so ChannelView's `conversation` prop
  // keeps the same identity unless the underlying channel actually changes.
  const parentDescriptor = useMemo(
    () => buildChannelDescriptor(selectedChannel),
    [buildChannelDescriptor, selectedChannel],
  );
  const channelKindForView = selectedWorkspace?.kind === 'dm'
    ? 'dm'
    : (selectedWorkspace ? 'regular' : null);
  // PR-2: single pure mapping from `secondaryDescriptor` (+ primary
  // fallbacks for thread-path source) into the props ChannelView
  // consumes for the secondary pane. Keeps the cross-workspace wiring
  // (foreign workspace_id / workspace_kind / parent_title / archive
  // invalidation target) end-to-end testable without renderHook.
  const secondaryViewInputs = useMemo(
    () =>
      selectSecondaryViewInputs({
        secondary: secondaryDescriptor,
        pathThreadChannel: secondaryChannel,
        primaryChannelKind: channelKindForView,
        primaryChannelTitle: selectedChannel?.title ?? null,
        primaryWorkspaceId: selectedWorkspaceId,
      }),
    [
      secondaryDescriptor,
      secondaryChannel,
      channelKindForView,
      selectedChannel,
      selectedWorkspaceId,
    ],
  );
  const secondaryConversationDescriptor = secondaryViewInputs.conversationDescriptor;

  // PR-2: secondary pane's archive callback. When the secondary pane
  // is a cross-workspace `?side` resolved descriptor, the mutation's
  // invalidation must target the *foreign* workspace's channels list,
  // not the primary's. `secondaryViewInputs.archiveWorkspaceId` carries
  // the right workspace id for both `?side` (foreign or same) and
  // legacy `/t/<tid>` (always same-workspace) sources.
  const handleArchiveSecondaryChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      const wid =
        secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      archiveChannel.mutate({ channelId, archived, workspaceId: wid });
    },
    [archiveChannel, secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  // Same for the per-pane jumpTarget — the inline ternary recreated the
  // object each render, breaking memoization down the tree. The
  // secondary jumpTarget matches when the jump's threadId equals the
  // secondary pane's id (legacy "jump to thread" lands here).
  const parentJumpTarget = useMemo(
    () =>
      jumpTarget &&
      !jumpTarget.threadId &&
      !jumpTarget.threadRootId &&
      jumpTarget.channelId === selectedChannelId
        ? { channelId: jumpTarget.channelId, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, selectedChannelId],
  );
  const secondaryJumpTarget = useMemo(
    () =>
      jumpTarget && secondaryConversationDescriptor && jumpTarget.threadId === secondaryConversationDescriptor.id
        ? { channelId: secondaryConversationDescriptor.id, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, secondaryConversationDescriptor],
  );
  // Reply-cluster jump: the message is in the channel but the user asked to
  // land inside the cluster pane. Matches when the jump carries a
  // `threadRootId` for the cluster currently open in the secondary pane.
  // ThreadPanel scroll-locates `messageId`; `handleJumped` clears it.
  const clusterJumpMessageId = useMemo(
    () =>
      jumpTarget &&
      jumpTarget.threadRootId &&
      jumpTarget.threadRootId === clusterRootId &&
      jumpTarget.channelId === selectedChannelId
        ? jumpTarget.messageId
        : null,
    [jumpTarget, clusterRootId, selectedChannelId],
  );

  // Per-pane pending is derived from the controller's active
  // `(conversationId, messageId)` pair. The App should not expose the
  // attempt token to layout code — it is only a stale-prime guard.
  const parentJumpPrimePending = useMemo(
    () =>
      parentJumpTarget !== null &&
      isPrimePendingFor(parentJumpTarget.channelId, parentJumpTarget.messageId),
    [isPrimePendingFor, parentJumpTarget],
  );
  const secondaryJumpPrimePending = useMemo(
    () =>
      secondaryJumpTarget !== null &&
      isPrimePendingFor(
        secondaryJumpTarget.channelId,
        secondaryJumpTarget.messageId,
      ),
    [isPrimePendingFor, secondaryJumpTarget],
  );

  // Parent-message highlight only renders alongside an open thread
  // (channel-typed sides aren't anchored to a parent message). Side
  // threads from PR-3 sigil clicks will fire `onThreadAnchorResolved`
  // with their own anchor, so the highlight follows them too.
  const highlightedMessageIdForParent =
    secondaryViewInputs.isThread ? highlightedParentMessageId : null;

  const parentView = (
    <ChannelView
      channelKind={channelKindForView}
      conversation={parentDescriptor}
      parentTitle={parentChannel?.title ?? null}
      jumpTarget={parentJumpTarget}
      jumpPrimePending={parentJumpPrimePending}
      onJumped={handleJumped}
      onOpenThread={nav.openCluster}
      highlightedMessageId={highlightedMessageIdForParent}
      onArchiveChannel={handleArchiveChannelMutation}
      archivePending={archiveChannel.isPending}
      conversationRefsById={conversationRefsById}
      onOpenConversationRef={nav.openSide}
      onOpenChannelRef={handleOpenChannelByName}
      onOpenTask={handleOpenTask}
    />
  );

  // Secondary pane render. PR-2 shapes:
  //   - Resolved channel/thread (same- or cross-workspace) → real
  //     ChannelView. Thread-only props (`onJumpToOriginal`,
  //     `onThreadAnchorResolved`, `parentTitle`) gate on
  //     `secondaryIsThread`. The conversation descriptor's
  //     `workspace_id` carries the *foreign* workspace for cross-
  //     workspace `?side`, so ChannelView's workspace-scoped hooks
  //     auto-target the right cache without a separate prop.
  //   - Loading / unauthorized / not_found (`?side` ref hook didn't
  //     return a usable conversation) → SidePlaceholder (the renamed
  //     PR-1 component now keyed on the three non-resolved statuses).
  //   - null → no secondary, render only `parentView`.
  let secondaryView: JSX.Element | null = null;
  if (secondaryDescriptor) {
    if (
      secondaryDescriptor.source === 'side' &&
      secondaryDescriptor.status !== 'resolved'
    ) {
      secondaryView = (
        <SideUnresolvedPlaceholder
          conversationId={secondaryDescriptor.id}
          status={secondaryDescriptor.status}
          onClose={closeSecondary}
        />
      );
    } else if (secondaryConversationDescriptor) {
      secondaryView = (
        <ChannelView
          channelKind={secondaryViewInputs.channelKind}
          conversation={secondaryConversationDescriptor}
          parentTitle={secondaryViewInputs.parentTitle}
          jumpTarget={secondaryJumpTarget}
          jumpPrimePending={secondaryJumpPrimePending}
          onJumped={handleJumped}
          onCloseChild={closeSecondary}
          // Cindy review of e9278a7 bug 2: previously hard-coded
          // "关闭 Thread", which read wrong on `?side=<channel>" panes.
          // Side-thread (legacy /t/ or `?side=<thread>`) keeps the old
          // wording; channel/dm sides use a generic "关闭侧栏".
          closeLabel={secondaryViewInputs.isThread ? '关闭 Thread' : '关闭侧栏'}
          onJumpToOriginal={
            secondaryViewInputs.isThread ? handleJumpToOriginal : undefined
          }
          onThreadAnchorResolved={
            secondaryViewInputs.isThread ? setHighlightedParentMessageId : undefined
          }
          onToggleFullscreen={
            secondarySupportsFullscreenToggle
              ? handleToggleFullscreen
              : undefined
          }
          isFullscreen={
            secondarySupportsFullscreenToggle ? threadFullscreen : false
          }
          // PR-2: cross-workspace archive invalidation — the secondary
          // pane uses a dedicated callback so the React Query
          // invalidation targets the foreign workspace's channels list,
          // not the primary's.
          onArchiveChannel={handleArchiveSecondaryChannelMutation}
          archivePending={archiveChannel.isPending}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={nav.openSide}
          onOpenChannelRef={handleOpenChannelByName}
          onOpenTask={handleOpenTask}
          // No thread open from the secondary pane: a reply cluster shares
          // its parent channel's context, so opening a thread only makes
          // sense from the primary channel pane. Undefined hides the reply
          // affordance on side/legacy-thread secondary panes.
          onOpenThread={undefined}
        />
      );
    }
  } else if (clusterRootId && selectedChannelId && selectedWorkspaceId) {
    // Reply-cluster pane (`?cluster=<rootMessageId>`). A cluster is NOT a
    // conversation — it shares the parent channel's context — so it does
    // not flow through `secondaryDescriptor`/`ChannelView`. It renders
    // only when no side/thread secondary is present (those win), matching
    // the nav-layer mutual exclusion (`openCluster` clears `?side`).
    //
    // Captured into consts so the `onViewInChannel` closure keeps the
    // narrowed non-null types (TS widens branch-narrowed `let`s back to
    // nullable inside a deferred callback).
    const clusterChannelId = selectedChannelId;
    const clusterWorkspaceId = selectedWorkspaceId;
    const clusterRoot = clusterRootId;
    secondaryView = (
      <ThreadPanel
        channelId={clusterChannelId}
        workspaceId={clusterWorkspaceId}
        rootMessageId={clusterRoot}
        parentTitle={selectedChannel?.title ?? null}
        closed={parentDescriptor?.closed_at != null}
        archived={parentDescriptor?.archived_at != null}
        onClose={nav.closeCluster}
        onViewInChannel={() => {
          // Scroll-locate + flash the root in the main channel stream,
          // then drop the cluster pane so the channel is unobstructed.
          requestJump({
            workspaceId: clusterWorkspaceId,
            channelId: clusterChannelId,
            threadId: null,
            messageId: clusterRoot,
          });
          nav.closeCluster();
        }}
        // Same inline-ref resolution + nav handlers the channel pane
        // gets, so thread replies render `#conv:` / `#<channel>` /
        // `#task:` sigils identically (#task:1052).
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={nav.openSide}
        onOpenChannelRef={handleOpenChannelByName}
        onOpenTask={handleOpenTask}
        jumpMessageId={clusterJumpMessageId}
        onJumped={handleJumped}
      />
    );
  }

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
          // Frame layer. `backgroundColor` paints the frame fill; the
          // separate `backgroundImage` lets a theme overlay a texture
          // (forza6 = translucent triangles) without disturbing the
          // color. Other themes resolve `--bg-pattern-image` to `none`,
          // so this write is universal-but-inert outside forza6 — see
          // `docs/design-new-theme.md` §3.1.3.
          backgroundColor: 'var(--bg-app, transparent)',
          backgroundImage: 'var(--bg-pattern-image, none)',
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
              data-sidebar="members"
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
                  selectedUserId={selectedUserId}
                  onSelectUser={id => nav.toMembersUser(id)}
                />
              </nav>
            </aside>
            {selectedUserId ? (
              <HumanView
                key={selectedUserId}
                userId={selectedUserId}
                onUnreachable={() => nav.toMembers()}
              />
            ) : selectedAgentId ? (
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
              data-sidebar="computers"
              className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]"
              style={{
                borderRadius: 'var(--card-radius, 0)',
                boxShadow: 'var(--card-shadow, none)',
                overflow: 'hidden',
              }}
            >
              <nav className="flex-1 overflow-y-auto py-1.5">
                <ComputersPanel
                  hosts={computerHosts}
                  localHostId={localHostIdForComputers}
                  localAttached={localHostAttached}
                  isLoading={hostsQuery.isLoading}
                  selectedHostId={selectedHostId}
                  onSelectHost={setSelectedHostId}
                />
              </nav>
            </aside>
            {selectedHost ? (
              <HostDetailView
                key={selectedHost.id}
                host={selectedHost}
                localHostId={localHostIdForComputers}
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
                {hostsQuery.isLoading
                  ? 'Loading computers…'
                  : '选一台 computer 看详情'}
              </main>
            )}
          </>
        ) : (
          <>
            <div
              className="sidebar-slot"
              data-animating={workspaceSidebarPane.transitioning ? 'true' : undefined}
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
                      workspace_host_id: w.workspace_host_id,
                      dm_agent_id: w.dm_agent_id,
                      unread: messageUnreadSummary?.by_workspace?.[w.id] ?? 0,
                      pinned_at: w.pinned_at,
                      archived: w.archived_at !== null,
                    }))}
                    agentsById={agentsById}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={handleSelectWorkspace}
                    onPinWorkspace={(workspaceId, pinned) =>
                      pinWorkspace.mutate({ id: workspaceId, pinned })
                    }
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
              <SavedListView
                onJump={params =>
                  handleJumpToMessage(params, {
                    threadFullscreen: !!params.threadId,
                  })
                }
              />
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
                  data-animating={channelSidebarPane.transitioning ? 'true' : undefined}
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
                        // PR-2: highlight the secondary pane's row in
                        // the sidebar ONLY when the secondary lives in
                        // the currently selected workspace. Cross-
                        // workspace `?side` ids (different workspace
                        // than the primary's sidebar shows) leave the
                        // primary's row highlighted instead — otherwise
                        // we'd ghost-highlight a row that doesn't exist
                        // in this sidebar, or worse, highlight a
                        // same-id-different-workspace row.
                        selectedChannelId={
                          secondaryDescriptor?.status === 'resolved' &&
                          secondaryDescriptor.workspaceId === selectedWorkspaceId
                            ? secondaryDescriptor.id
                            : selectedChannelId
                        }
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
                {secondaryView &&
                shouldSecondaryFullscreen(secondaryDescriptor, routeFullscreen) ? (
                  secondaryView
                ) : (
                  <SplitPane
                    left={parentView}
                    right={secondaryView}
                    storageKey="silverhand.layout.split-ratio"
                  />
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
            kind: s.kind,
            parent_channel_id:
              s.kind === 'thread' ? s.parent_conversation_id : null,
            closed_at: s.closed_at,
            created_at: s.created_at,
          }))}
          defaultConversationId={selectedChannelId}
          focusedTaskNumber={focusedTaskNumber}
          onClearFocus={nav.closeTask}
          onJumpToMessage={params => handleJumpToMessage(params)}
        />
      ) : null}
      <Toaster position="bottom-right" richColors />

      {/* D4.a Commit 6 (4) — mid-session "Can't reach server" banner.
        * Mounted INSIDE the registered shell on purpose: boot-time
        * unreachability is the BackendUnreachableGate's job (full-
        * screen, App-root level); this banner only fires after the
        * user got past the boot gate and a subsequent query/mutation
        * threw ApiError.kind === 'backend_unreachable'.
        *
        * Renders nothing when no recent backend_unreachable error
        * has fired since the last clear. Owns its own click target
        * + retry handler — see useBackendUnreachableSnitch. */}
      <BackendUnreachableBanner />

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
