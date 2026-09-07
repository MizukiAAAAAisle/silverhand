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
import { ChannelView } from '@/components/layout/ChannelView';
import { ConversationViewSkeleton } from '@/components/layout/ConversationViewSkeleton';
import { paneChrome } from '@/components/layout/pane-chrome';
import { SectionShell } from '@/components/layout/SectionShell';
import { SectionLayer } from '@/components/layout/SectionLayer';
import { ThreadPanel } from '@/components/layout/ThreadPanel';
import { ChannelThreadsPanel } from '@/components/layout/ChannelThreadsPanel';
import { ChannelAttachmentsPanel } from '@/components/layout/ChannelAttachmentsPanel';
import { SavedListView, SAVED_FILTER_DEFAULT, type SavedFilterState } from '@/components/layout/SavedListView';
import { SearchPanel, SEARCH_FILTER_DEFAULT, type SearchFilterState } from '@/components/layout/SearchPanel';
import {
  senderFilterFromParam,
  senderFilterToParam,
} from '@/components/ui/sender-filter-select';
import {
  directPairSenderSeed,
  type AdvancedSearchSeed,
} from '@/features/search/advanced-search-seed';
import { ArchivedChannelsPanel, ARCHIVED_FILTER_DEFAULT, type ArchivedFilterState } from '@/components/layout/ArchivedChannelsPanel';
import { ActivityView } from '@/components/layout/ActivityView';
import { SplitPane } from '@/components/layout/SplitPane';
import { TasksSection } from '@/components/layout/TasksSection';
import { Titlebar } from '@/components/layout/Titlebar';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useAppearance } from '@/hooks/useAppearance';
import { useLayoutSettings } from '@/hooks/useLayoutSettings';
import {
  SIDEBAR_ANIMATE_LAYOUT,
  SIDEBAR_PERFORMANCE_VARIANT,
} from '@/sidebar-performance-experiment';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useRuntimeEpochPromotion,
  useViewerUser,
} from '@/features/me/hooks';
import { RegistrationGate } from '@/features/me/RegistrationGate';
import { BackendUnreachableGate } from '@/features/me/BackendUnreachableGate';
import { UpdateRequiredGate } from '@/features/me/UpdateRequiredGate';
import { AppStatusBanner } from '@/features/me/AppStatusBanner';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
import { CreateChannelDialog } from '@/features/workspaces/CreateChannelDialog';
import { WorkspaceSettingsDialog } from '@/features/workspaces/WorkspaceSettingsDialog';
import { resolveWorkspaceSettingsTarget, workspaceDeletionDestination } from '@/features/workspaces/workspace-settings-target';
import { workspaceCapabilities } from '@/features/workspaces/workspace-capabilities';
import { TaskDetailDialog } from '@/components/tasks/TaskDetailDialog';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { useTaskBoardRealtime } from '@/features/tasks/useBoard';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { AgentView } from '@/features/agents/AgentView';
import { HumanView } from '@/features/me/HumanView';
import { SideUnresolvedPlaceholder } from '@/components/layout/SideUnresolvedPlaceholder';
import type { WorkspaceChannelReference } from '@/components/chat/ConversationRef';
import { isWorkspacePlaced } from '@silverhand/shared';
import type { AttachmentSnapshot, ConversationVisibility } from '@silverhand/shared';
import { useAgents } from '@/features/agents/hooks';
import {
  useAppShellGlobalSync,
  useShutdownProgress,
  useComposerDraftCleanup,
  useDockBadge,
  useLayoutKeyboardShortcuts,
  useSettingsMenuNav,
} from '@/features/app-shell/effects';
import {
  useContextualCloseResponder,
  useNavSectionShortcuts,
} from '@/features/app-shell/keyboard-shortcuts';
import { useSecondaryPaneModel } from '@/features/app-shell/secondary-pane-model';
import { useSelectionPersistenceEffects } from '@/features/app-shell/selection-persistence';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  useArchiveChannel,
  useRenameChannel,
  useLeaveChannel,
  useSetChannelVisibility,
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
import { isMemberChannel, mountsMemberOnlyPanel } from '@/features/channels/membership';
import {
  useForeignWorkspaceChannelRemovalSync,
  useViewerChannelRemovalSync,
} from '@/features/channels/useViewerChannelRemovalSync';
import { useChannelMembership } from '@/features/channels/use-channel-membership';
import {
  useActivity,
  useAttentionBadges,
  useAttentionRealtime,
} from '@/features/attention/hooks';
import {
  useMessageJumpController,
  type MessageJumpTarget,
} from '@/features/channels/useMessageJumpController';

