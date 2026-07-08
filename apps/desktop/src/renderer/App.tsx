import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { Toaster } from 'sonner';
import { NavRail, deriveNavRailDots } from '@/components/layout/NavRail';
import { ComputersPanel } from '@/components/layout/ComputersPanel';
import { NewComputerDialog } from '@/features/hosts/NewComputerDialog';
import { HostDetailView } from '@/features/hosts/HostDetailView';
import {
  useBackendInfoSnapshot,
  useHostsQuery,
} from '@/features/hosts/hooks';
import { MembersPanel } from '@/components/layout/MembersPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChannelsSidebar } from '@/components/layout/ChannelsSidebar';
import { ChannelView } from '@/components/layout/ChannelView';
import { ConversationViewSkeleton } from '@/components/layout/ConversationViewSkeleton';
import { SectionLayer } from '@/components/layout/SectionLayer';
import { ThreadPanel } from '@/components/layout/ThreadPanel';
import { ChannelThreadsPanel } from '@/components/layout/ChannelThreadsPanel';
import { SavedListView, SAVED_FILTER_DEFAULT, type SavedFilterState } from '@/components/layout/SavedListView';
import { SearchPanel, SEARCH_FILTER_DEFAULT, type SearchFilterState } from '@/components/layout/SearchPanel';
import { ArchivedChannelsPanel, ARCHIVED_FILTER_DEFAULT, type ArchivedFilterState } from '@/components/layout/ArchivedChannelsPanel';
import { ActivityView } from '@/components/layout/ActivityView';
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
import { useAgents } from '@/features/agents/hooks';
import {
  useAppShellGlobalSync,
  useShutdownProgress,
  useComposerDraftCleanup,
  useDockBadge,
  useLayoutKeyboardShortcuts,
  useSettingsMenuNav,
} from '@/features/app-shell/effects';
import { useSecondaryPaneModel } from '@/features/app-shell/secondary-pane-model';
import { useSelectionPersistenceEffects } from '@/features/app-shell/selection-persistence';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  useWorkspaceSortState,
  useChannelSortState,
  useStarWorkspace,
  useStarChannel,
  useArchiveChannel,
  useRenameChannel,
  type ChannelListItem,
} from '@/features/workspaces/hooks';
import { useSavedMessages } from '@/features/saved/hooks';
import {
  useNotificationToasts,
  useUnreadCounts,
} from '@/features/notifications/hooks';
import {
  useMarkMessageChannelRead,
  useMessageUnreadCounts,
  useMessageUnreadSummary,
} from '@/features/channels/hooks';
import { useActivity } from '@/features/attention/hooks';
import {
  useMessageJumpController,
  type MessageJumpTarget,
} from '@/features/channels/useMessageJumpController';

import {
  selectSecondaryViewInputs,
  shouldSecondaryFullscreen,
} from '@/lib/secondary-pane';
import {
  buildChannelLayoutUrl,
  buildChannelPathPreservingAgent,
  layoutMemoryFromRoute,
  routes,
  useNav,
  useRouteState,
  withThreadQuery,
  type ChannelLayout,
} from '@/router';

// Per-workspace "last viewed channel" memory. The map + persistence
// helpers live in `lib/place-memory.ts` so `useLogout` can also import
// them without a circular dep on this module (multi-human audit
// 2026-06-03 #task:857 P0.7). The exports are re-exported here for
// callers that already imported them from App.
import {
  LAST_CHANNEL_KEY,
  clearPlaceMemory,
  getChannelLayout,
  getCloseWatermark,
  getLastWorkspaceId,
  lastChannelByWorkspace,
  persistLastChannel,
  recordChannelLayout,
  recordCloseWatermark,
} from '@/lib/place-memory';
export {
  LAST_CHANNEL_KEY,
  clearPlaceMemory,
};
import { resolveChannelOpen } from '@/lib/channel-open';
import { pickFallbackAfterArchive } from '@/lib/archive-fallback';
import { pickWorkspaceToRestore } from '@/lib/workspace-restore';
import { resolveRestoreNavigation } from '@/lib/restore-navigation';
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

  // Global mount-once realtime/visibility sync (5 app-scope WS consumers),
  // lifted to a hook so the shell stays a thin composition root. See
  // features/app-shell/effects.ts for the per-hook rationale.
  useAppShellGlobalSync();

  // Shutdown overlay step — null means not shutting down.
  const shutdownStep = useShutdownProgress();
  useComposerDraftCleanup();

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
  // Activity-section list width — its OWN resizable column (#task:1394,
  // shiki). Deliberately NOT the chat `--sidebar-width` rail slot: reusing it
  // would leak chat browse state into Activity (Cindy/Alice invariant #2). Its
  // own `--activity-list-width` var is the SINGLE width source — the Titlebar
  // offset reads the same var so a drag stays in sync with zero extra wiring
  // (no second computed offset). `min` guarantees a row's three lines + count
  // token stay legible when the list is a narrow column.
  const activityList = useResizableWidth({
    storageKey: 'silverhand.layout.activity-list-width',
    defaultWidth: 360,
    min: 280,
    max: 560,
    cssVar: '--activity-list-width',
  });

  const route = useRouteState();
  const nav = useNav();
  const {
    section: appSection,
    chatView: view,
    workspaceId: selectedWorkspaceId,
    channelId: selectedChannelId,
    sideConversationId,
    threadRootId,
    threadsListOpen,
    focusedTaskNumber,
    fullscreen: routeFullscreen,
    agentId: selectedAgentId,
    userId: selectedUserId,
    agentPanelId,
  } = route;
  const workspaceSidebarPane = layout.workspaceSidebar;
  const channelSidebarPane = layout.channelSidebar;
  const workspaceSidebarVisible = workspaceSidebarPane.visible;
  const channelSidebarVisible = channelSidebarPane.visible;

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newComputerOpen, setNewComputerOpen] = useState(false);
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
    primePhaseFor,
  } = useMessageJumpController();

  // Chat-only: the ⌘\ / ⌘⇧\ chords toggle the workspace/channel browse
  // sidebars, which exist only in chat. Gating on `appSection === 'chat'` keeps
  // the keyboard path on the same section boundary as the (hidden-in-activity)
  // titlebar toggles, so Activity has no browse-sidebar control path at all
  // (#task:1394, Cindy review).
  useLayoutKeyboardShortcuts(
    toggleWorkspaceSidebar,
    toggleChannelSidebar,
    appSection === 'chat',
  );

  // App menu's "Settings…" item (Cmd+,) — main process focuses the window and
  // pushes this; renderer just navigates.
  useSettingsMenuNav(nav.toSettings);

  // Per-workspace "last viewed channel" memory lives as a module
  // singleton above (persisted via localStorage). The recording effect
  // below writes through to storage on every mutation; the restore
  // effect reads from it when hydrating from a workspaceId-only URL.
  const lastSelectedAgentId = useRef<string | null>(null);
  // Same as `lastSelectedAgentId` but for the chat section: clicking the
  // "Chat" navrail item routes to bare `/chat` (no workspaceId), so on the
  // way back the auto-pick below must restore the workspace the user last had
  // open instead of snapping to `workspaces[0]`. This one is persisted so an
  // app restart can land back on a starred workspace that does not sort first
  // (#task:1222/#task:1229).
  const lastSelectedWorkspaceId = useRef<string | null>(getLastWorkspaceId());
  const lastSelectedMessageReadKey = useRef<string | null>(null);
  const lastThreadMessageReadKey = useRef<string | null>(null);
  // The channel just archived from the PRIMARY pane that cleared selection
  // to the workspace empty state (no neighbor to fall back to). The
  // auto-select effect must NOT re-pick it while the stale active list
  // still contains it (React Query invalidation hasn't refetched yet),
  // otherwise the clear is instantly undone (#task:1145). Cleared once the
  // active list no longer contains it.
  const recentlyArchivedPrimaryRef = useRef<{
    workspaceId: string;
    channelId: string;
  } | null>(null);

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
  // Activity is a GLOBAL list — it shows rows from every workspace, so it needs
  // workspace_id → identity (name + icon inputs), so a GLOBAL list (Activity)
  // can show each row's workspace icon and disambiguate same-named channels
  // across workspaces. `kind` / `dmAgentId` feed the canonical `WorkspaceIcon`
  // (regular → themed `W`, DM → bound agent avatar) — same primitive the rail
  // uses, never a hand-rolled glyph.
  const workspaceRefById = useMemo(
    () =>
      new Map(
        workspaces.map(
          w =>
            [
              w.id,
              {
                name: w.name,
                kind: w.kind === 'dm' ? ('dm' as const) : ('regular' as const),
                dmAgentId: w.dm_agent_id,
              },
            ] as const,
        ),
      ),
    [workspaces],
  );
  const { data: activeChannels = [] as ChannelListItem[], isLoading: activeChannelsLoading } = useChannelsForWorkspace(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  // Star (the personal ⭐ favorite) lives only in the viewer's sort state, not
  // on the workspace/channel DTOs (#task:1209). Join `starred_at` by id here —
  // the composition root has both the list items and the viewer sort — so the
  // sidebars keep reading a per-item `starred_at` and re-group instantly when a
  // star toggle reconciles the inline `viewerSort` cache.
  const { data: workspaceSort } = useWorkspaceSortState();
  const { data: channelSort } = useChannelSortState(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  const workspaceStarredAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of workspaceSort?.entries ?? []) {
      if (e.starred_at !== null) m.set(e.entity_id, e.starred_at);
    }
    return m;
  }, [workspaceSort]);
  const channelStarredAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of channelSort?.entries ?? []) {
      if (e.starred_at !== null) m.set(e.entity_id, e.starred_at);
    }
    return m;
  }, [channelSort]);
  const { data: archivedChannels = [] as ChannelListItem[] } = useArchivedChannelsForWorkspace(
    selectedWorkspaceId,
    selectedWorkspace?.kind ?? null,
  );
  // Union for URL/jump/search resolution. The sidebar gets active and
  // archived as separate props (so it can render the Archived group with
  // its own sort order), but anything that asks "does channel X exist in
  // this workspace" — selectedChannel lookup, jump targets, breadcrumbs —
  // needs to consider both. (The tasks drawer is NOT here: its channel
  // filter is sourced from activeChannels, same as the task pane.)
  const channels = useMemo<ChannelListItem[]>(
    () => [...activeChannels, ...archivedChannels],
    [activeChannels, archivedChannels],
  );
  const starWorkspace = useStarWorkspace();
  const starChannel = useStarChannel(selectedWorkspaceId ?? null);
  const archiveChannel = useArchiveChannel(selectedWorkspaceId ?? null);
  const renameChannel = useRenameChannel(selectedWorkspaceId ?? null);
  // Shared cache with SavedListView and useToggleSave — invalidations
  // from save/unsave mutations propagate the count update here too.
  const { data: savedItems } = useSavedMessages();
  // Saved-view filter selection lives here (not inside SavedListView) so it
  // survives switching to another pane and back for the app session
  // (shiki #task:1258 follow-up). Deliberately not persisted — a restart
  // resets to the default so a stale ad-hoc filter never lingers.
  const [savedFilter, setSavedFilter] = useState<SavedFilterState>(SAVED_FILTER_DEFAULT);
  // Search / Archived filter selections are App-owned session state too
  // (#task:1259), same rationale as savedFilter: survive pane switches, not
  // persisted across restart. Search's query text stays panel-local.
  const [searchFilter, setSearchFilter] = useState<SearchFilterState>(SEARCH_FILTER_DEFAULT);
  // Inline header find → advanced SearchPanel handoff (#task:1335). Carries the
  // query (via `?q=` route prefill) AND scopes the advanced panel to the source
  // conversation's workspace by seeding the App-owned workspace filter — so the
  // handoff actually lands in the filter, not just the URL.
  const handleOpenAdvancedSearch = useCallback(
    (query: string, workspaceId?: string) => {
      if (workspaceId) {
        setSearchFilter(f => ({ ...f, workspace: `workspace:${workspaceId}` }));
      }
      nav.toChatSearch(query);
    },
    [nav],
  );
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilterState>(ARCHIVED_FILTER_DEFAULT);
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

  // ── Nav-rail attention dots (#task:1408) ───────────────────────────────
  // A single no-count dot per rail section that has new content, derived from
  // the existing viewer read-models (zero new query/state). Chat = any unread
  // in the message-unread summary (archived already excluded at source by the
  // rollup, #1403-A — no re-filter here). Activity = the unattended-items list
  // is non-empty (observe drops handled items, so a non-empty list *is* "has
  // new"). Both clear naturally as the section's content is observed.
  const { data: activityData } = useActivity();
  const navRailDots = deriveNavRailDots({
    workspaceUnread: messageUnreadSummary?.by_workspace,
    activityItemCount: activityData?.items.length,
  });

  // ── Dock badge sync ────────────────────────────────────────────────────
  // macOS dock icon shows total unread messages across every workspace.
  useDockBadge(messageUnreadSummary);

  // ── Secondary pane state ──────────────────────────────────────────────
  // Resolves `?side=<id>` into the descriptor + visible/focused conversation
  // pointers. See features/app-shell/secondary-pane-model.ts.
  const { secondaryDescriptor, visibleConversations, focusedConversation } =
    useSecondaryPaneModel({
      selectedChannelId,
      channels,
      sideConversationId,
      selectedWorkspaceId,
      routeFullscreen,
    });
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

  // Auto-select a workspace when chat is open without a workspace id.
  // Restore the one the user last had open (clicking the "Chat" navrail item
  // routes to bare `/chat`, dropping the workspaceId), falling back to the
  // first workspace only on a cold start (#task:1222).
  // Replace so the bare /chat URL doesn't pile up in history.
  useEffect(() => {
    if (appSection !== 'chat' || view !== 'channel') return;
    if (selectedWorkspaceId) return;
    if (workspaces.length === 0) return;
    const target = pickWorkspaceToRestore(
      workspaces,
      lastSelectedWorkspaceId.current,
    );
    if (target) nav.go(`/chat/w/${target}`, { replace: true });
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
    // Chat-only: this restore drives `/chat/w/.../c/...` paths. The Activity
    // section is a peer navigator whose right pane stays empty until the user
    // picks a row (no auto-select) — restoring a channel here would hijack
    // `/activity/...` back into chat (#task:1394).
    if (appSection !== 'chat') return;
    if (!selectedWorkspaceId) return;
    // The precedence (honored jump > remembered-channel open > default
    // fallback) lives in the pure `resolveRestoreNavigation`; this effect only
    // reads the current ref / place-memory / unread state and executes the
    // returned action. A channel just archived from the primary pane that
    // cleared selection is excluded from BOTH the remembered and fallback
    // branch — the stale lists can still contain it until the query
    // invalidation lands, and re-selecting it would undo the clear
    // (#task:1145). Scoped to the same workspace the archive happened in.
    const excludeId =
      recentlyArchivedPrimaryRef.current?.workspaceId === selectedWorkspaceId
        ? recentlyArchivedPrimaryRef.current.channelId
        : null;
    // On the restore path the remembered channel's unread pointer is consulted
    // best-effort — if the workspace's unread data hasn't loaded yet it
    // degrades to layout memory rather than waiting (#task:1082).
    const rememberedChannelId =
      lastChannelByWorkspace.get(selectedWorkspaceId) ?? null;
    const action = resolveRestoreNavigation({
      workspaceId: selectedWorkspaceId,
      selectedChannelId,
      channels,
      activeTopLevel: activeChannels,
      jumpTargetChannelId: jumpTarget?.channelId ?? null,
      excludeId,
      rememberedChannelId,
      rememberedUnreadPointer: rememberedChannelId
        ? messageUnreadData?.latest_by_conversation?.[rememberedChannelId]
        : undefined,
      rememberedCloseWatermark: rememberedChannelId
        ? getCloseWatermark(rememberedChannelId)
        : null,
      rememberedLayout: rememberedChannelId
        ? getChannelLayout(rememberedChannelId)
        : null,
    });
    switch (action.kind) {
      case 'none':
        return;
      case 'open-channel':
        nav.go(`/chat/w/${selectedWorkspaceId}/c/${action.channelId}`, {
          replace: true,
        });
        return;
      case 'open-remembered':
        nav.go(
          buildChannelLayoutUrl(selectedWorkspaceId, action.channelId, action.layout),
          { replace: true },
        );
        return;
      case 'jump-unread':
        handleJumpToMessage({
          channelId: action.channelId,
          messageId: action.messageId,
          threadRootId: action.threadRootId,
          workspaceId: selectedWorkspaceId,
        });
        return;
    }
  }, [
    appSection,
    selectedWorkspaceId,
    selectedChannelId,
    channels,
    activeChannels,
    jumpTarget,
    nav.go,
  ]);

  // Release the recently-archived exclusion once the active list no longer
  // contains it (the archive invalidation has refetched) — from then on the
  // id is genuinely gone and the auto-select effect needs no special-casing
  // (#task:1145).
  useEffect(() => {
    const rec = recentlyArchivedPrimaryRef.current;
    if (rec && !activeChannels.some(c => c.id === rec.channelId)) {
      recentlyArchivedPrimaryRef.current = null;
    }
  }, [activeChannels]);

  // Selection-persistence side-effects (#task:1295): last-viewed-channel
  // memory, recent-opened sort stamps (channel + workspace rail), and the
  // members/chat last-selected memory. Byte-for-byte the same effects, lifted
  // into a hook so `App` stays a thinner composition root; the high-risk
  // restore / auto-select / layout-watermark effects deliberately stay inline.
  useSelectionPersistenceEffects({
    selectedWorkspaceId,
    selectedChannelId,
    selectedAgentId,
    activeChannels,
    workspaces,
    agents,
    lastSelectedWorkspaceId,
    lastSelectedAgentId,
  });

  // Remember the channel's secondary-pane layout (threads-list / thread /
  // side / none) so switching away and back restores it instead of
  // dropping to a bare channel. Explicitly closing the pane records
  // `none`, so a deliberate close survives re-entry too. Keyed by
  // channel — the restore happens at the channel-switch nav sites
  // (`handleSelectChannel` + the last-channel restore effect) which read
  // `getChannelLayout`. `recordChannelLayout` dedupes, so this fires
  // cheaply on every route change.
  //
  // Explicit-close watermark (#task:1082): when the user collapses a
  // channel's secondary pane to `none` *within the same channel* (not via
  // a channel switch), stamp the unread pointer's seq so the just-closed
  // unread thread isn't immediately re-surfaced on re-entry. A channel
  // switch is excluded by comparing against the previous render's channel.
  const prevLayoutRef = useRef<{
    channelId: string;
    kind: ChannelLayout['kind'];
  } | null>(null);
  useEffect(() => {
    if (!selectedChannelId) {
      prevLayoutRef.current = null;
      return;
    }
    const layout = layoutMemoryFromRoute({
      sideConversationId,
      threadRootId,
      threadsListOpen,
    });
    recordChannelLayout(selectedChannelId, layout);
    const prev = prevLayoutRef.current;
    if (
      prev &&
      prev.channelId === selectedChannelId &&
      prev.kind !== 'none' &&
      layout.kind === 'none'
    ) {
      const seq =
        messageUnreadData?.latest_by_conversation?.[selectedChannelId]?.seq;
      if (seq != null) recordCloseWatermark(selectedChannelId, seq);
    }
    prevLayoutRef.current = { channelId: selectedChannelId, kind: layout.kind };
  }, [
    selectedChannelId,
    sideConversationId,
    threadRootId,
    threadsListOpen,
    messageUnreadData,
  ]);

  // Members panel defaults to a concrete agent: restore the last selected one
  // for this app run, or fall back to the first agent in the list.
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
  // The COMPUTERS rail derives each row's availability (including the
  // app-managed local computer) from the per-host status query inside
  // `ComputerRow`, the SAME predicate the detail-view pill uses — so no
  // local-only attach probe is threaded here anymore (that fork read as
  // an inconsistency: the local row had a pip, user-added rows didn't).
  // Liveness is push-based via host-connection-sync, so no polling.
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

  const selectedChannel = channels.find(s => s.id === selectedChannelId) ?? null;
  // Decouple the heavy PRIMARY pane (ChannelView + message list) from the cheap
  // sidebar highlight (#task:1162). Selecting a channel re-renders ChannelView
  // with a new conversation, which tears down the old message list (~hundreds of
  // nodes) and renders the new one — a ~460ms synchronous reconcile (CDP-measured
  // in dev) that, sharing the click's commit, blocked the row-highlight paint by
  // the same ~460ms. `useDeferredValue` lets the urgent commit update only the
  // sidebar's `selectedChannelId` (instant highlight) while ChannelView keeps the
  // STILL-stale deferred descriptor and short-circuits via its `memo`; the heavy
  // teardown/rebuild then runs in a low-priority pass AFTER the highlight paints.
  // Everything else (touch/mark-read effects, thread panels) stays on the urgent
  // `selectedChannelId`; only the primary view's descriptor + jump target defer.
  const deferredChannelId = useDeferredValue(selectedChannelId);
  const deferredSelectedChannel =
    channels.find(s => s.id === deferredChannelId) ?? null;
  // A channel IS selected in the route but its descriptor hasn't resolved yet
  // and its workspace's channel list is still loading — the transient window on
  // a cross-workspace jump (e.g. Activity "back to source"). Lets the primary
  // pane show a loader instead of the "select a channel" empty state (#1269).
  const parentChannelResolving =
    deferredChannelId != null &&
    deferredSelectedChannel == null &&
    activeChannelsLoading;
  // Same decoupling at the TOP-LEVEL view axis (#task:1168). The NavRail
  // highlight reads urgent `appSection` (instant), while the heavy main-view
  // branch (TasksSection's cross-workspace fetch + 5-column kanban, Settings,
  // members/computers detail) renders off `deferredSection` — so clicking the
  // Tasks rail paints the highlight first and the board mounts in a low-
  // priority pass AFTER, instead of jamming both into one commit. Only the
  // BRANCH SELECTION defers; effect guards, focus targets, and titlebar
  // callbacks (lines ~506/713/838/1407/1707) stay on urgent `appSection` so
  // they reflect the true target section. Cross-section switches are the only
  // thing affected — channel↔channel stays 'chat' so `deferredChannelId`
  // alone governs it.
  //
  // #task:1170 refines this for the chat section specifically: chat's cheap
  // shell (the two sidebars + splitters) is lifted onto urgent `appSection` so
  // a rail click paints it instantly, while only the heavy conversation pane
  // stays gated on `deferredSection`. See the section-render block below for the
  // full mount-vs-visibility split.
  const deferredSection = useDeferredValue(appSection);
  const conversationRefsById = useMemo(() => {
    const m = new Map<string, ConversationReference>();
    for (const item of channels) {
      m.set(item.id, {
        id: item.id,
        kind: item.kind,
        title: item.title,
      });
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
    (appSection === 'chat' && view === 'channel') || appSection === 'activity'
      ? focusedConversation
      : null;
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
    const readKey = visiblePrimary.id;
    if (lastSelectedMessageReadKey.current === readKey) return;
    lastSelectedMessageReadKey.current = readKey;
    markMessageChannelRead.mutate(visiblePrimary.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePrimary?.id, visiblePrimary?.kind]);
  useEffect(() => {
    if (!visibleSecondary) {
      lastThreadMessageReadKey.current = null;
      return;
    }
    const readKey = visibleSecondary.id;
    if (lastThreadMessageReadKey.current === readKey) return;
    lastThreadMessageReadKey.current = readKey;
    markMessageChannelRead.mutate(visibleSecondary.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSecondary?.id, visibleSecondary?.kind]);

  // NOTE: conversation FOCUS no longer drains notification badges. Focus is a
  // passive surface (the user is merely looking at a channel, not acting on a
  // specific message), so per the surfaced≠eliminated invariant it must not
  // write `notifications.read_at` for ANY directed kind — doing so silently
  // evicted cursor-unread @me mentions from Activity. Anchored `mention_self`
  // clears via visible-read observe (cursor crossing its seq); anchorless
  // `agent_start_failed` clears only via its explicit paths (Activity ✓ /
  // clicking the notification). Under the #task:1394 Activity rail, an Activity
  // row's on-click / hover-✓ is the active eliminate intent (it clears through
  // `activityItemSource` in ActivityView), so no shell effect drains here.

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

  // Open a channel WITH the home channel-sidebar's full open semantics —
  // remembered layout (threads-list / thread / side) restore, unread-thread
  // auto-surface. `workspaceId` defaults to the
  // primary selection (the channel sidebar's same-workspace case) but is passed
  // EXPLICITLY by cross-workspace entry points (the global STARRED list), so a
  // starred channel in another workspace opens with the SAME restored layout
  // instead of a bare jump. STARRED owns presence + order, never a second
  // navigation model (docs/list-sort-v1.md) — it delegates the open here.
  const handleSelectChannel = (
    id: string,
    workspaceId: string | null = selectedWorkspaceId,
  ): void => {
    if (!workspaceId) return;
    const sameWorkspace = workspaceId === selectedWorkspaceId;
    // A=Activity-follows-channel (#task:1189): while an agent side panel is
    // docked it owns the right pane, so switching the left channel must keep
    // `?agent` and just re-point the locked Activity context — not restore that
    // channel's remembered thread/side (which would drop the panel). Only
    // same-workspace: a cross-workspace open switches workspace anyway and the
    // docked agent panel can't follow it.
    if (sameWorkspace && agentPanelId) {
      nav.go(
        buildChannelPathPreservingAgent(workspaceId, id, agentPanelId),
      );
      return;
    }
    // Read cursors are advanced by the navigation effects above. Keeping
    // this handler side-effect free avoids duplicate mark-read/refetch storms.
    // Channel-open precedence (#task:1082): a fresh unread reply in one
    // of this channel's threads (newer than the explicit-close
    // watermark) auto-surfaces that thread; otherwise restore the
    // remembered secondary-pane layout (threads-list / thread / side),
    // and `none`/absent memory yields the bare channel path.
    const intent = resolveChannelOpen(
      messageUnreadData?.latest_by_conversation?.[id],
      getCloseWatermark(id),
      getChannelLayout(id),
    );
    if (intent.kind === 'unread-thread') {
      handleJumpToMessage({
        channelId: id,
        messageId: intent.messageId,
        threadRootId: intent.threadRootId,
        workspaceId,
      });
    } else {
      nav.go(buildChannelLayoutUrl(workspaceId, id, intent.layout));
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
      // Preserve the docked agent panel across a `#<channel>` jump too, so A
      // stays consistent: clicking a channel ref re-points the panel's Activity
      // context instead of closing it (#task:1189).
      if (agentPanelId) {
        nav.go(
          buildChannelPathPreservingAgent(workspaceId, channelId, agentPanelId),
        );
        return;
      }
      nav.toChannel(workspaceId, channelId);
    },
    [agentPanelId, nav.go, nav.toChannel],
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

  const handleJumpToMessage = (params: MessageJumpTarget): void => {
    requestJump(params);
    // Inline channel find (#task:1335): a main-stream ensure-visible on the
    // ALREADY-open channel. `requestJump` above primes + scroll-locates; running
    // the route navigation below would drop the `?thread` query and collapse an
    // open thread side panel (shiki/Cindy). The channel is already selected (the
    // find bar lives in it), so no nav is needed. Fail-closed on `!threadRootId`
    // so the flag can ONLY skip nav for a main-channel target — a thread target
    // that mistakenly carries it still runs `withThreadQuery` below (Cindy).
    if (params.preserveSidePanel && !params.threadRootId) return;
    const wid = resolveNavWorkspaceId(params.workspaceId, params.channelId);
    if (!wid) return;
    // Section-aware base path: an Activity-list jump stays in `/activity/...`
    // (the channel/thread panes are the SAME components, just under the
    // activity route so the workspace axis + titlebar switch with the
    // selection); every other section lands in chat (#task:1394).
    const channelPath =
      appSection === 'activity' ? routes.activityChannel : routes.chatChannel;
    // Reply-cluster target (new model): the message lives in the parent
    // channel; open the cluster pane to its root and let ThreadPanel
    // scroll-locate the message (requestJump already primed the channel).
    // Navigate channel + `?thread` atomically — a `toChannel` then
    // `openThread` would build the thread query off the pre-navigation
    // location and drop it.
    if (params.threadRootId) {
      nav.go(
        withThreadQuery(
          channelPath(wid, params.channelId),
          '',
          params.threadRootId,
        ),
      );
    } else {
      nav.go(channelPath(wid, params.channelId));
    }
  };

  // Stable identity for TasksSection's onJump so `React.memo(TasksSection)`
  // can bail out when App re-renders for unrelated reasons. Load-bearing on
  // the deferred-section path (#task:1168): while LEAVING Tasks, the urgent
  // pass still reads `deferredSection === 'tasks'`, so TasksSection stays
  // mounted for one commit — and this agent-heavy app fires frequent
  // SSE-driven App re-renders, each of which would otherwise re-render all
  // ~1356 cards at high priority and repeatedly restart the low-priority
  // switch-to-chat transition (Alice CDP: 3.5s on-screen freeze). A
  // ref-backed callback gives a stable identity without the stale-closure
  // risk of useCallback-wrapping the big handler below. Mirrors the stable
  // refs ChannelView relies on for the same reason (L1068).
  const jumpToMessageRef = useRef(handleJumpToMessage);
  jumpToMessageRef.current = handleJumpToMessage;
  const handleJumpToMessageStable = useCallback(
    (params: MessageJumpTarget) => jumpToMessageRef.current(params),
    [],
  );

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
            closed_at: s.closed_at,
            archived_at: s.archived_at,
            workspace_id: s.workspace_id,
          }
        : null,
    [],
  );

  // Close handler for the secondary pane's X button. The only secondary
  // source is the `?side` overlay, so closing always clears the query
  // and leaves the base path untouched.
  const closeSecondary = useCallback((): void => {
    nav.closeSide();
  }, [nav.closeSide]);

  // ── Stable refs for ChannelView (so React.memo can short-circuit when
  //    only sidebar visibility flips). Recompute deliberately when the
  //    underlying nav / channel / mutation identity changes. ──────────────
  const handleJumped = useCallback(() => {
    clearJump();
  }, [clearJump]);

  const handleArchiveChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      // Only when archiving the channel currently in the PRIMARY pane do we
      // move selection — otherwise the primary would be left pointing at a
      // now-archived conversation (#task:1145). Archiving from the secondary
      // pane / restoring don't reach here (separate handlers), so they never
      // steal primary selection.
      const movesPrimary = archived && channelId === selectedChannelId;
      archiveChannel.mutate(
        {
          channelId,
          archived,
          workspaceId: selectedWorkspaceId ?? undefined,
        },
        movesPrimary
          ? {
              onSuccess: () => {
                const wid = selectedWorkspaceId;
                if (!wid) return;
                // `activeChannels` here still includes the just-archived
                // channel (the list invalidation hasn't landed yet), which is
                // exactly what the neighbor-aware picker needs to find its
                // siblings.
                const fallbackId = pickFallbackAfterArchive(activeChannels, channelId);
                if (fallbackId) {
                  nav.toChannel(wid, fallbackId);
                  return;
                }
                // No active top-level channel remains → clear to the
                // workspace empty state. Two guards are needed because the
                // archive invalidation hasn't refetched yet, so the stale
                // active/`channels` lists still contain the just-archived
                // row: (1) drop the remembered channel so the auto-select
                // effect's *remembered* branch can't restore it; (2) record
                // it in `recentlyArchivedPrimaryRef` so the effect's
                // *fallback* branch also excludes it (#task:1145).
                recentlyArchivedPrimaryRef.current = {
                  workspaceId: wid,
                  channelId,
                };
                lastChannelByWorkspace.delete(wid);
                persistLastChannel();
                nav.toWorkspace(wid);
              },
            }
          : undefined,
      );
    },
    [
      archiveChannel,
      selectedWorkspaceId,
      selectedChannelId,
      activeChannels,
      nav.toChannel,
      nav.toWorkspace,
    ],
  );

  // Async so ChannelView's rename dialog can await success/failure and
  // surface a save error inline (mutateAsync rejects on 403 / 400).
  const handleRenameChannelMutation = useCallback(
    async (channelId: string, title: string) => {
      await renameChannel.mutateAsync({
        channelId,
        title,
        workspaceId: selectedWorkspaceId ?? undefined,
      });
    },
    [renameChannel, selectedWorkspaceId],
  );

  // Memoize the descriptor objects so ChannelView's `conversation` prop keeps a
  // stable identity unless the underlying channel actually changes.
  // Urgent descriptor for NON-primary consumers (the thread panel) — tracks the
  // live selection with no defer, so closed/archived can't lag behind the
  // panel's urgent title/id (#task:1162: ONLY the heavy primary pane defers).
  const selectedChannelDescriptor = useMemo(
    () => buildChannelDescriptor(selectedChannel),
    [buildChannelDescriptor, selectedChannel],
  );
  // Deferred descriptor — feeds ONLY the heavy primary ChannelView (+ its jump
  // target / header toggle) so a channel switch can't block the highlight commit.
  const deferredParentDescriptor = useMemo(
    () => buildChannelDescriptor(deferredSelectedChannel),
    [buildChannelDescriptor, deferredSelectedChannel],
  );
  const channelKindForView = selectedWorkspace?.kind === 'dm'
    ? 'dm'
    : (selectedWorkspace ? 'regular' : null);
  // Single pure mapping from `secondaryDescriptor` into the props
  // ChannelView consumes for the secondary pane. Keeps the cross-workspace
  // wiring (foreign workspace_id / workspace_kind / archive invalidation
  // target) end-to-end testable without renderHook.
  const secondaryViewInputs = useMemo(
    () =>
      selectSecondaryViewInputs({
        secondary: secondaryDescriptor,
        primaryChannelKind: channelKindForView,
        primaryWorkspaceId: selectedWorkspaceId,
      }),
    [secondaryDescriptor, channelKindForView, selectedWorkspaceId],
  );
  const secondaryConversationDescriptor = secondaryViewInputs.conversationDescriptor;

  // PR-2: secondary pane's archive callback. When the secondary pane
  // is a cross-workspace `?side` resolved descriptor, the mutation's
  // invalidation must target the *foreign* workspace's channels list,
  // not the primary's. `secondaryViewInputs.archiveWorkspaceId` carries
  // the right workspace id for both foreign and same-workspace `?side`.
  const handleArchiveSecondaryChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      const wid =
        secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      archiveChannel.mutate({ channelId, archived, workspaceId: wid });
    },
    [archiveChannel, secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  const handleRenameSecondaryChannelMutation = useCallback(
    async (channelId: string, title: string) => {
      const wid =
        secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      await renameChannel.mutateAsync({ channelId, title, workspaceId: wid });
    },
    [renameChannel, secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  // Same for the per-pane jumpTarget — the inline ternary recreated the
  // object each render, breaking memoization down the tree. Matched against the
  // DEFERRED channel so it tracks what the primary pane actually shows and stays
  // stable across the urgent highlight commit (#task:1162).
  const parentJumpTarget = useMemo(
    () =>
      jumpTarget &&
      !jumpTarget.threadRootId &&
      jumpTarget.channelId === deferredChannelId
        ? { channelId: jumpTarget.channelId, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, deferredChannelId],
  );
  // Jumping *into* the secondary pane is not supported — always null/false
  // so the secondary ChannelView never receives a stale jump target.
  const secondaryJumpTarget: { channelId: string; messageId: string } | null =
    null;
  const secondaryJumpPrimePending = false;
  // Thread jump: the message is in the channel but the user asked to land
  // inside the thread pane. Matches when the jump carries a `threadRootId`
  // for the thread currently open in the secondary pane. ThreadPanel
  // scroll-locates `messageId`; `handleJumped` clears it.
  const threadJumpMessageId = useMemo(
    () =>
      jumpTarget &&
      jumpTarget.threadRootId &&
      jumpTarget.threadRootId === threadRootId &&
      jumpTarget.channelId === selectedChannelId
        ? jumpTarget.messageId
        : null,
    [jumpTarget, threadRootId, selectedChannelId],
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

  // Thread pane (#task:1317): expose the jump's lifecycle PHASE, not a bare
  // boolean. ThreadPanel projects window-lock (query-disable), loader, and
  // locate from this single source of truth via `threadMarkRead` pure fns — the
  // window stays locked through `committed` so a latest fetch can't clobber the
  // around-window, and locate only runs once the window is committed/settled.
  const threadJumpPhase = useMemo(
    () =>
      threadJumpMessageId !== null && selectedChannelId !== null
        ? primePhaseFor(selectedChannelId, threadJumpMessageId)
        : null,
    [primePhaseFor, threadJumpMessageId, selectedChannelId],
  );

  // Parent-message highlight only renders alongside an open thread
  // (channel-typed sides aren't anchored to a parent message). Side
  // threads from PR-3 sigil clicks will fire `onThreadAnchorResolved`
  // with their own anchor, so the highlight follows them too.
  // Reply-chip open: with a first-unread target (#task:1226 surface 3) route
  // through `handleJumpToMessage` so the cluster opens AND scroll-locates the
  // first unread reply; without one (plain "open thread") keep the lightweight
  // `nav.openThread`. `selectedChannelId` is the channel the chip lives in.
  const handleOpenThreadFromChannel = (
    rootMessageId: string,
    jumpToMessageId?: string,
  ): void => {
    if (jumpToMessageId && selectedChannelId) {
      handleJumpToMessage({
        workspaceId: selectedWorkspaceId ?? undefined,
        channelId: selectedChannelId,
        threadRootId: rootMessageId,
        messageId: jumpToMessageId,
      });
      return;
    }
    nav.openThread(rootMessageId);
  };

  const parentView = (
    <ChannelView
      channelKind={channelKindForView}
      conversation={deferredParentDescriptor}
      resolving={parentChannelResolving}
      parentTitle={null}
      jumpTarget={parentJumpTarget}
      jumpPrimePending={parentJumpPrimePending}
      onJumped={handleJumped}
      onOpenThread={handleOpenThreadFromChannel}
      // Threads-list pane toggle (#task:1073). The primary pane gets it for
      // any top-level channel-like conversation — both `channel` and
      // `dm_channel` carry a channel-scoped thread index (the backend's
      // threads route resolves via `getChannelLike`, #task:1143). Thread /
      // dm-side / `?side` *secondary* primaries don't (they aren't the
      // channel-scoped index), so they keep it undefined.
      onToggleThreadsList={
        deferredParentDescriptor?.kind === 'channel' ||
        deferredParentDescriptor?.kind === 'dm_channel'
          ? nav.toggleThreadsList
          : undefined
      }
      threadsListActive={threadsListOpen}
      onArchiveChannel={handleArchiveChannelMutation}
      onRenameChannel={handleRenameChannelMutation}
      archivePending={archiveChannel.isPending}
      conversationRefsById={conversationRefsById}
      onOpenConversationRef={nav.openSide}
      onOpenChannelRef={handleOpenChannelByName}
      onOpenTask={handleOpenTask}
      onJumpToMessage={handleJumpToMessage}
      onOpenAdvancedSearch={handleOpenAdvancedSearch}
    />
  );

  // Secondary pane render shapes:
  //   - Resolved channel/dm `?side` (same- or cross-workspace) → real
  //     ChannelView. The conversation descriptor's `workspace_id` carries
  //     the *foreign* workspace for cross-workspace `?side`, so
  //     ChannelView's workspace-scoped hooks auto-target the right cache
  //     without a separate prop.
  //   - Loading / unauthorized / not_found (`?side` ref hook didn't
  //     return a usable conversation) → SideUnresolvedPlaceholder.
  //   - null → no secondary, render only `parentView`.
  let secondaryView: JSX.Element | null = null;
  if (agentPanelId) {
    // Agent side panel (`?agent=<id>`, #task:1189). Renders an agent's compact
    // panel beside the channel so chat + the agent's Activity show together
    // (dual-screen). It is NOT a conversation, so it sits ahead of the
    // `secondaryDescriptor`/thread/threads-list chain (and `?agent` is mutually
    // exclusive with all of them at the nav layer). Activity locks to the
    // current channel (A — shiki).
    secondaryView = (
      <AgentView
        key={`side-${agentPanelId}`}
        variant="side"
        agentId={agentPanelId}
        contextConversationId={selectedChannelId}
        contextWorkspaceId={selectedWorkspaceId ?? null}
        onClose={nav.closeAgentPanel}
        onDeleted={nav.closeAgentPanel}
      />
    );
  } else if (secondaryDescriptor) {
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
          parentTitle={null}
          jumpTarget={secondaryJumpTarget}
          jumpPrimePending={secondaryJumpPrimePending}
          onJumped={handleJumped}
          onCloseChild={closeSecondary}
          // The secondary pane only ever renders a channel/dm `?side`
          // overlay, so the close affordance is the generic
          // "关闭侧栏" — never the thread wording.
          closeLabel="关闭侧栏"
          isFullscreen={false}
          // PR-2: cross-workspace archive invalidation — the secondary
          // pane uses a dedicated callback so the React Query
          // invalidation targets the foreign workspace's channels list,
          // not the primary's.
          onArchiveChannel={handleArchiveSecondaryChannelMutation}
          onRenameChannel={handleRenameSecondaryChannelMutation}
          archivePending={archiveChannel.isPending}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={nav.openSide}
          onOpenChannelRef={handleOpenChannelByName}
          onOpenTask={handleOpenTask}
          // No thread open from the secondary pane: a reply cluster shares
          // its parent channel's context, so opening a thread only makes
          // sense from the primary channel pane. Undefined hides the reply
          // affordance on the side secondary pane.
          onOpenThread={undefined}
        />
      );
    }
  } else if (threadRootId && selectedChannelId && selectedWorkspaceId) {
    // Thread pane (`?thread=<rootMessageId>`). A thread is NOT a
    // conversation — it shares the parent channel's context — so it does
    // not flow through `secondaryDescriptor`/`ChannelView`. It renders
    // only when no side/threads-list secondary is present (those win),
    // matching the nav-layer mutual exclusion (`openThread` clears `?side`).
    //
    // Captured into consts so the `onViewInChannel` closure keeps the
    // narrowed non-null types (TS widens branch-narrowed `let`s back to
    // nullable inside a deferred callback).
    const threadChannelId = selectedChannelId;
    const threadWorkspaceId = selectedWorkspaceId;
    const threadRoot = threadRootId;
    secondaryView = (
      <ThreadPanel
        channelId={threadChannelId}
        workspaceId={threadWorkspaceId}
        rootMessageId={threadRoot}
        parentTitle={selectedChannel?.title ?? null}
        closed={selectedChannelDescriptor?.closed_at != null}
        archived={selectedChannelDescriptor?.archived_at != null}
        onClose={nav.closeThread}
        onViewInChannel={() => {
          // Scroll-locate + flash the root in the main channel stream,
          // then drop the thread pane so the channel is unobstructed.
          requestJump({
            workspaceId: threadWorkspaceId,
            channelId: threadChannelId,
            messageId: threadRoot,
          });
          nav.closeThread();
        }}
        // Same inline-ref resolution + nav handlers the channel pane
        // gets, so thread replies render `#conv:` / `#<channel>` /
        // `#task:` sigils identically (#task:1052).
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={nav.openSide}
        onOpenChannelRef={handleOpenChannelByName}
        onOpenTask={handleOpenTask}
        jumpMessageId={threadJumpMessageId}
        jumpPhase={threadJumpPhase}
        onJumped={handleJumped}
        onJumpToMessage={handleJumpToMessage}
        onOpenAdvancedSearch={handleOpenAdvancedSearch}
      />
    );
  } else if (threadsListOpen && selectedChannelId && selectedWorkspaceId) {
    // Channel Threads-list pane (`?threads=1`, #task:1073). Like a single
    // thread it is NOT a conversation — it is a channel-scoped index — so it
    // renders here rather than through `secondaryDescriptor`/`ChannelView`,
    // and only when no side/thread secondary is present (those win, matching
    // the nav-layer mutual exclusion in `withThreadsQuery`). Opening a row
    // calls `nav.openThread`, which clears `?threads` and swaps in the
    // ThreadPanel for that thread.
    secondaryView = (
      <ChannelThreadsPanel
        channelId={selectedChannelId}
        workspaceId={selectedWorkspaceId}
        parentTitle={selectedChannel?.title ?? null}
        onClose={nav.closeThreadsList}
        onOpenThread={nav.openThread}
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
        onOpenTasks={
          // Workspace task drawer is workspace-scoped, not chat-scoped: enable it
          // wherever a workspace is selected AND we're viewing a channel — chat's
          // `channel` view, or Activity's selected state (its right pane is the
          // full ChannelView). `selectedWorkspace` is null on bare `/activity`
          // (workspace derives from the selected channel), so `appSection ===
          // 'activity'` alone already means "a channel is selected" (#task:1394).
          selectedWorkspace &&
          ((appSection === 'chat' && view === 'channel') ||
            appSection === 'activity')
            ? () => setTasksDrawerOpen(true)
            : undefined
        }
        taskCount={workspaceActiveTaskCount}
        workspaceSidebarVisible={workspaceSidebarVisible}
        channelSidebarVisible={channelSidebarVisible}
        onToggleWorkspaceSidebar={toggleWorkspaceSidebar}
        onToggleChannelSidebar={toggleChannelSidebar}
        chromeMode={appSection === 'activity' ? 'activity' : 'chat'}
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
          dots={navRailDots}
          onChange={section => {
            if (section === 'chat') nav.toChat();
            else if (section === 'activity') nav.toActivity();
            else if (section === 'tasks') nav.toTasks();
            else if (section === 'members') nav.toMembers();
            else if (section === 'settings') nav.toSettings();
            else nav.toComputers();
          }}
        />
        {/* ===== Top-level section views (#task:1168 + #task:1170) =====
          *
          * Rendered as INDEPENDENT conditional siblings (not a mutually-
          * exclusive ternary) so that during a section switch the outgoing and
          * incoming sections can briefly coexist — one visible, one hidden —
          * which is what lets the chat shell paint instantly without dragging
          * the previous section's teardown onto the click commit.
          *
          * Two axes, deliberately driven by DIFFERENT section values (this is
          * intentional, not a typo — see the three invariants in #task:1170):
          *
          *   • MOUNT / UNMOUNT  ← `deferredSection` (low-priority).
          *     Each `deferredSection === X` guard mounts a section and, once the
          *     deferred value moves off X, truly UNMOUNTS it on the deferred
          *     commit. So a heavy teardown (TasksSection's 274-card dnd-kit
          *     cleanup; ChannelView's effects) never runs on the urgent click
          *     commit that must paint the rail highlight. NB: this is a real
          *     unmount, NOT keep-alive — display:none below only spans the
          *     transition frames; a section is never left permanently
          *     mounted-but-hidden (that would resurrect the mark-read side
          *     effect we rejected, ChannelView.tsx:248-260).
          *
          *   • VISIBILITY  ← urgent `appSection`, via <SectionLayer> toggling
          *     display:contents↔none. The rail click updates `appSection`
          *     synchronously, so the click commit instantly flips WHICH mounted
          *     section is shown, even though the deferred mount/unmount lags a
          *     step behind.
          *
          * Non-chat sections are hidden only while `appSection === 'chat'` (chat
          * is urgently taking over on top); during non-chat→non-chat switches
          * the outgoing one stays visible until the incoming one mounts, so we
          * never flash blank. */}
        {deferredSection === 'settings' && (
          <SectionLayer visible={appSection !== 'chat'}>
            <SettingsPage />
          </SectionLayer>
        )}
        {deferredSection === 'tasks' && (
          <SectionLayer visible={appSection !== 'chat'}>
            <TasksSection onJump={handleJumpToMessageStable} />
          </SectionLayer>
        )}
        {deferredSection === 'members' && (
          <SectionLayer visible={appSection !== 'chat'}>
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
                  // Jump back to chat view, focusing the agent's channel.
                  const workspaceId = resolveNavWorkspaceId(s.workspace_id, s.channel_id);
                  if (!workspaceId) return;
                  nav.toChannel(workspaceId, s.channel_id);
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
          </SectionLayer>
        )}
        {deferredSection === 'computers' && (
          <SectionLayer visible={appSection !== 'chat'}>
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
                  isLoading={hostsQuery.isLoading}
                  selectedHostId={selectedHostId}
                  onSelectHost={setSelectedHostId}
                  onAddComputer={() => setNewComputerOpen(true)}
                />
              </nav>
            </aside>
            {selectedHost ? (
              <HostDetailView key={selectedHost.id} host={selectedHost} />
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
          </SectionLayer>
        )}
        {/* ACTIVITY: NavRail top-level section (#task:1394). Three columns:
          * Activity-list navigator | full ChannelView | full ThreadPanel. The
          * browse sidebars are intentionally absent — the Activity list column
          * replaces them (the "省下一个 sidebar"). Mounts/unmounts on
          * `deferredSection` like the other non-chat sections. */}
        {deferredSection === 'activity' && (
          <SectionLayer visible={appSection !== 'chat'}>
          <>
            {/* Activity list column — the global attention navigator: selection
              * / sort / filter only, owns NO message or thread rendering. Two
              * layout states, both a pure projection of the route (#task:1394,
              * shiki): with NO channel in the route (bare `/activity`, incl. the
              * caught-up empty state) it fills the whole content area — no right
              * pane, no ChannelView/SplitPane, so we never carry back an implicit
              * "unselected but a conversation surface exists" state. Once a row is
              * clicked the route gains `/w/:wid/c/:cid` and it collapses to a
              * resizable left column beside the reused ChannelView — the SAME
              * progressive-disclosure primitive as chat's ChannelView→ThreadPanel
              * (app-layout.md §1). Width is its OWN `--activity-list-width` (never
              * chat's `--sidebar-width`) with an independent min/max clamp +
              * persisted pref. */}
            <aside
              data-sidebar="activity"
              className={
                selectedChannelId != null
                  ? 'flex h-full w-[var(--activity-list-width)] shrink-0 flex-col bg-[var(--bg-channels-sidebar)]'
                  : 'flex h-full min-w-0 flex-1 flex-col bg-[var(--bg-channels-sidebar)]'
              }
              style={{
                borderRadius: 'var(--card-radius, 0)',
                boxShadow: 'var(--card-shadow, none)',
                overflow: 'hidden',
              }}
            >
              <ActivityView
                workspaceRefById={workspaceRefById}
                agentsById={agentsById}
                onJump={handleJumpToMessageStable}
              />
            </aside>
            {/* Split appears ONLY once the route carries a channel. The divider
              * resizes the Activity list against the conversation column (clamp
              * owned by the `activityList` hook). Right side = the SAME
              * `parentView` / `secondaryView` chat renders — route-driven reuse is
              * what makes "无条件自动同步" structural (composer / thread /
              * inline-search / jump-prime / mark-read all inherit from the one
              * ChannelView). Gated on URGENT `appSection === 'activity'` (not just
              * the deferred mount): during an activity↔chat transition both blocks
              * are briefly mounted, so this ensures only ONE renders the shared
              * ChannelView, avoiding a transient double-mount of its effects; the
              * hidden side shows the skeleton. */}
            {selectedChannelId != null ? (
              <>
                <VerticalSplitter
                  onPointerDown={activityList.startResize}
                  active={activityList.isDragging}
                />
                {appSection === 'activity' ? (
                  secondaryView &&
                  shouldSecondaryFullscreen(secondaryDescriptor, routeFullscreen) ? (
                    secondaryView
                  ) : (
                    <SplitPane
                      left={parentView}
                      right={secondaryView}
                      storageKey="silverhand.layout.activity-split-ratio"
                    />
                  )
                ) : (
                  <ConversationViewSkeleton />
                )}
              </>
            ) : null}
          </>
          </SectionLayer>
        )}
        {/* CHAT: the cheap shell (workspace + channel sidebars + their
          * splitters) mounts on URGENT `appSection` so a rail click paints it
          * immediately (~5ms render, Alice CDP). It is mounted while EITHER
          * value is 'chat': `appSection === 'chat'` covers instant ENTRY;
          * `deferredSection === 'chat'` keeps the shell on screen for the
          * one-step EXIT (chat→X) until the destination mounts, so we never
          * flash blank. Whenever it's mounted it's the section to show, so it's
          * always visible. The heavy conversation pane inside is gated
          * separately on `deferredSection` with a skeleton (see below). */}
        {(appSection === 'chat' || deferredSection === 'chat') && (
          <SectionLayer visible>
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
                      starred_at: workspaceStarredAt.get(w.id) ?? null,
                      archived: w.archived_at !== null,
                      created_at: w.created_at,
                    }))}
                    agentsById={agentsById}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={handleSelectWorkspace}
                    onStarWorkspace={(workspaceId, starred) =>
                      starWorkspace.mutate({ id: workspaceId, starred })
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
                workspaces={workspaces}
                filter={savedFilter}
                onFilterChange={setSavedFilter}
                onJump={params => handleJumpToMessage(params)}
              />
            ) : view === 'search' ? (
              <SearchPanel
                workspaces={workspaces}
                initialQuery={route.searchQuery ?? undefined}
                filter={searchFilter}
                onFilterChange={setSearchFilter}
                onJumpMessage={params => handleJumpToMessage(params)}
                onOpenWorkspace={id => nav.toWorkspace(id)}
                onOpenConversation={(workspaceId, channelId) => {
                  const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                  if (!navWorkspaceId) return;
                  nav.toChannel(navWorkspaceId, channelId);
                }}
              />
            ) : view === 'archived' ? (
              <ArchivedChannelsPanel
                workspaces={workspaces}
                filter={archivedFilter}
                onFilterChange={setArchivedFilter}
                onOpenChannel={(workspaceId, channelId) => {
                  // Mirror SearchPanel: resolve through the same nav helper
                  // so a cross-workspace open lands on the right UI workspace
                  // item. For the archived aggregate `workspaceId` is already
                  // the channel's own workspace id (agent_home for a DM), so
                  // this is a no-op there — but it keeps both cross-workspace
                  // panels on one resolution path (#task:1145).
                  const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                  if (!navWorkspaceId) return;
                  nav.toChannel(navWorkspaceId, channelId);
                }}
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
                        workspaceId={selectedWorkspaceId}
                        channels={activeChannels.map(s => ({
                          id: s.id,
                          title: s.title,
                          kind: s.kind,
                          status:
                            s.status === 'active' || s.status === 'crashed' ? s.status : 'idle',
                          closed_at: s.closed_at,
                          starred_at: channelStarredAt.get(s.id) ?? null,
                          archived_at: s.archived_at,
                          created_at: s.created_at,
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
                        onStarChannel={(channelId, starred) =>
                          starChannel.mutate({ channelId, starred })
                        }
                        onArchiveChannel={(channelId, archived) => {
                          archiveChannel.mutate({
                            channelId,
                            archived,
                            workspaceId: selectedWorkspaceId ?? undefined,
                          });
                        }}
                        onCreateChannel={
                          appSection === 'chat' && view === 'channel' && selectedWorkspace
                            ? () => setCreateChannelOpen(true)
                            : undefined
                        }
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
                {/* Heavy conversation pane — the only part of the chat section
                  * kept on `deferredSection`. While the deferred value hasn't
                  * caught up to 'chat' (i.e. we just entered chat and the shell
                  * above is already painted), show a skeleton instead of
                  * mounting ChannelView, so the mount's ~hundreds-of-ms commit
                  * work stays off the click critical path.
                  *
                  * The gate is `deferredSection === 'chat'` — keyed by
                  * DESTINATION, not predecessor. That's deliberate: on entry
                  * `appSection` is already 'chat' but `deferredSection` still
                  * names the previous section; gating on the predecessor would
                  * briefly mount this pane over the half-torn-down old section.
                  * Keying on the destination shows the skeleton for exactly the
                  * frames before the conv is ready, never stale previous
                  * content. (PERCEPTION win only — the deferred mount/teardown
                  * longtask still runs a beat later behind the painted shell;
                  * it does NOT reduce that CPU work, so don't drop the defer on
                  * the assumption it does.) */}
                {deferredSection === 'chat' ? (
                  secondaryView &&
                  shouldSecondaryFullscreen(secondaryDescriptor, routeFullscreen) ? (
                    secondaryView
                  ) : (
                    <SplitPane
                      left={parentView}
                      right={secondaryView}
                      storageKey="silverhand.layout.split-ratio"
                    />
                  )
                ) : (
                  <ConversationViewSkeleton />
                )}
              </>
            )}
          </>
          </SectionLayer>
        )}
      </div>

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={({ workspaceId, channelId }) =>
          nav.toChannel(workspaceId, channelId)
        }
      />
      <NewComputerDialog
        open={newComputerOpen}
        onOpenChange={setNewComputerOpen}
        onCreated={hostId => setSelectedHostId(hostId)}
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