import {
  selectSecondaryViewInputs,
  selectSidebarSelectedConversationId,
  shouldSecondaryFullscreen,
  type ConversationPointer,
} from '@/lib/secondary-pane';
import {
  directPairPaneDescriptor,
  type ConversationPaneDescriptor,
} from '@/features/conversations/pane-descriptor';
import {
  inheritedComposerDirectory,
  inheritedPaneCapabilities,
} from '@/features/conversations/pane-mode';
import { locatorWorkspaceName } from '@/features/conversations/locator-source';
import { ConversationPaneCapabilitiesProvider } from '@/features/conversations/pane-capabilities-context';
import {
  directPairPaneProps,
  findAgentDirectPair,
  useDirectPairPane,
  useDirectPairsList,
} from '@/features/direct-pairs/hooks';
import { DirectPairDraftPane } from '@/features/direct-pairs/DirectPairDraftPane';
import { presentCounterpart } from '@/features/direct-pairs/counterpart-presentation';
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
  getLastChatPlace,
  getLastWorkspaceId,
  lastChannelByWorkspace,
  persistLastChannel,
  recordChannelLayout,
  recordCloseWatermark,
} from '@/lib/place-memory';
import {
  directPairAuthorityFromQuery,
  resolveChatPlaceRestore,
  type DirectPairAuthority,
} from '@/lib/chat-place-restore';
import { jumpBasePath, resolveJumpNav, resolveJumpRoute } from '@/lib/message-jump-nav';
import { toasterTypedIcons } from '@/lib/toast-icons';
export {
  LAST_CHANNEL_KEY,
  clearPlaceMemory,
};
import { resolveChannelOpen } from '@/lib/channel-open';
import { pickFallbackAfterArchive } from '@/lib/archive-fallback';
import { pickWorkspaceToRestore } from '@/lib/workspace-restore';
import { resolveRestoreNavigation } from '@/lib/restore-navigation';
import { agentSpaceRecognitionName } from '@/lib/workspace-name';
import { isAgentSpace } from '@/features/workspaces/workspace-ownership';
export function App(): JSX.Element {
  const { appearance } = useAppearance();
  // #task:1763 — subscribe to main's confirmed runtime epoch promotion so a
  // running session gates without waiting for restart/focus refetch.
  useRuntimeEpochPromotion();
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
  if (!viewer.data) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-bg-base text-xs text-text-muted">
        Loading…
      </div>
    );
  }
  // D4.a Commit 5d-fixup (Cindy P1-2): backend-unreachable gate
  // takes precedence over the registration gate. The
  // user MUST repair the connection (or clear the saved profile)
  // before any further auth state can be inferred — pretending the
  // user is "unauthenticated, signup_enabled=false" would push them
  // toward the wrong CTA.
  if (isBackendUnreachable(viewer.data)) {
    return (
      <BackendUnreachableGate
        serverUrl={viewer.data.server_url}
        message={viewer.data.message}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }
  // #task:1761 — epoch hard gate: after unreachable (connectivity first),
  // before registration (no business/auth flow through an incompatible pair).
  if (isUpdateRequired(viewer.data)) {
    return (
      <UpdateRequiredGate
        direction={viewer.data.direction}
        serverApiEpoch={viewer.data.server_api_epoch}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }
  if (isRegistrationRequired(viewer.data)) {
    return <RegistrationGate signupEnabled={viewer.data.signup_enabled} />;
  }
  // slack-dark is our only dark theme; studio-light / forza6 are light. sonner
  // then picks the matching default scale for the parts our token overrides in
  // global.css don't cover (e.g. any action/close button greys).
  return (
    <RegisteredAppShell
      toasterTheme={appearance.theme === 'slack-dark' ? 'dark' : 'light'}
    />
  );
}

/**
 * Toast viewport insets (#task:1824 — notifications moved from the bottom-right
 * to the top-right).
 *
 * Top clears `--titlebar-height` instead of sitting on it: the titlebar is a
 * window-DRAG region, and a float parked over it both reads as "on top of the
 * chrome" and hands its own clicks to the window drag unless it opts out
 * (`AppStatusBanner` has to). Starting below the bar avoids that whole class,
 * and top-right of the CONTENT area is what "in-app" means anyway. Right inset
 * matches the titlebar's trailing spacer so the toast's edge lines up with the
 * chrome above it.
 *
 * `mobileOffset` is spelled out because the main window has no `minWidth`:
 * under 600px sonner swaps to its mobile insets (default 16px all round) and
 * would land back on the titlebar. All four keys are set in both objects —
 * sonner only writes the keys it is given, and its mobile rules compute
 * `width: calc(100% - var(--mobile-offset-left) * 2)`, which breaks on an
 * unset var.
 */
const TOAST_OFFSET = {
  top: 'calc(var(--titlebar-height) + 8px)',
  right: '12px',
  bottom: '24px',
  left: '24px',
} as const;
const TOAST_MOBILE_OFFSET = {
  top: 'calc(var(--titlebar-height) + 8px)',
  right: '16px',
  bottom: '16px',
  left: '16px',
} as const;

function RegisteredAppShell({
  toasterTheme,
}: {
  toasterTheme: 'light' | 'dark';
}): JSX.Element {
  const { layout, toggleWorkspaceSidebar } = useLayoutSettings();

  // Global mount-once realtime/visibility sync (5 app-scope WS consumers),
  // lifted to a hook so the shell stays a thin composition root. See
  // features/app-shell/effects.ts for the per-hook rationale.
  useAppShellGlobalSync();

  // Shutdown overlay step — null means not shutting down.
  const shutdownStep = useShutdownProgress();
  useComposerDraftCleanup();

  // Sidebar width persists across launches and mirrors into a CSS var so
  // existing `var(--sidebar-width)` consumers (Titlebar pad, Sidebar
  // <aside>) re-flow without prop-drilling. ONE column since #task:1889 — the
  // merged tree took over the retired `--channels-sidebar-width`'s range (up to
  // 400) because it now carries channels too; its own width memory is gone.
  //
  // `min` is 230, not 200, since the collapse caret landed (#task:1949, shiki
  // `Q_M0W5o2VTuTU9QP`). Nothing in a row can actually compress — icon, mute
  // marker, caret and the hover action cluster are all `shrink-0` — so the whole
  // squeeze lands on the ONE flexible child, the name. A workspace row spends
  // ~56px on chrome before the name (2px gutter border ×2 + pl-1 + 16px icon +
  // ml-2 + caret's ml-1 + 12px + pr-2) and another 28–56px on the sort / `+`
  // cluster the moment you point at the branch — which is exactly when you are
  // reading the name. At 200 that left the name ~88px (~11 chars at 14px); at 230
  // it gets ~118px. A width persisted inside the old 200–229 band no longer
  // validates on load and falls back to `defaultWidth` (240) — a one-time
  // widening, not a clamp, and the only reachable consequence of moving the floor.
  const sidebar = useResizableWidth({
    storageKey: 'silverhand.layout.sidebar-width',
    defaultWidth: 240,
    min: 230,
    max: 400,
    cssVar: '--sidebar-width',
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
    // Set only by `/chat/d/:conversationId` — the WORKSPACE-LESS arm of the same
    // "a conversation is open" fact `selectedChannelId` carries. It is the
    // discriminator, not a second selection: both arms put the open
    // conversation's id in `selectedChannelId`, and this says which carrier owns
    // it (the workspace's channel list, or the viewer's direct-pair list).
    directConversationId,
    // Set only by `/chat/d/new/:agentId` — an AGENT identity, not a conversation.
    // Nothing is selected while it is set (there is no conversation yet), so it
    // never reaches `selectedChannelId` or the layout cache.
    directDraftAgentId,
    sideConversationId,
    threadRootId,
    threadsListOpen,
    filesListOpen,
    taskDetailId,
    fullscreen: routeFullscreen,
    agentId: selectedAgentId,
    userId: selectedUserId,
    agentPanelId,
  } = route;
  const workspaceSidebarPane = layout.workspaceSidebar;
  const workspaceSidebarVisible = workspaceSidebarPane.visible;

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newComputerOpen, setNewComputerOpen] = useState(false);
  // Which workspace a new channel is being created in — `null` closes the dialog.
  // Since #task:1889 the merged tree's rows are cross-workspace, so the target is
  // carried explicitly instead of being implied by "the current workspace".
  const [createChannelWorkspaceId, setCreateChannelWorkspaceId] = useState<
    string | null
  >(null);
  const [workspaceSettingsId, setWorkspaceSettingsId] = useState<string | null>(null);
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

  // Chat-only: the ⌘\ chord toggles the browse sidebar, which exists only in
  // chat. Gating on `appSection === 'chat'` keeps the keyboard path on the same
  // section boundary as the (hidden-in-activity) titlebar toggle, so Activity has
  // no browse-sidebar control path at all (#task:1394, Cindy review).
  useLayoutKeyboardShortcuts(toggleWorkspaceSidebar, appSection === 'chat');

  // App menu's "Settings…" item (Cmd+,) — main process focuses the window and
  // pushes this; renderer just navigates.
  useSettingsMenuNav(nav.toSettings);

  // ⌘1–5 → nav-rail section. Renderer-owned, global (⌘+digit is
  // never a typing key), no native-menu accelerator claims it.
  useNavSectionShortcuts(nav);

  // ⌘W contextual close. Main owns the accelerator and asks the
  // renderer, per keypress, which panel to peel; this answers with the
  // authoritative outcome against the latest route. The responder is called
  // further down (after the parent-channel membership resolves) so the ladder
  // it reports mirrors the membership-gated render — a non-member's ungated
  // `?files` / `?threads` flag must not occupy a close rung for a pane that
  // never mounts.

  // Per-workspace "last viewed channel" memory lives as a module
  // singleton above (persisted via localStorage). The recording effect
  // below writes through to storage on every mutation; the restore
  // effect reads from it when hydrating from a workspaceId-only URL.
  const lastSelectedAgentId = useRef<string | null>(null);
  // Same as `lastSelectedAgentId` but for the chat section: clicking the
  // "Chat" navrail item routes to bare `/chat` (no workspaceId), so on the
  // way back the auto-pick below must restore the workspace the user last had
  // open instead of snapping to `workspaces[0]`. This one is persisted so an
  // app restart can land back on a workspace that does not sort first
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
  // A channel just removed from the PRIMARY pane's member view — archived, or
  // self-left from a private channel — that cleared selection. Excluded from
  // the auto-select effect's remembered + fallback branches until the list
  // invalidation lands, so a stale list can't re-select the channel the user
  // just left behind (#task:1145).
  const recentlyRemovedPrimaryRef = useRef<{
    workspaceId: string;
    channelId: string;
  } | null>(null);

  const { data: workspaces = [] } = useWorkspaces();
  const visibleWorkspaceIds = useMemo(
    () => workspaces.map(workspace => workspace.id),
    [workspaces],
  );
  const { data: agents = [] } = useAgents();
  // Stable id → agent lookup shared with the sidebar (agent space avatar
  // resolution) and any future agent-keyed surface. Memoized on the
  // list reference so render of a different surface in the tree
  // doesn't rebuild the Map. #task:919
  const agentsById = useMemo(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
  const selectedWorkspace = workspaces.find(w => w.id === selectedWorkspaceId) ?? null;
  const settingsWorkspace = resolveWorkspaceSettingsTarget(workspaces, workspaceSettingsId);
  // The pane owner already holds the workspace id→name authority (`workspaces`),
  // so it resolves the display name a Composer needs to spell a semantic channel
  // locator and hands it down as a SIBLING prop — no leaf lookup, mirroring how
  // `hasChannelNamespace` is threaded (#task:2126). The Agent-Space / workspace-less
  // / unresolved gate lives in `locatorWorkspaceName` (a locator is spellable ONLY
  // for a regular workspace, mirror of `locator-target.ts`'s resolver exclusion);
  // a null result means the Composer falls back to `#conv:<id>`.
  const workspaceNameById = useCallback(
    (wid: string | null): string | null =>
      wid === null ? null : locatorWorkspaceName(workspaces.find(w => w.id === wid)),
    [workspaces],
  );
  // The workspace a pending channel creation targets — resolved off the id the
  // tree row handed over, so `+` on a row the primary pane is NOT in still creates
  // in the right place (#task:1889).
  const createChannelWorkspace =
    createChannelWorkspaceId === null
      ? null
      : (workspaces.find(w => w.id === createChannelWorkspaceId) ?? null);
  // Titlebar name for an agent space = its agent's raw display name, resolved the
  // SAME way as the rail (`agentSpaceRecognitionName`, shared so they can't drift) so
  // the header reads like the person, not `@handle` (#task:1768). Every other
  // workspace keeps its bare name. The Titlebar drops the `· DM` marker too
  // (shiki) — the icon carries that cue.
  const titlebarWorkspaceName =
    selectedWorkspace === null
      ? null
      : isAgentSpace(selectedWorkspace)
        ? agentSpaceRecognitionName(
            selectedWorkspace.name,
            selectedWorkspace.owner_agent_id
              ? agentsById.get(selectedWorkspace.owner_agent_id)
              : undefined,
          )
        : selectedWorkspace.name;
  // Activity is a GLOBAL list — it shows rows from every workspace, so it needs
  // workspace_id → identity (name + icon inputs), so a GLOBAL list (Activity)
  // can show each row's workspace icon and disambiguate same-named channels
  // across workspaces. `ownerAgentId` feeds the canonical `WorkspaceIcon`
  // (people-owned → themed `W`, agent space → its agent's avatar) — same primitive
  // the rail uses, never a hand-rolled glyph.
  const workspaceRefById = useMemo(
    () =>
      new Map(
        workspaces.map(
          w =>
            [
              w.id,
              {
                name: w.name,
                ownerAgentId: w.owner_agent_id,
              },
            ] as const,
        ),
      ),
    [workspaces],
  );
  // The container ROW behind `selectedWorkspaceId`, resolved or not: the id comes
  // from the URL and the row from the workspace list query, so "id known, row
  // not yet" is a real window and every workspace-scoped query stays off until
  // the row lands (#task:2078).
  const workspaceResolved = !!selectedWorkspace;
  const { data: activeChannels = [] as ChannelListItem[], isLoading: activeChannelsLoading, status: activeChannelsStatus, fetchStatus: activeChannelsFetchStatus } = useChannelsForWorkspace(
    selectedWorkspaceId,
    workspaceResolved,
  );
  const { data: archivedChannels = [] as ChannelListItem[], status: archivedChannelsStatus, fetchStatus: archivedChannelsFetchStatus } = useArchivedChannelsForWorkspace(
    selectedWorkspaceId,
    workspaceResolved,
  );
  // Union for URL/jump/search resolution. The sidebar gets active and
  // archived as separate props (so it can render the Archived group with
  // its own sort order), but anything that asks "does channel X exist in
  // this workspace" — selectedChannel lookup, jump targets, breadcrumbs —
  // needs to consider both.
  const channels = useMemo<ChannelListItem[]>(
    () => [...activeChannels, ...archivedChannels],
    [activeChannels, archivedChannels],
  );
  // Member-scoped projection of the discovery union. `activeChannels` now
  // includes unjoined active PUBLIC channels (`is_member: false`, browse-only)
  // and possibly not-yet-resolved (`unknown`) items. Auto-select / remembered /
  // default / fallback restore, selection persistence, and any member-scoped
  // aggregate must consume ONLY authoritative members — never auto-open or
  // persist a channel the viewer hasn't joined. The full `channels` union stays
  // for existence / selectedChannel resolution (a user CAN open a public channel
  // to browse it) and the sidebar (which renders both, gating badge/select).
  const memberActiveChannels = useMemo(
    () => activeChannels.filter(isMemberChannel),
    [activeChannels],
  );
  // Move the primary pane off a channel it can no longer point at — shared by
  // self-leave of a PRIVATE channel and by a third-party removal that took the
  // channel out of discovery (#task:1689). `memberActiveChannels` may or may not
  // still contain the departed id (the leave path runs before the list refetch,
  // the removal path after); `pickFallbackAfterArchive` handles both.
  const departPrimaryPane = useCallback(
    (channelId: string) => {
      if (channelId !== selectedChannelId) return;
      const wid = selectedWorkspaceId;
      if (!wid) return;
      const fallbackId = pickFallbackAfterArchive(memberActiveChannels, channelId);
      if (fallbackId) {
        nav.toChannel(wid, fallbackId);
        return;
      }
      // No active top-level channel remains → clear to the workspace empty
      // state, excluding the departed channel from the auto-select effect until
      // the list refetch drops it (same two guards as archive).
      recentlyRemovedPrimaryRef.current = { workspaceId: wid, channelId };
      lastChannelByWorkspace.delete(wid);
      persistLastChannel();
      nav.toWorkspace(wid);
    },
    [
      selectedChannelId,
      selectedWorkspaceId,
      memberActiveChannels,
      nav.toChannel,
      nav.toWorkspace,
    ],
  );
  // §12 convergence for "a third party removed me from this channel": the
  // authoritative list refetch is the observation, and every viewer-local
  // projection of the lost channel is settled through the removal contract.
  // Settled is per list and includes `fetchStatus` — `status` alone stays
  // 'success' through a background refetch, which is exactly the split-brain
  // tick where a channel moving between the two tables is momentarily in
  // neither (#task:1689).
  useViewerChannelRemovalSync({
    workspaceId: selectedWorkspaceId,
    active: activeChannels,
    archived: archivedChannels,
    activeSettled:
      activeChannelsStatus === 'success' && activeChannelsFetchStatus === 'idle',
    archivedSettled:
      archivedChannelsStatus === 'success' && archivedChannelsFetchStatus === 'idle',
    onVisibilityLoss: departPrimaryPane,
  });
  // The same fact in a workspace the viewer is NOT looking at: cache-only
  // convergence so a global badge / Activity row / task row never survives on a
  // channel the viewer lost, waiting for them to navigate there (#task:1689).
  useForeignWorkspaceChannelRemovalSync({
    workspaceIds: visibleWorkspaceIds,
    selectedWorkspaceId,
  });
  const archiveChannel = useArchiveChannel(selectedWorkspaceId ?? null);
  const renameChannel = useRenameChannel(selectedWorkspaceId ?? null);
  const leaveChannel = useLeaveChannel(selectedWorkspaceId ?? null);
  const setChannelVisibility = useSetChannelVisibility(selectedWorkspaceId ?? null);
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
  // Inline header find → advanced SearchPanel handoff (#task:1335, #task:2114).
  // The callback ONLY navigates: the seed rides the URL (`?q=` + `reset=1` +
  // `?workspace=` / `?sender=`) and the effect below applies it. Writing it
  // straight into `searchFilter` here was the older shape and could only ADD to
  // whatever the session was already carrying — which is exactly wrong for a
  // `direct_pair`, whose hand-off has no workspace to name and therefore left a
  // stale `workspace:` filter in place, filtering the DM's own results away.
  //
  // `reset: true` on EVERY hand-off, including one that can name no axis at all:
  // "this find is the whole filter set now" is a property of the hand-off, not
  // of how much of it happened to be expressible.
  const handleOpenAdvancedSearch = useCallback(
    (seed: AdvancedSearchSeed) => {
      nav.toChatSearch({
        q: seed.query,
        reset: true,
        workspace: seed.workspaceId,
        sender: seed.sender ? senderFilterToParam(seed.sender) : undefined,
      });
    },
    [nav],
  );
  // Apply the route's filter seed (#task:2114). ONE direction only: the URL
  // seeds the filters, the panel's own filter edits never write back — so
  // landing here from a hand-off is reproducible (and shareable), while editing
  // a filter afterwards is not fighting the address bar.
  //
  // `reset` is what licenses starting from the DEFAULTS rather than merging, and
  // that is what clears the axes the hand-off did not name (a DM names a sender
  // and has no workspace). The deps are the params themselves, so a later
  // in-panel edit does not re-fire it; without `reset` — the sidebar's Search
  // entry, or a bare `?q=` link — the session filters stay untouched (#task:1259).
  const seedReset = route.searchFilterReset;
  const seedWorkspace = route.searchWorkspace;
  const seedSender = route.searchSender;
  useEffect(() => {
    if (route.chatView !== 'search') return;
    if (!seedReset) return;
    const sender = senderFilterFromParam(seedSender);
    setSearchFilter({
      ...SEARCH_FILTER_DEFAULT,
      ...(seedWorkspace ? { workspace: `workspace:${seedWorkspace}` as const } : {}),
      ...(sender ? { sender } : {}),
    });
  }, [route.chatView, seedReset, seedWorkspace, seedSender]);
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilterState>(ARCHIVED_FILTER_DEFAULT);
  // Per-workspace notification unread count (mention / agent-failure alerts).
  const { data: unreadCounts } = useUnreadCounts();
  // Global message unread summary across all workspaces. No longer paints the
  // workspace rail — the attention badge roll-up below does (#task:1870), since a
  // muted workspace must not light it. Kept mounted because it is still the
  // family's `snapshot_required` fallback and the cache the viewer-unread ingestor
  // patches; the two read-models answer different questions ("how many are
  // unread" vs "how loudly should this shout") and both stay true.
  useMessageUnreadSummary();
  // Per-channel message unread counts for the currently selected workspace. Sidebar
  // badges moved to `WorkspaceChannels` with #task:1889 (per-workspace, mounted with
  // the expanded subtree); this stays for the in-conversation consumers below.
  const { data: messageUnreadData } = useMessageUnreadCounts(
    selectedWorkspaceId,
    workspaceResolved,
  );

  // ── Attention badges (#task:1870) ──────────────────────────────────────
  // The viewer's per-workspace badge roll-up: raw unread for `all` channels plus
  // the directed residue of quiet/muted ones. The nav-rail chat dot and the dock
  // badge SHOW it; since #task:1939 the rail rows only READ it (the collapsed-state
  // wake gate — branch or whole section — and the presence dot's suppressor) instead of
  // painting a number — a muted workspace must not nag on any of them, and folding
  // the tiers in three places would drift.
  // `useAttentionRealtime` is the ONE attention subscription; it lives here so
  // rows can read the roll-up without each installing a listener.
  useAttentionRealtime();
  const { data: attentionBadges } = useAttentionBadges();

  // ── Task board freshness (#task:1885) ──────────────────────────────────
  // The ONE `task_changed` listener for every board projection. It lives here
  // because App is the ancestor of both task surfaces AND of the titlebar badge,
  // so the projections stay fresh whether a board is mounted or not — and because
  // a second listener would not be a free dedup: an `invalidateQueries` on a key
  // that already has data cancels the in-flight refetch and restarts it, costing
  // one extra round trip per surface per event (see `useTaskBoardRealtime`).
  useTaskBoardRealtime();

  // ── Nav-rail attention dots (#task:1408) ───────────────────────────────
  // A single no-count dot per rail section that has new content, derived from
  // the existing viewer read-models (zero new query/state). Chat = any workspace
  // with a lit attention badge (archived already excluded at source, #1403-A — no
  // re-filter here; a muted workspace contributes nothing, #task:1870). Activity =
  // the unattended-items list is non-empty (observe drops handled items, so a
  // non-empty list *is* "has new"). Both clear naturally as the section's content
  // is observed.
  const { data: activityData } = useActivity();
  const navRailDots = deriveNavRailDots({
    workspaceUnread: attentionBadges?.by_workspace,
    activityItemCount: activityData?.items.length,
  });

  // ── Dock badge sync ────────────────────────────────────────────────────
  // macOS dock icon shows the attention total across every workspace.
  useDockBadge(attentionBadges?.total);

  // ── The open conversation's carrier ───────────────────────────────────
  // Two placements can be the primary pane, and they have DIFFERENT carriers:
  // a workspace channel comes from the workspace-keyed channel list, a
  // `direct_pair` from the viewer's own pair list (#task:2035). The route says
  // which one owns the id, so the lookup happens ONCE here and every downstream
  // consumer (read cursor, focus, pane descriptor, membership gate) reads the
  // resolved carrier instead of guessing from `channels`.
  // The list hook, not the rows-only helper: the Chat-rail restore below has to
  // tell "you have no pairs" from "the list has not answered yet" before it
  // decides where a bare `/chat` lands (#task:2042). Same single cache entry.
  const directPairsQuery = useDirectPairsList();
  const directPairs = directPairsQuery.data?.direct_pairs ?? [];
  // The pair arm's states (#task:2035 B8). The state machine lives in
  // `useDirectPairPane` and the CONSUMER mapping in `directPairPaneProps` — both
  // pure, so every state has a rendering by construction and collapsing two of
  // them cannot pass unnoticed. Nothing here re-derives them.
  const directPairPane = directPairPaneProps(
    useDirectPairPane(directConversationId),
  );
  const directPair = directPairPane.pair;
  const directPairResolving = directPairPane.resolving;
  const directPairLoadFailed = directPairPane.loadFailed;
  const directPairNotFound = directPairPane.notFound;
  // Every pair the viewer is an endpoint of, as an id set — the membership test
  // for "is this conversation id workspace-less?", used by the navigation
  // handlers that receive an id with no placement attached. Reads the SAME cache
  // entry as the pane lookup above (one query, two questions).
  const directPairIds = useMemo(
    () => new Set(directPairs.map(p => p.conversation_id)),
    [directPairs],
  );
  const primaryPointer = useMemo<ConversationPointer | null>(() => {
    // `roster_policy` is not a lookup here: a `direct_pair` is minted `fixed`
    // (`conversation-repo.ts`) and its two endpoints are the placement itself,
    // so the value is a property of the KIND, not of the row.
    if (directPair) {
      return { id: directPair.conversation_id, rosterPolicy: 'fixed' };
    }
    if (!selectedChannelId) return null;
    const hit = channels.find(c => c.id === selectedChannelId);
    return hit ? { id: hit.id, rosterPolicy: hit.roster_policy } : null;
  }, [directPair, channels, selectedChannelId]);

  // ── Secondary pane state ──────────────────────────────────────────────
  // Resolves `?side=<id>` into the descriptor + visible/focused conversation
  // pointers. See features/app-shell/secondary-pane-model.ts.
  const { secondaryDescriptor, visibleConversations, focusedConversation } =
    useSecondaryPaneModel({
      primary: primaryPointer,
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

  const resolveNavWorkspaceId = (
    workspaceId: string | undefined,
    channelId?: string | null,
  ): string | null => {
    if (!workspaceId) return selectedWorkspaceId;
    if (workspaces.some(w => w.id === workspaceId)) return workspaceId;
    const owningAgentSpace = workspaces.find(w => {
      if (!isAgentSpace(w)) return false;
      if (w.dm_channel_ids.includes(workspaceId)) return true;
      return !!channelId && w.dm_channel_ids.includes(channelId);
    });
    return owningAgentSpace?.id ?? workspaceId;
  };

  // Open one of an agent's conversations from the agent page, in the ordinary
  // chat surface. TWO destinations because there are two placements: a
  // `direct_pair` has no workspace coordinate (#task:2020 / #task:2035) and gets
  // the workspace-less route; anything else resolves its container first. One
  // rule for both agent-page lists (Activity seats and Chats rows) so they can't
  // drift into two navigation models.
  const openAgentConversation = (
    conversationId: string,
    workspaceId: string | null,
  ): void => {
    if (workspaceId === null) {
      nav.toDirect(conversationId);
      return;
    }
    const wid = resolveNavWorkspaceId(workspaceId, conversationId);
    if (!wid) return;
    nav.toChannel(wid, conversationId);
  };

  // Which arm a bare `/chat` restores (#task:2042). The mapping from query state
  // to authority is itself pure (`directPairAuthorityFromQuery`) — it is where
  // "cached rows are not the current answer" is enforced, so it must be
  // falsifiable rather than inline. The only thing this side owns is the
  // distinction the set alone cannot carry: an empty set is an answer, a cold
  // query is not, so the ids go in ONLY when a read has answered.
  const answeredPairIds = directPairsQuery.data ? directPairIds : undefined;
  const directPairAuthority = useMemo<DirectPairAuthority>(
    () =>
      directPairAuthorityFromQuery({
        answered: answeredPairIds,
        isFetching: directPairsQuery.isFetching,
        isError: directPairsQuery.isError,
      }),
    [answeredPairIds, directPairsQuery.isFetching, directPairsQuery.isError],
  );

  // Auto-select a workspace when chat is open without a workspace id.
  // Restore the one the user last had open (clicking the "Chat" navrail item
  // routes to bare `/chat`, dropping the workspaceId), falling back to the
  // first workspace only on a cold start (#task:1222).
  // Replace so the bare /chat URL doesn't pile up in history.
  //
  // Since #task:2042 the workspace arm is the SECOND question this effect asks.
  // The rail has two restorable arms, and the viewer's last one may have been a
  // direct line, which has no workspace to auto-pick: picking one anyway is how
  // a DM selection got silently traded for a channel. The order (and the "wait
  // for the pair list rather than guess" rule) lives in the pure
  // `resolveChatPlaceRestore`; this effect executes its action.
  useEffect(() => {
    if (appSection !== 'chat' || view !== 'channel') return;
    // `/chat/d/:id` is a chat-channel URL with NO workspace on purpose
    // (#task:2035) — a `direct_pair` has no workspace to auto-pick, so this
    // restore would navigate the user straight out of the DM they just opened.
    // The absent workspace is the route's meaning here, not a gap to fill.
    if (directConversationId) return;
    // Same for the pre-mint draft `/chat/d/new/:agentId` (#task:2039): a line that
    // does not exist yet has no workspace either, and the pair it mints will not
    // have one.
    if (directDraftAgentId) return;
    if (selectedWorkspaceId) return;
    const restore = resolveChatPlaceRestore({
      place: getLastChatPlace(),
      pairs: directPairAuthority,
    });
    // Hold the bare route: the pair list is still answering whether that line is
    // still the viewer's. One extra render of `/chat` is cheaper than a
    // navigation that has to be taken back.
    if (restore.kind === 'wait') return;
    if (restore.kind === 'open-direct') {
      nav.go(routes.chatDirect(restore.conversationId), { replace: true });
      return;
    }
    if (workspaces.length === 0) return;
    const target = pickWorkspaceToRestore(
      workspaces,
      lastSelectedWorkspaceId.current,
    );
    if (target) nav.go(`/chat/w/${target}`, { replace: true });
  }, [
    appSection,
    view,
    directConversationId,
    directDraftAgentId,
    selectedWorkspaceId,
    directPairAuthority,
    workspaces,
    nav.go,
  ]);

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
    // returned action. A channel just removed from the primary pane (archived,
    // or self-left from a private channel) that cleared selection is excluded
    // from BOTH the remembered and fallback branch — the stale lists can still
    // contain it until the query invalidation lands, and re-selecting it would
    // undo the clear (#task:1145). Scoped to the same workspace the
    // removal happened in.
    const excludeId =
      recentlyRemovedPrimaryRef.current?.workspaceId === selectedWorkspaceId
        ? recentlyRemovedPrimaryRef.current.channelId
        : null;
    // On the restore path the remembered channel's unread pointer is consulted
    // best-effort — if the workspace's unread data hasn't loaded yet it
    // degrades to layout memory rather than waiting (#task:1082).
    const rememberedChannelId =
      lastChannelByWorkspace.get(selectedWorkspaceId) ?? null;
    const action = resolveRestoreNavigation({
      workspaceId: selectedWorkspaceId,
      selectedChannelId,
      allChannels: channels,
      activeTopLevel: memberActiveChannels,
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
    memberActiveChannels,
    jumpTarget,
    nav.go,
  ]);

  // Release the recently-removed exclusion once the active list no longer
  // contains it (the archive/leave invalidation has refetched) — from then on
  // the id is genuinely gone and the auto-select effect needs no special-casing
  // (#task:1145).
  useEffect(() => {
    const rec = recentlyRemovedPrimaryRef.current;
    if (rec && !activeChannels.some(c => c.id === rec.channelId)) {
      recentlyRemovedPrimaryRef.current = null;
    }
  }, [activeChannels]);

  // Selection-persistence side-effects (#task:1295): last-viewed-channel
  // memory, the Chat rail's last ARM (#task:2042), recent-opened sort stamps
  // (channel + workspace rail), and the members/chat last-selected memory —
  // lifted into a hook so `App` stays a thinner composition root; the high-risk
  // restore / auto-select / layout-watermark effects deliberately stay inline.
  useSelectionPersistenceEffects({
    selectedWorkspaceId,
    selectedChannelId,
    selectedAgentId,
    chatSectionActive: appSection === 'chat',
    directConversationId,
    directDraftAgentId,
    activeChannels: memberActiveChannels,
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
  //
  // NOT RECORDED for a `direct_pair` (#task:2035): layout memory exists to
  // restore a channel's secondary pane, and a pair withholds every pane this
  // could restore — the threads/attachments indexes do not resolve server-side
  // for a pair, so a remembered entry could only resurrect a pane that never
  // mounts. Skipping the WRITE is what closes it: the only readers
  // (`handleSelectChannel` + the workspace restore effect) are workspace-keyed,
  // so with no entry ever stored there is nothing to restore and
  // `buildChannelLayoutUrl` keeps its non-null workspace contract.
  //
  // `?side` is deliberately unaffected: it is a LIVE in-session overlay written
  // onto the current pathname by a `#conv:` chip click and resolved from the SIDE
  // id alone (`useConversationById`), so nothing about it depends on the primary
  // pane's placement and a pair can host one while it is open. What is withheld
  // is the MEMORY — leaving the pair does not bring it back, because nothing was
  // recorded.
  const prevLayoutRef = useRef<{
    channelId: string;
    kind: ChannelLayout['kind'];
  } | null>(null);
  useEffect(() => {
    if (!selectedChannelId || directConversationId !== null) {
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
    directConversationId,
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

  const hostsQuery = useHostsQuery();

  const backendInfoQuery = useBackendInfoSnapshot({
    pollProtocolCompatibility: true,
  });
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
  // Resolve the selected conversation's per-viewer membership ONCE, from the
  // shared three-state authority, so the open ThreadPanel consumes exactly
  // what ChannelView does — a thread inherits its parent channel's membership.
  // The `.membership` three-state (not a collapsed boolean) is what gates the
  // member-only panes below, so `unknown` stays neutral and never fails open;
  // `.gate` is the derived affordance set the ThreadPanel takes, so the panel
  // re-derives nothing.
  // Fires no extra fetch on the member hot path (the carrier already stamps
  // `is_member`). The direct-pair argument is keyed on the ROUTE, not on the
  // resolved row: while the pair list is still cold there is no carrier, and
  // without it the hook would fall back to `GET /api/channels/:id` for an id
  // that is not a channel — a guaranteed 404 on every DM open.
  const parentMembership = useChannelMembership(
    selectedChannel,
    selectedChannelId,
    directConversationId !== null
      ? { readOnly: directPair?.read_only === true }
      : null,
  );
  const parentChannelMembership = parentMembership.membership;

  const channelIndexesAvailable = selectedChannelId !== null;
  const filesListMounted =
    channelIndexesAvailable &&
    mountsMemberOnlyPanel(filesListOpen, parentChannelMembership);
  const threadsListMounted =
    channelIndexesAvailable &&
    mountsMemberOnlyPanel(threadsListOpen, parentChannelMembership);
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
  // `directPairResolving` is the same window on the workspace-less arm, reported
  // by that arm's own carrier because its list is the only thing that can answer
  // (#task:2035).
  const parentChannelResolving =
    directPairResolving ||
    (deferredChannelId != null &&
      deferredSelectedChannel == null &&
      activeChannelsLoading);

  const deferredSection = useDeferredValue(appSection);
  const conversationRefsById = useMemo(() => {
    // `channels` is the CURRENT WORKSPACE's channel list — that scope is what
    // entitles every consumer to draw these as channels (#task:2077, see
    // {@link WorkspaceChannelReference}). Feeding this map from any other list
    // would mis-label, not fail.
    const m = new Map<string, WorkspaceChannelReference>();
    for (const item of channels) {
      m.set(item.id, {
        id: item.id,
        title: item.title,
      });
    }
    return m;
  }, [channels]);

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
  }, [visiblePrimary?.id]);
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
  }, [visibleSecondary?.id]);

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
    const pointer = unreadCounts?.latest_by_workspace?.[id];
    if (pointer) {
      handleJumpToMessage({
        channelId: pointer.conversation_id,
        messageId: pointer.message_id,
        // Carry the reply cluster's root when the newest unread is a thread
        // reply — otherwise the jump anchors the reply id against the mainline
        // stream (404) and never enters the thread observe/mark-read path, so
        // the badge never clears (#task:1519). `handleSelectChannel` already
        // threads its `threadRootId` through; the workspace-badge entry must
        // match — every unread-pointer jump carries `thread_root_id`.
        threadRootId: pointer.thread_root_id ?? undefined,
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

  // Open a task's detail. `taskId` says WHICH task; the HOST — pane vs modal —
  // says FROM WHERE it was opened, and the two are ORTHOGONAL. The entrance
  // chooses the host EXPLICITLY, never inferred from live UI or from whether the
  // id changed: a conversation `#task` chip and a conversation Tasks-tab card both
  // open the overlay side pane beside the conversation; the global Tasks board
  // opens the app-level modal. `taskHost` records that choice, so re-opening the
  // SAME task from a different entrance still switches surface even though `?task`
  // is unchanged. Every entrance hands over the RESOLVED `tasks.id`; `?task=<id>`
  // is the whole coordinate — no workspace axis travels with the click.
  const [taskHost, setTaskHost] = useState<{
    id: string;
    host: 'pane' | 'modal';
  } | null>(null);
  const openTask = useCallback(
    (taskId: string, host: 'pane' | 'modal') => {
      setTaskHost({ id: taskId, host });
      nav.openTask(taskId);
    },
    [nav.openTask],
  );
  // Ref-stable per-entrance openers. `nav.openTask` is rebuilt on every
  // navigation (it closes over the current pathname/search), so `openTask`'s
  // identity changes with the route; the ref keeps these two wrappers constant so
  // they don't re-render memoized consumers (the Tasks board's ~1356 cards, the
  // chat message list). Same pattern/reason as `handleJumpToMessageStable` below.
  const openTaskRef = useRef(openTask);
  openTaskRef.current = openTask;
  const openTaskInPane = useCallback(
    (taskId: string) => openTaskRef.current(taskId, 'pane'),
    [],
  );
  const openTaskInModal = useCallback(
    (taskId: string) => openTaskRef.current(taskId, 'modal'),
    [],
  );

  // Resolve which surface shows `?task=<id>`. The recorded host wins whenever it
  // matches the live pointer (an opener set it — the explicit entrance). A pointer
  // with NO recorded host is a cold deep-link / URL restore: classify it ONCE by
  // the URL's own surface — a channel-chat URL anchors a pane, anywhere else a
  // modal. The effect below freezes the first cold classification into `taskHost`,
  // so it is computed once and never re-derived as the page shifts under a live
  // pointer (that id-change/live-UI inference was the BLOCKER Cindy caught: it made
  // a board card on the SAME task a no-op, leaving the pane instead of opening the
  // modal).
  const coldTaskHost: 'pane' | 'modal' =
    appSection === 'chat' && view === 'channel' && selectedChannelId !== null
      ? 'pane'
      : 'modal';
  const resolvedTaskHost: 'pane' | 'modal' | null =
    taskDetailId === null
      ? null
      : taskHost && taskHost.id === taskDetailId
        ? taskHost.host
        : coldTaskHost;
  useEffect(() => {
    if (taskDetailId === null) {
      // Pointer gone — drop any recorded host so a reopen re-classifies fresh.
      if (taskHost !== null) setTaskHost(null);
    } else if (!taskHost || taskHost.id !== taskDetailId) {
      // Cold-load only: no opener recorded a host for this pointer. Freeze the
      // URL-surface classification so subsequent renders read it, not `coldTaskHost`.
      setTaskHost({ id: taskDetailId, host: coldTaskHost });
    }
  }, [taskDetailId, taskHost, coldTaskHost]);
  const taskPaneId = resolvedTaskHost === 'pane' ? taskDetailId : null;
  const taskModalId = resolvedTaskHost === 'modal' ? taskDetailId : null;

  // The task pane's single request-close owner, shared by its header ✕ and the
  // ⌘W rung so the "editing → don't tear it down" contract lives in ONE place
  // instead of being guarded on one path and forgotten on the other (Cindy
  // review, #task:1721). It mirrors the modal's close gate: while an inline
  // field editor is open the close is refused — the ✕ click still blurs the
  // field, firing its save, and a failed save keeps the draft + inline error
  // rather than being unmounted mid-flight. The pane reports its editing state
  // into a ref (not state): the gate is read at click/keypress time and must
  // never re-render App. Leaving the task context by a channel switch is a
  // separate, unadjudicated question and is deliberately NOT handled here.
  const taskPaneEditingRef = useRef(false);
  const setTaskPaneEditing = useCallback((editing: boolean) => {
    taskPaneEditingRef.current = editing;
  }, []);
  const requestCloseTaskPane = useCallback(() => {
    if (taskPaneEditingRef.current) return;
    nav.closeTask();
  }, [nav]);

  // One-shot relay for an md/html click in the Attachments list → the primary
  // pane's previewer tab (#task:2122). The list is a sibling pane and can't reach
  // that pane's tab controller, so it hands the attachment here; the primary
  // ChannelView consumes it and clears it back to null. Carries the SOURCE
  // conversation id: the primary pane may render a beat later, after a route
  // switch, and it drops a request whose source no longer matches the mounted
  // conversation (never routes A's file into B's tabs). Wrapped in a fresh object
  // per click so re-opening the same file isn't swallowed by state identity.
  const [paneAttachmentRequest, setPaneAttachmentRequest] = useState<{
    conversationId: string;
    attachment: AttachmentSnapshot;
  } | null>(null);

  // ⌘W ladder. Called here (not with the other early hooks) because it needs
  // `taskPaneId` to know whether the task shows as the peelable side pane or the
  // self-dismissing modal. Route + nav are read through a ref inside, so the
  // relocation only affects hook order, not freshness. `closeTask` is the
  // guarded owner above (not raw `nav.closeTask`), so ⌘W honours the same
  // editing gate as the ✕ — the two explicit closes go through one owner.
  useContextualCloseResponder(
    { ...route, filesListOpen: filesListMounted, threadsListOpen: threadsListMounted },
    { ...nav, closeTask: requestCloseTaskPane },
    taskPaneId !== null,
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

  /**
   * Jump to a message, RETURNING whether it actually navigated.
   *
   * The boolean is a contract, not a convenience: a caller that also owns a URL
   * pointer (the task detail modal's `?task=`) must not both navigate and strip
   * the pointer — that is two navigations for one action, and the second one is
   * built off the pre-navigation location, so it can undo the first (Cindy
   * BLOCKER 3). Exactly two exits do not navigate: an inline channel find on the
   * already-open channel, and an unresolvable workspace.
   */
  const handleJumpToMessage = (params: MessageJumpTarget): boolean => {
    // Classify the jump BEFORE any side effect. `requestJump` below is NOT free:
    // it POSTs `markRead` (an irreversible server write that clears the
    // conversation's unread) and stashes a `jumpTarget` that later scroll-locates
    // whichever conversation next opens. So a target we are going to REFUSE must
    // do none of that — the fail-closed branch returns ABOVE
    // `requestJump`, not below it.
    //
    // Inline channel find is the ONE exemption: it never navigates,
    // priming IS its whole function, and it must NOT consult the pair list —
    // `ChannelView` passes a DM's own `workspace_id ?? undefined`, so a DM inline
    // find is workspace-less and would otherwise fail-closed during any pair-list
    // refetch. It is identified here and left UNCLASSIFIED so it still primes.
    const isInlineFind = !!params.preserveSidePanel && !params.threadRootId;
    // A jump target carries no placement — only ids — so a workspace-less
    // conversation is classified against the one carrier that knows: the viewer's
    // direct-pair AUTHORITY. It rides `directPairAuthority`, not the
    // raw `directPairIds` set, because a cold/failed pair read holds an EMPTY set
    // that a bare `.has()` cannot tell apart from "answered, not a pair"; guessing
    // the selected workspace for a pair id builds a channel URL under a workspace
    // the conversation isn't in. Only a workspace-LESS target consults the list; a
    // target with its own workspace id is a channel jump, never gated on the list.
    // Notification and Activity DM clicks land here.
    const jumpNav = isInlineFind
      ? null
      : resolveJumpNav({
          hasWorkspaceCoordinate: !!params.workspaceId,
          channelId: params.channelId,
          pairs: directPairAuthority,
        });
    // Not answered for a workspace-less target: refuse WITHOUT touching anything —
    // above `requestJump`, so no unread is cleared and no jumpTarget is stashed.
    if (jumpNav === 'fail-closed') return false;

    requestJump(params);

    if (isInlineFind) return false;

    const route = resolveJumpRoute({
      decision: jumpNav === 'to-direct' ? 'to-direct' : 'workspace-resolve',
      channelId: params.channelId,
      navWorkspaceId: resolveNavWorkspaceId(params.workspaceId, params.channelId),
      threadRootId: params.threadRootId,
    });
    if (!route) return false;

    const basePath = jumpBasePath(appSection, route);
    nav.go(withThreadQuery(basePath, '', route.threadRootId));

    return true;
  };

  const jumpToMessageRef = useRef(handleJumpToMessage);
  jumpToMessageRef.current = handleJumpToMessage;
  const handleJumpToMessageStable = useCallback(
    (params: MessageJumpTarget) => jumpToMessageRef.current(params),
    [],
  );

  const handleWorkspaceDeleted = (deletedId: string): void => {
    const destination = workspaceDeletionDestination(workspaces, deletedId, selectedWorkspaceId);
    switch (destination.kind) {
      case 'stay': return;
      case 'workspace': nav.toWorkspace(destination.workspaceId); return;
      case 'chat': nav.toChat(); return;
    }
  };

  const buildChannelDescriptor = useCallback(
    (s: ChannelListItem | null): ConversationPaneDescriptor | null =>
      s && isWorkspacePlaced(s)
        ? {
            id: s.id,
            title: s.title,
            placement_kind: s.placement_kind,
            roster_policy: s.roster_policy,
            closed_at: s.closed_at,
            archived_at: s.archived_at,
            workspace_id: s.workspace_id,
            is_member: s.is_member,
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

  const handleMessageAgent = useCallback(
    (agentId: string): void => {
      const existing = findAgentDirectPair(directPairs, agentId);
      if (existing) {
        nav.toDirect(existing.conversation_id);
        return;
      }
      nav.toDirectDraft(agentId);
    },
    [directPairs, nav.toDirect, nav.toDirectDraft],
  );

  // The draft's exit: the id the first send (or a line that turned out to exist)
  // hands back. `replace`, because `/chat/d/new/:agentId` is a pre-mint stand-in
  // for exactly this route — leaving it in history would give Back a draft for a
  // line that now exists.
  const handleDraftOpenedPair = useCallback(
    (conversationId: string): void => {
      nav.go(routes.chatDirect(conversationId), { replace: true });
    },
    [nav.go],
  );

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
                // `memberActiveChannels` here still includes the just-archived
                // channel (a channel you can archive is one you've joined, so it
                // is member-scoped; the list invalidation hasn't landed yet) —
                // exactly what the neighbor-aware picker needs to find its
                // siblings. Scoped to members so the archive fallback never
                // auto-selects a browse-only public channel.
                const fallbackId = pickFallbackAfterArchive(
                  memberActiveChannels,
                  channelId,
                );
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
                // it in `recentlyRemovedPrimaryRef` so the effect's
                // *fallback* branch also excludes it (#task:1145).
                recentlyRemovedPrimaryRef.current = {
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
      memberActiveChannels,
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

  // Async so the settings dialog can await + surface the toggle error inline
  // (rejects on 403 when the viewer isn't an admin, or a 400 same-value no-op
  // never fires because the modal only submits the OTHER visibility).
  const handleSetChannelVisibilityMutation = useCallback(
    async (channelId: string, visibility: ConversationVisibility) => {
      await setChannelVisibility.mutateAsync({
        channelId,
        visibility,
        workspaceId: selectedWorkspaceId ?? undefined,
      });
    },
    [setChannelVisibility, selectedWorkspaceId],
  );

  // Async so the settings dialog can await + surface a leave rejection inline.
  // On success the mutation converges the workspace list in place; here we only
  // move the primary pane when the just-left channel was PRIVATE (it drops from
  // discovery, so staying would strand the pane). A PUBLIC leave keeps the
  // channel readable — the view collapses to the Join bar in place, no nav.
  const handleLeaveChannelMutation = useCallback(
    async (channelId: string) => {
      const res = await leaveChannel.mutateAsync(channelId);
      const isPrivate =
        res.channel.roster_policy === 'open' && res.channel.visibility === 'private';
      if (!isPrivate) return;
      // Same ladder a third-party removal uses (`departPrimaryPane`): next/prev
      // neighbor, else clear to the workspace empty state. It no-ops when the
      // left channel isn't the primary selection.
      departPrimaryPane(channelId);
    },
    [leaveChannel, departPrimaryPane],
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
  // The workspace-less arm of the same pane (#task:2035). Built from the pair
  // carrier, and the counterpart IS the title — a `direct_pair` holds no
  // `title_key`, so its name is resolved once here (the same presentation the
  // sidebar row uses) instead of each surface inventing a label.
  const directPairDescriptor = useMemo(
    () =>
      directPair
        ? directPairPaneDescriptor(
            directPair,
            presentCounterpart(directPair.counterpart).label,
          )
        : null,
    [directPair],
  );
  // Which descriptor the primary pane renders. Exactly one arm can be live: the
  // route names either a workspace channel or a pair, never both. NOT deferred on
  // the pair arm — the defer exists to keep a channel↔channel switch from
  // blocking the sidebar highlight commit, and the pair descriptor is built from
  // a viewer-global list that a channel switch doesn't touch.
  const primaryPaneDescriptor = directPairDescriptor ?? deferredParentDescriptor;
  // What a pane hanging off the primary conversation may show (#task:2098). A
  // thread is not a conversation and has no placement of its own, so it INHERITS
  // this projection instead of re-deriving one — and it is projected from the very
  // descriptor `ChannelView` is handed below, which is what makes mainline and
  // thread structurally unable to disagree about the same conversation.
  const primaryPaneCapabilities = useMemo(
    () => inheritedPaneCapabilities(primaryPaneDescriptor),
    [primaryPaneDescriptor],
  );
  // A pair has no workspace, so it has no `#` channel namespace either — and that
  // is exactly what the pane reads as "not a top-level channel-like conversation"
  // (no rename/archive/visibility), which is the truth for a `direct_pair`
  // (#task:2078 turned this from a workspace KIND into the one bit those consumers
  // ever read).
  const hasChannelNamespace = workspaceResolved;
  const primaryPaneHasChannelNamespace = directPairDescriptor
    ? false
    : hasChannelNamespace;
  // The thread composer's candidate directory, inherited from the SAME parent
  // descriptor as `primaryPaneCapabilities` (#task:2147) — a thread has no
  // placement of its own. Carries the parent's resolved workspace coordinate; a
  // `direct_pair` parent projects to the `viewer` arm (coordinate ignored), a null
  // parent to `withheld`.
  const primaryThreadComposerDirectory = useMemo(
    () =>
      inheritedComposerDirectory(primaryPaneDescriptor, {
        workspaceName: workspaceNameById(primaryPaneDescriptor?.workspace_id ?? null),
        hasChannelNamespace: primaryPaneHasChannelNamespace,
      }),
    [primaryPaneDescriptor, workspaceNameById, primaryPaneHasChannelNamespace],
  );
  // Single pure mapping from `secondaryDescriptor` into the props
  // ChannelView consumes for the secondary pane. Keeps the cross-workspace
  // wiring (foreign workspace_id / namespace bit / archive invalidation
  // target) end-to-end testable without renderHook.
  const secondaryViewInputs = useMemo(
    () =>
      selectSecondaryViewInputs({
        secondary: secondaryDescriptor,
        primaryHasChannelNamespace: hasChannelNamespace,
        primaryWorkspaceId: selectedWorkspaceId,
      }),
    [secondaryDescriptor, hasChannelNamespace, selectedWorkspaceId],
  );
  const secondaryConversationDescriptor = secondaryViewInputs.conversationDescriptor;
  // Which row the sidebar paints as selected. A resolved secondary holds focus, so
  // it owns the highlight — but only when its row is in this sidebar, which the two
  // placements answer differently (see the selector).
  const sidebarSelectedConversationId = selectSidebarSelectedConversationId({
    primarySelectedChannelId: selectedChannelId,
    secondary: secondaryDescriptor,
    primaryWorkspaceId: selectedWorkspaceId,
  });

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

  const parentView = directDraftAgentId ? (
    // The pre-mint direct line (#task:2039). Its own pane rather than a
    // `ChannelView` with a synthetic descriptor: every conversation-keyed reader
    // ChannelView owns (messages, roster, read cursor, attachments) would be
    // asking about an id that does not exist yet. It renders the same chrome, and
    // the first send replaces this route with the pair's own.
    // Keyed by agent identity: the draft (and the send's error/pending state) is
    // ABOUT one agent, so `/new/A → /new/B` must remount rather than re-use the
    // instance. Without this, text written to A survives into B's pane and one
    // Enter sends it to the wrong agent (@Cindy, #task:2039 review).
    <DirectPairDraftPane
      key={directDraftAgentId}
      agentId={directDraftAgentId}
      onOpenPair={handleDraftOpenedPair}
    />
  ) : (
    <ChannelView
      hasChannelNamespace={primaryPaneHasChannelNamespace}
      workspaceName={workspaceNameById(primaryPaneDescriptor?.workspace_id ?? null)}
      conversation={primaryPaneDescriptor}
      resolving={parentChannelResolving}
      // The pair arm's failed read (#task:2035 B8): neither a loader nor "Select
      // a channel" would be true — the first promises an answer that is not
      // coming, the second claims the viewer chose nothing.
      loadFailed={directPairLoadFailed}
      // …and its ANSWERED absence: `/chat/d/<bad or no-longer-visible id>`. The
      // route named a conversation and the authority said no, so this is neither
      // a wait nor a failure nor "you chose nothing".
      notFound={directPairNotFound}
      parentTitle={null}
      jumpTarget={parentJumpTarget}
      jumpPrimePending={parentJumpPrimePending}
      onJumped={handleJumped}
      // Reply clusters resolve through the backend's `getChannelLike`, which
      // spans every top-level placement — a `direct_pair` included (#task:2096).
      // So the primary pane always offers "open thread"; `handleOpenThreadFromChannel`
      // already tolerates a workspace-less conversation (`selectedWorkspaceId ??
      // undefined`). Secondary panes withhold it at their own call sites.
      onOpenThread={handleOpenThreadFromChannel}
      // Threads-list pane toggle (#task:1073). The primary pane gets it for any
      // open top-level conversation — a workspace `channel` and a workspace-less
      // `direct_pair` alike carry a channel-scoped thread index (the backend's
      // threads route resolves via `getChannelLike`, #task:2096). `primaryPaneDescriptor`
      // is the resolved descriptor for whichever arm is open, so the toggle waits
      // for it rather than for the workspace arm specifically. Thread / dm-side /
      // `?side` *secondary* primaries don't get it (they aren't the index).
      onToggleThreadsList={
        channelIndexesAvailable && primaryPaneDescriptor != null
          ? nav.toggleThreadsList
          : undefined
      }
      threadsListActive={threadsListMounted}
      // Attachments-list pane toggle. Same gate as threads: any open top-level
      // conversation (channel or `direct_pair`) carries a channel-scoped
      // attachments index; thread / dm-side / `?side` secondary primaries don't.
      onToggleFilesList={
        channelIndexesAvailable && primaryPaneDescriptor != null
          ? nav.toggleFilesList
          : undefined
      }
      filesListActive={filesListMounted}
      // Tasks moved from the old header Tasks button to the per-conversation
      // Tasks TAB (#task:2121) — the manual opener is the tab, so the header no
      // longer carries a Tasks button (dual navigation removed).
      onArchiveChannel={handleArchiveChannelMutation}
      onRenameChannel={handleRenameChannelMutation}
      onSetChannelVisibility={handleSetChannelVisibilityMutation}
      onLeaveChannel={handleLeaveChannelMutation}
      archivePending={archiveChannel.isPending}
      conversationRefsById={conversationRefsById}
      onOpenConversationRef={nav.openSide}
      onOpenChannelRef={handleOpenChannelByName}
      onOpenTask={openTaskInPane}
      onJumpToMessage={handleJumpToMessage}
      onOpenAdvancedSearch={handleOpenAdvancedSearch}
      // Per-conversation view tabs — primary pane only. A Tasks-tab card opens
      // task detail through `onOpenTask` above, the same side pane an inline
      // `#task` chip uses.
      viewTabsEnabled
      // A md/html click in the sibling Attachments list opens here, in the
      // primary pane's previewer tab (#task:2122). The list hands the attachment
      // up; ChannelView applies the same previewable + tab-strip gate the message
      // card uses, or falls back to open-with-OS.
      openAttachmentRequest={paneAttachmentRequest}
      onAttachmentRequestConsumed={() => setPaneAttachmentRequest(null)}
    />
  );

  // Secondary pane render shapes:
  //   - Resolved `?side` — a channel/dm_channel in ANY workspace, or a private
  //     line (#task:2038) → real ChannelView. The conversation descriptor's
  //     `workspace_id` carries the *foreign* workspace for cross-workspace
  //     `?side`, so ChannelView's workspace-scoped hooks auto-target the right
  //     cache without a separate prop; for a private line it is null, which
  //     withholds those hooks entirely.
  //   - Loading / unauthorized / not_found / unresolved (the identity
  //     resolution named no conversation) → SideUnresolvedPlaceholder.
  //   - null → no secondary, render only `parentView`.
  let secondaryView: JSX.Element | null = null;
  if (agentPanelId) {
    // Agent side panel (`?agent=<id>`, #task:1189). Renders an agent's compact
    // panel beside the channel so chat + the agent's Activity show together
    // (dual-screen). It is NOT a conversation, so it sits ahead of the
    // `secondaryDescriptor`/thread/threads-list chain. It OVERLAYS the
    // thread / threads-list pane rather than replacing it: `withAgentQuery`
    // preserves `?thread` / `?threads` so closing the panel restores whatever
    // was open (#task:1433). `?side` is the exception — cleared on open,
    // because a secondary conversation feeds notification suppression and
    // must not stay "visible" while covered. Activity locks to the current
    // channel (A — shiki).
    secondaryView = (
      <AgentView
        key={`side-${agentPanelId}`}
        variant="side"
        agentId={agentPanelId}
        contextConversationId={selectedChannelId}
        contextWorkspaceId={selectedWorkspaceId ?? null}
        onClose={nav.closeAgentPanel}
        onDeleted={nav.closeAgentPanel}
        // The same DM entry the full page offers (@shiki, #task:2039): reaching an
        // agent through the side panel must not be the one way that loses it.
        onMessageAgent={handleMessageAgent}
      />
    );
  } else if (filesListMounted && selectedChannelId) {
    // Channel Attachments panel (`?files=1`). An OVERLAY utility pane, so it
    // sits just below the agent panel in precedence (agent > files > task >
    // side > thread > threads) and ahead of the conversation panes: opening it
    // preserves `?thread` / `?threads` in the URL (cleared only `?side` /
    // `?agent`), so closing it reveals whatever conversation pane was
    // underneath — the URL is the restore stack (same model as `?agent`,
    // #task:1433). Not a conversation, so it doesn't feed
    // `secondaryDescriptor` / notification suppression. The row's main
    // click previews/opens the attachment; a separate locate button jumps
    // to the source message via the shared `handleJumpToMessage`.
    secondaryView = (
      <ChannelAttachmentsPanel
        channelId={selectedChannelId}
        // Null for a `direct_pair` (no workspace coordinate). The panel's core
        // attachments read is channel-scoped; the workspace only scopes the
        // sender-filter directory, which already treats null as "workspace-less"
        // (#task:2096).
        workspaceId={selectedWorkspaceId ?? null}
        parentTitle={selectedChannel?.title ?? null}
        onClose={nav.closeFilesList}
        onJumpToMessage={handleJumpToMessage}
        // md/html rows open in the primary pane's in-app previewer tab
        // (#task:2122) instead of open-with-OS. A fresh wrapper per click so a
        // re-click of the same file re-fires the one-shot (App.is-equal state
        // would otherwise swallow it). ChannelView owns the previewable/gate
        // decision; images (lightbox) and other files stay panel-local.
        onOpenAttachment={attachment =>
          setPaneAttachmentRequest({
            conversationId: selectedChannelId,
            attachment,
          })
        }
      />
    );
  } else if (taskPaneId && selectedChannelId) {
    // Task detail pane (`?task=<id>`, #task:1721). An OVERLAY pane like `?agent`
    // / `?files`: opening it cleared `?side` and the other overlays but PRESERVED
    // `?thread` / `?threads`, so it renders ahead of the side/thread/threads
    // chain and closing it reveals whatever conversation pane was underneath (the
    // URL is the restore stack). Not a conversation, so it doesn't feed
    // `secondaryDescriptor` / notification suppression. Rendered whenever this
    // pointer's frozen host is `pane`.
    secondaryView = (
      <TaskDetailPanel
        key={`task-${taskPaneId}`}
        taskId={taskPaneId}
        onClose={requestCloseTaskPane}
        onEditingChange={setTaskPaneEditing}
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
          hasChannelNamespace={secondaryViewInputs.hasChannelNamespace}
          workspaceName={workspaceNameById(secondaryConversationDescriptor.workspace_id)}
          conversation={secondaryConversationDescriptor}
          parentTitle={null}
          jumpTarget={secondaryJumpTarget}
          jumpPrimePending={secondaryJumpPrimePending}
          onJumped={handleJumped}
          onCloseChild={closeSecondary}
          // The secondary pane only ever renders a channel/dm `?side`
          // overlay, so the close affordance is the generic
          // "Close side pane" — never the thread wording.
          closeLabel="Close side pane"
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
          onOpenTask={openTaskInPane}
          // No thread open from the secondary pane: a reply cluster shares
          // its parent channel's context, so opening a thread only makes
          // sense from the primary channel pane. Undefined hides the reply
          // affordance on the side secondary pane.
          onOpenThread={undefined}
        />
      );
    }
  } else if (threadRootId && selectedChannelId) {
    // Thread pane (`?thread=<rootMessageId>`). A thread is NOT a
    // conversation — it shares the parent channel's context — so it does
    // not flow through `secondaryDescriptor`/`ChannelView`. It renders
    // only when no side/threads-list secondary is present (those win),
    // matching the nav-layer mutual exclusion (`openThread` clears `?side`).
    // A `direct_pair`'s reply cluster resolves via `getChannelLike` too, so it
    // mounts here with a null workspace — no workspace coordinate is required
    // (#task:2096); the panel's workspace-scoped facets already accept null.
    //
    // Captured into consts so the `onViewInChannel` closure keeps the
    // narrowed types (TS widens branch-narrowed `let`s back to
    // nullable inside a deferred callback).
    const threadChannelId = selectedChannelId;
    const threadWorkspaceId = selectedWorkspaceId ?? null;
    const threadRoot = threadRootId;
    secondaryView = (
      // The thread's affordances are the PARENT conversation's, provided here
      // because this pane does not flow through `ChannelView` and so would
      // otherwise read the context default — which is channel-shaped, and made a
      // DM thread start a roster read and answer `Not here` for an agent the
      // mainline showed as Online (#task:2098). Presence is not keyed by
      // placement; the roster's `Not here` answer is the one thing this gates.
      <ConversationPaneCapabilitiesProvider value={primaryPaneCapabilities}>
        <ThreadPanel
          channelId={threadChannelId}
          workspaceId={threadWorkspaceId}
          // The composer's `@`/`#` directory is INHERITED from the parent
          // conversation (#task:2147) — projected once by App from the same
          // descriptor `primaryPaneCapabilities` uses, never re-derived in the leaf.
          // A `direct_pair` parent yields the `viewer` arm (the viewer's own agents
          // + every channel they're in); a workspace parent yields that workspace's
          // members/channels; a null parent yields `withheld`, so a cold DM-thread
          // deep link never assumes a channel namespace.
          directory={primaryThreadComposerDirectory}
          rootMessageId={threadRoot}
          onOpenAttachment={attachment =>
            setPaneAttachmentRequest({
              conversationId: threadChannelId,
              attachment,
            })
          }
          parentTitle={selectedChannel?.title ?? null}
          closed={selectedChannelDescriptor?.closed_at != null}
          archived={selectedChannelDescriptor?.archived_at != null}
          // Thread reply/follow/react/save are member mutations.
          // Participation follows the PARENT channel's membership, and the panel
          // takes the gate ALREADY DERIVED from it (same object ChannelView's own
          // hook produces) so the two panes can't drift: `unknown` yields neither
          // composer nor Join, and the panel derives nothing itself.
          gate={parentMembership.gate}
          onClose={nav.closeThread}
          onViewInChannel={() => {
            // Scroll-locate + flash the root in the main channel stream,
            // then drop the thread pane so the channel is unobstructed.
            requestJump({
              workspaceId: threadWorkspaceId ?? undefined,
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
          onOpenTask={openTaskInPane}
          jumpMessageId={threadJumpMessageId}
          jumpPhase={threadJumpPhase}
          onJumped={handleJumped}
          onJumpToMessage={handleJumpToMessage}
          onOpenAdvancedSearch={handleOpenAdvancedSearch}
          // A DM thread's find seeds the SAME sender the mainline pair seeds
          // (#task:2114). Read from the pair carrier rather than projected from a
          // pane mode, for the reason the capabilities comment above gives: a
          // thread has no placement of its own. Null on the channel arm, where
          // `workspaceId` above is the expressible narrowing instead.
          advancedSearchSender={directPairSenderSeed(directPair?.counterpart)}
        />
      </ConversationPaneCapabilitiesProvider>
    );
  } else if (threadsListMounted && selectedChannelId) {
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
        parentTitle={selectedChannel?.title ?? null}
        onClose={nav.closeThreadsList}
        onOpenThread={nav.openThread}
      />
    );
  }

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{
        backgroundImage: 'var(--app-paper, none)',
        backgroundSize: '100vw 100vh',
        backgroundRepeat: 'no-repeat',
      }}
    >
      <Titlebar
        workspaceName={titlebarWorkspaceName}
        workspaceArchivedAt={selectedWorkspace?.archived_at ?? null}
        workspaceSidebarVisible={workspaceSidebarVisible}
        onToggleWorkspaceSidebar={toggleWorkspaceSidebar}
        chromeMode={appSection === 'activity' ? 'activity' : 'chat'}
      />
      <div
        className="flex min-w-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-app, transparent)',
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
        <div
          data-section-sheet=""
          className="flex min-w-0 flex-1"
          style={{ gap: 'var(--pane-gap)' }}
        >
          {deferredSection === 'settings' && (
            <SectionLayer visible={appSection !== 'chat'}>
              <SettingsPage />
            </SectionLayer>
          )}
          {deferredSection === 'tasks' && (
            <SectionLayer visible={appSection !== 'chat'}>
              <TasksSection onOpenTask={openTaskInModal} />
            </SectionLayer>
          )}
          {deferredSection === 'members' && (
            <SectionLayer visible={appSection !== 'chat'}>
            <SectionShell
              name="members"
              width="var(--sidebar-width)"
              sidebar={
                <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">
                  <MembersPanel
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={id => nav.toMembers(id)}
                    selectedUserId={selectedUserId}
                    onSelectUser={id => nav.toMembersUser(id)}
                  />
                </nav>
              }
            >
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
                  onMessageAgent={handleMessageAgent}
                  onOpenConversation={s =>
                    openAgentConversation(s.channel_id, s.workspace_id)
                  }
                  onOpenChat={t =>
                    openAgentConversation(t.conversationId, t.workspaceId)
                  }
                />
              ) : (
                <main
                  className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
                  style={{ ...paneChrome, overflow: 'hidden' }}
                >
                  Select an agent to see its details
                </main>
              )}
            </SectionShell>
            </SectionLayer>
          )}
          {deferredSection === 'computers' && (
            <SectionLayer visible={appSection !== 'chat'}>
            <SectionShell
              name="computers"
              width="var(--sidebar-width)"
              sidebar={
                <nav className="scrollbar-hide flex-1 overflow-y-auto py-1.5">
                  <ComputersPanel
                    hosts={computerHosts}
                    localHostId={localHostIdForComputers}
                    isLoading={hostsQuery.isLoading}
                    selectedHostId={selectedHostId}
                    onSelectHost={setSelectedHostId}
                    onAddComputer={() => setNewComputerOpen(true)}
                  />
                </nav>
              }
            >
              {selectedHost ? (
                <HostDetailView key={selectedHost.id} host={selectedHost} />
              ) : (
                <main
                  className="flex h-full flex-1 items-center justify-center bg-bg-base text-sm text-text-muted"
                  style={{ ...paneChrome, overflow: 'hidden' }}
                >
                  {hostsQuery.isLoading
                    ? 'Loading computers…'
                    : 'Select a computer to see its details'}
                </main>
              )}
            </SectionShell>
            </SectionLayer>
          )}
          {deferredSection === 'activity' && (
            <SectionLayer visible={appSection !== 'chat'}>
            <SectionShell
              name="activity"
              fill={selectedChannelId == null}
              width="var(--activity-list-width)"
              sidebar={
                <ActivityView
                  workspaceRefById={workspaceRefById}
                  agentsById={agentsById}
                  onJump={handleJumpToMessageStable}
                />
              }
              splitter={
                selectedChannelId != null ? (
                  <VerticalSplitter
                    onPointerDown={activityList.startResize}
                    active={activityList.isDragging}
                  />
                ) : null
              }
            >
              {selectedChannelId != null ? (
                appSection === 'activity' ? (
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
                )
              ) : null}
            </SectionShell>
            </SectionLayer>
          )}
          {(appSection === 'chat' || deferredSection === 'chat') && (
            <SectionLayer visible>
            <>
              <div
                className="sidebar-slot"
                data-animating={
                  SIDEBAR_ANIMATE_LAYOUT && workspaceSidebarPane.transitioning
                    ? 'true'
                    : undefined
                }
                data-performance-variant={SIDEBAR_PERFORMANCE_VARIANT}
                style={{
                  flexBasis: workspaceSidebarVisible
                    ? 'var(--sidebar-width)'
                    : '0px',
                  // When hidden, eat the right-side flex gap so the sheet's
                  // `gap: var(--pane-gap)` doesn't render twice (once on
                  // each side of the 0-width slot). Animates alongside
                  // flex-basis so the collapse stays smooth end-to-end.
                  marginRight: workspaceSidebarVisible
                    ? '0px'
                    : 'calc(-1 * var(--pane-gap))',
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
                        owner_agent_id: w.owner_agent_id,
                        unread: attentionBadges?.by_workspace?.[w.id] ?? 0,
                        // Both row signals come from the ONE roll-up (#task:1870):
                        // the count and the mute marker must never disagree about
                        // the same workspace.
                        muted:
                          attentionBadges?.muted_workspace_ids?.includes(w.id) ??
                          false,
                        archived: w.archived_at !== null,
                        created_at: w.created_at,
                      }))}
                      agentsById={agentsById}
                      selectedWorkspaceId={selectedWorkspaceId}
                      // The tree's ONE selection object. Carries forward the
                      // secondary-pane preference the retired channel column owned;
                      // `selectSidebarSelectedConversationId` holds the rule (a
                      // resolved secondary owns the highlight only when its row is
                      // in this sidebar — always true for a private line, which
                      // lives in the workspace-independent DIRECT MESSAGES list).
                      selectedChannelId={sidebarSelectedConversationId}
                      onSelectChannel={handleSelectChannel}
                      // A pair has no workspace to open it in, so it takes the
                      // workspace-less route directly. No remembered-layout
                      // restore: the panes that memory replays (thread /
                      // threads-list / side) are channel-scoped, so there is
                      // nothing recorded for a pair to restore (#task:2035).
                      onSelectDirectPair={nav.toDirect}
                      // The transient draft row (#task:2039) re-opens THE DRAFT,
                      // never the pair: while the draft route is open that row is
                      // the draft's (`mergeDirectLineRows`), and it holds unsent
                      // text or a failed first send. Routing it through
                      // `handleMessageAgent` — which prefers an existing pair —
                      // would discard both (@Cindy, #task:2039 review).
                      directDraftAgentId={directDraftAgentId}
                      onSelectDirectDraft={nav.toDirectDraft}
                      onCreateChannel={setCreateChannelWorkspaceId}
                      onOpenWorkspaceSettings={setWorkspaceSettingsId}
                      // STARRED is global, so the parent workspace is explicit —
                      // `handleSelectChannel` then opens a starred channel in another
                      // workspace with the SAME remembered-layout restore as its home
                      // row, instead of a bare jump.
                      onSelectConversation={(workspaceId, conversationId) =>
                        handleSelectChannel(conversationId, workspaceId)
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
                  onOpenWorkspace={handleSelectWorkspace}
                  onOpenWorkspaceSettings={setWorkspaceSettingsId}
                />
              ) : (
                <>
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
        open={createChannelWorkspaceId !== null}
        onOpenChange={open => {
          if (!open) setCreateChannelWorkspaceId(null);
        }}
        workspaceId={createChannelWorkspace?.id ?? null}
        capabilities={workspaceCapabilities(createChannelWorkspace)}
        onCreated={id => {
          if (createChannelWorkspaceId) nav.toChannel(createChannelWorkspaceId, id);
        }}
      />
      <WorkspaceSettingsDialog
        key={workspaceSettingsId ?? 'closed'}
        open={workspaceSettingsId !== null && settingsWorkspace !== null}
        onOpenChange={open => { if (!open) setWorkspaceSettingsId(null); }}
        workspaceId={settingsWorkspace?.id ?? null}
        workspaceName={settingsWorkspace?.name ?? null}
        capabilities={workspaceCapabilities(settingsWorkspace)}
        archivedAt={settingsWorkspace?.archived_at ?? null}
        onDeleted={() => { if (workspaceSettingsId) handleWorkspaceDeleted(workspaceSettingsId); }}
      />
      <TaskDetailDialog
        taskId={taskModalId}
        onOpenChange={next => {
          if (!next) nav.closeTask();
        }}
        onJump={target => {
          const navigated = handleJumpToMessage(target);
          // ONE navigation owner per action: the jump above already replaced the
          // location, and a fresh channel path carries no query — `?task` is
          // gone with it. Clearing the pointer separately would be a second
          // navigation built off the PRE-jump location, which can undo the
          // first. So it is only needed on the exits that navigated nothing
          // (inline find on the open channel, unresolvable workspace), where the
          // modal would otherwise stay open over a view it never moved.
          if (!navigated) nav.closeTask();
        }}
      />
      {/* Toast surface follows the active theme: `theme` picks sonner's
        * light/dark default scale, and global.css maps its fill / text /
        * border / radius onto our tokens (forza6 gets the ink frame). No
        * `richColors` — that paints the whole toast in sonner's own hue
        * palette; instead the surface stays neutral and the type icon carries
        * the semantic, matching AppStatusBanner. Icons come from the shared
        * lib/toast-icons authority; only sonner's typed levels have map slots
        * here — neutral `toast()` calls pass their own icon from the same
        * table. */}
      <Toaster
        position="top-right"
        theme={toasterTheme}
        icons={toasterTypedIcons}
        offset={TOAST_OFFSET}
        mobileOffset={TOAST_MOBILE_OFFSET}
      />

      <AppStatusBanner />

      {/* Shutdown progress overlay — shown during graceful quit so the
        * user sees activity instead of a frozen window. Rendered above
        * everything and not dismissible — the app is closing. */}
      {shutdownStep !== null ? (
        <div className="fixed inset-0 z-[var(--z-toolbar)] flex items-center justify-center bg-bg-base/30 backdrop-blur-[1px]">
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
                  Quitting Silverhand
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
