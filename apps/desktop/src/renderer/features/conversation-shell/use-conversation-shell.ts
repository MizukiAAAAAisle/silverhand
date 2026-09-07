import { useConversationJump } from './use-conversation-jump';
import { useConversationInvalidation } from './use-conversation-invalidation';
import { useChatRouteRecovery } from '@/features/chat-shell/use-chat-route-recovery';
import { resolveTaskDetailSurface } from '@/features/tasks/task-detail-surface';
import { senderFilterToParam } from '@/components/ui/sender-filter-select';
import type { AdvancedSearchSeed } from '@/features/search/advanced-search-seed';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLayoutSettings } from '@/hooks/useLayoutSettings';
import type { WorkspaceChannelReference } from '@/components/chat/ConversationRef';
import { isWorkspacePlaced } from '@silverhand/shared';
import type { AttachmentSnapshot } from '@silverhand/shared';
import { useAgents } from '@/features/agents/hooks';
import { useLayoutKeyboardShortcuts } from '@/features/app-shell/effects';
import { useContextualCloseResponder } from '@/features/app-shell/keyboard-shortcuts';
import { useSecondaryPaneModel } from '@/features/app-shell/secondary-pane-model';

import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  type ChannelListItem,
} from '@/features/workspaces/hooks';
import { useSavedMessages } from '@/features/saved/hooks';
import { useNotificationToasts } from '@/features/notifications/hooks';
import { useMarkMessageChannelRead, useMessageUnreadCounts } from '@/features/channels/hooks';
import { isMemberChannel, mountsMemberOnlyPanel } from '@/features/channels/membership';

import { useChannelMembership } from '@/features/channels/use-channel-membership';

import {
  selectSecondaryViewInputs,
  selectSidebarSelectedConversationId,
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
import {
  directPairPaneProps,
  findAgentDirectPair,
  useDirectPairPane,
  useDirectPairsList,
} from '@/features/direct-pairs/hooks';
import { presentCounterpart } from '@/features/direct-pairs/counterpart-presentation';
import {
  buildChannelLayoutUrl,
  buildChannelPathPreservingAgent,
  routes,
  useNav,
  useRouteState,
} from '@/router';
import { getChannelLayout, getCloseWatermark } from '@/lib/place-memory';
import { directPairAuthorityFromQuery, type DirectPairAuthority } from '@/lib/chat-place-restore';

import { resolveChannelOpen } from '@/lib/channel-open';

import { agentSpaceRecognitionName } from '@/lib/workspace-name';
import { isAgentSpace } from '@/features/workspaces/workspace-ownership';
import type { useApplicationSignals } from '@/features/app-shell/application-signals';

/** Shared by Chat and Activity; remains mounted when either presentation is deferred. */
export function useConversationShell({
  attentionBadges,
  unreadCounts,
}: Pick<ReturnType<typeof useApplicationSignals>, 'attentionBadges' | 'unreadCounts'>) {
  const { layout, toggleWorkspaceSidebar } = useLayoutSettings();

  const route = useRouteState();

  const nav = useNav();

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
    agentPanelId,
  } = route;

  const workspaceSidebarPane = layout.workspaceSidebar;

  const workspaceSidebarVisible = workspaceSidebarPane.visible;

  useLayoutKeyboardShortcuts(toggleWorkspaceSidebar, appSection === 'chat');

  const lastSelectedMessageReadKey = useRef<string | null>(null);

  const lastThreadMessageReadKey = useRef<string | null>(null);

  const { data: workspaces = [] } = useWorkspaces();

  const visibleWorkspaceIds = useMemo(
    () => workspaces.map((workspace) => workspace.id),
    [workspaces],
  );

  const { data: agents = [] } = useAgents();

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  const workspaceNameById = useCallback(
    (wid: string | null): string | null =>
      wid === null ? null : locatorWorkspaceName(workspaces.find((w) => w.id === wid)),
    [workspaces],
  );

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

  const workspaceRefById = useMemo(
    () =>
      new Map(
        workspaces.map(
          (w) =>
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

  const workspaceResolved = !!selectedWorkspace;

  const {
    data: activeChannels = [] as ChannelListItem[],
    isLoading: activeChannelsLoading,
    status: activeChannelsStatus,
    fetchStatus: activeChannelsFetchStatus,
  } = useChannelsForWorkspace(selectedWorkspaceId, workspaceResolved);

  const {
    data: archivedChannels = [] as ChannelListItem[],
    status: archivedChannelsStatus,
    fetchStatus: archivedChannelsFetchStatus,
  } = useArchivedChannelsForWorkspace(selectedWorkspaceId, workspaceResolved);

  const channels = useMemo<ChannelListItem[]>(
    () => [...activeChannels, ...archivedChannels],
    [activeChannels, archivedChannels],
  );

  const memberActiveChannels = useMemo(
    () => activeChannels.filter(isMemberChannel),
    [activeChannels],
  );

  const {
    recentlyRemovedPrimaryRef,
    archiveChannel,
    renameChannel,
    handleArchiveChannelMutation,
    handleRenameChannelMutation,
    handleSetChannelVisibilityMutation,
    handleLeaveChannelMutation,
  } = useConversationInvalidation({
    activeChannels,
    archivedChannels,
    memberActiveChannels,
    activeSettled: activeChannelsStatus === 'success' && activeChannelsFetchStatus === 'idle',
    archivedSettled: archivedChannelsStatus === 'success' && archivedChannelsFetchStatus === 'idle',
    visibleWorkspaceIds,
  });
  const { data: savedItems } = useSavedMessages();

  const { data: messageUnreadData } = useMessageUnreadCounts(
    selectedWorkspaceId,
    workspaceResolved,
  );

  const directPairsQuery = useDirectPairsList();

  const directPairs = directPairsQuery.data?.direct_pairs ?? [];

  const directPairPane = directPairPaneProps(useDirectPairPane(directConversationId));

  const directPair = directPairPane.pair;

  const directPairResolving = directPairPane.resolving;

  const directPairLoadFailed = directPairPane.loadFailed;

  const directPairNotFound = directPairPane.notFound;

  const directPairIds = useMemo(
    () => new Set(directPairs.map((p) => p.conversation_id)),
    [directPairs],
  );

  const primaryPointer = useMemo<ConversationPointer | null>(() => {
    // `roster_policy` is not a lookup here: a `direct_pair` is minted `fixed`
    // (`conversation-repo.ts`) and its two endpoints are the placement itself,
    // so the value is a property of the KIND, not of the row.
    if (directPair) {
      return { id: directPair.conversation_id, rosterPolicy: 'fixed' };
    }
    if (!selectedChannelId) {
      return null;
    }
    const hit = channels.find((c) => c.id === selectedChannelId);
    return hit ? { id: hit.id, rosterPolicy: hit.roster_policy } : null;
  }, [directPair, channels, selectedChannelId]);

  const { secondaryDescriptor, visibleConversations, focusedConversation } = useSecondaryPaneModel({
    primary: primaryPointer,
    sideConversationId,
    selectedWorkspaceId,
    routeFullscreen,
  });

  const markMessageChannelRead = useMarkMessageChannelRead();

  useNotificationToasts(focusedConversation?.id ?? null, (target) => handleJumpToMessage(target));

  const resolveNavWorkspaceId = (
    workspaceId: string | undefined,
    channelId?: string | null,
  ): string | null => {
    if (!workspaceId) {
      return selectedWorkspaceId;
    }
    if (workspaces.some((w) => w.id === workspaceId)) {
      return workspaceId;
    }
    const owningAgentSpace = workspaces.find((w) => {
      if (!isAgentSpace(w)) {
        return false;
      }
      if (w.dm_channel_ids.includes(workspaceId)) {
        return true;
      }
      return !!channelId && w.dm_channel_ids.includes(channelId);
    });
    return owningAgentSpace?.id ?? workspaceId;
  };

  const openAgentConversation = (conversationId: string, workspaceId: string | null): void => {
    if (workspaceId === null) {
      nav.toDirect(conversationId);
      return;
    }
    const wid = resolveNavWorkspaceId(workspaceId, conversationId);
    if (!wid) {
      return;
    }
    nav.toChannel(wid, conversationId);
  };

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

  const {
    jumpTarget,
    requestJump,
    isPrimePendingFor,
    primePhaseFor,
    handleJumpToMessage,
    handleJumpToMessageStable,
    handleJumped,
  } = useConversationJump(directPairAuthority, resolveNavWorkspaceId);

  useChatRouteRecovery({
    workspaces,
    channels,
    memberActiveChannels,
    messageUnreadData,
    directPairAuthority,
    jumpTarget,
    onJump: (target) => handleJumpToMessage(target),
    recentlyRemovedPrimaryRef,
  });
  const selectedChannel = channels.find((s) => s.id === selectedChannelId) ?? null;

  const parentMembership = useChannelMembership(
    selectedChannel,
    selectedChannelId,
    directConversationId !== null ? { readOnly: directPair?.read_only === true } : null,
  );

  const parentChannelMembership = parentMembership.membership;

  const channelIndexesAvailable = selectedChannelId !== null;

  const filesListMounted =
    channelIndexesAvailable && mountsMemberOnlyPanel(filesListOpen, parentChannelMembership);

  const threadsListMounted =
    channelIndexesAvailable && mountsMemberOnlyPanel(threadsListOpen, parentChannelMembership);

  const deferredChannelId = useDeferredValue(selectedChannelId);

  const deferredSelectedChannel = channels.find((s) => s.id === deferredChannelId) ?? null;

  const parentChannelResolving =
    directPairResolving ||
    (deferredChannelId != null && deferredSelectedChannel == null && activeChannelsLoading);

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

  const visiblePrimary = visibleConversations.primary;

  const visibleSecondary = visibleConversations.secondary;

  useEffect(() => {
    if (!visiblePrimary) {
      lastSelectedMessageReadKey.current = null;
      return;
    }
    const readKey = visiblePrimary.id;
    if (lastSelectedMessageReadKey.current === readKey) {
      return;
    }
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
    if (lastThreadMessageReadKey.current === readKey) {
      return;
    }
    lastThreadMessageReadKey.current = readKey;
    markMessageChannelRead.mutate(visibleSecondary.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSecondary?.id]);

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

  const handleSelectChannel = (
    id: string,
    workspaceId: string | null = selectedWorkspaceId,
  ): void => {
    if (!workspaceId) {
      return;
    }
    const sameWorkspace = workspaceId === selectedWorkspaceId;
    // A=Activity-follows-channel (#task:1189): while an agent side panel is
    // docked it owns the right pane, so switching the left channel must keep
    // `?agent` and just re-point the locked Activity context — not restore that
    // channel's remembered thread/side (which would drop the panel). Only
    // same-workspace: a cross-workspace open switches workspace anyway and the
    // docked agent panel can't follow it.
    if (sameWorkspace && agentPanelId) {
      nav.go(buildChannelPathPreservingAgent(workspaceId, id, agentPanelId));
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

  const openTaskRef = useRef(nav.openTask);
  openTaskRef.current = nav.openTask;

  const openTaskInPane = useCallback((taskId: string) => openTaskRef.current(taskId), []);
  const taskPaneId = resolveTaskDetailSurface(route) === 'pane' ? taskDetailId : null;

  const taskPaneEditingRef = useRef(false);

  const setTaskPaneEditing = useCallback((editing: boolean) => {
    taskPaneEditingRef.current = editing;
  }, []);

  const requestCloseTaskPane = useCallback(() => {
    if (taskPaneEditingRef.current) {
      return;
    }
    nav.closeTask();
  }, [nav]);

  const [paneAttachmentRequest, setPaneAttachmentRequest] = useState<{
    conversationId: string;
    attachment: AttachmentSnapshot;
  } | null>(null);

  useContextualCloseResponder(
    { ...route, filesListOpen: filesListMounted, threadsListOpen: threadsListMounted },
    { ...nav, closeTask: requestCloseTaskPane },
    taskPaneId !== null,
  );

  const handleOpenChannelByName = useCallback(
    (workspaceId: string, channelId: string) => {
      // Preserve the docked agent panel across a `#<channel>` jump too, so A
      // stays consistent: clicking a channel ref re-points the panel's Activity
      // context instead of closing it (#task:1189).
      if (agentPanelId) {
        nav.go(buildChannelPathPreservingAgent(workspaceId, channelId, agentPanelId));
        return;
      }
      nav.toChannel(workspaceId, channelId);
    },
    [agentPanelId, nav.go, nav.toChannel],
  );

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

  const handleDraftOpenedPair = useCallback(
    (conversationId: string): void => {
      nav.go(routes.chatDirect(conversationId), { replace: true });
    },
    [nav.go],
  );

  const selectedChannelDescriptor = useMemo(
    () => buildChannelDescriptor(selectedChannel),
    [buildChannelDescriptor, selectedChannel],
  );

  const deferredParentDescriptor = useMemo(
    () => buildChannelDescriptor(deferredSelectedChannel),
    [buildChannelDescriptor, deferredSelectedChannel],
  );

  const directPairDescriptor = useMemo(
    () =>
      directPair
        ? directPairPaneDescriptor(directPair, presentCounterpart(directPair.counterpart).label)
        : null,
    [directPair],
  );

  const primaryPaneDescriptor = directPairDescriptor ?? deferredParentDescriptor;

  const primaryPaneCapabilities = useMemo(
    () => inheritedPaneCapabilities(primaryPaneDescriptor),
    [primaryPaneDescriptor],
  );

  const hasChannelNamespace = workspaceResolved;

  const primaryPaneHasChannelNamespace = directPairDescriptor ? false : hasChannelNamespace;

  const primaryThreadComposerDirectory = useMemo(
    () =>
      inheritedComposerDirectory(primaryPaneDescriptor, {
        workspaceName: workspaceNameById(primaryPaneDescriptor?.workspace_id ?? null),
        hasChannelNamespace: primaryPaneHasChannelNamespace,
      }),
    [primaryPaneDescriptor, workspaceNameById, primaryPaneHasChannelNamespace],
  );

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

  const sidebarSelectedConversationId = selectSidebarSelectedConversationId({
    primarySelectedChannelId: selectedChannelId,
    secondary: secondaryDescriptor,
    primaryWorkspaceId: selectedWorkspaceId,
  });

  const handleArchiveSecondaryChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      const wid = secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      archiveChannel.mutate({ channelId, archived, workspaceId: wid });
    },
    [archiveChannel, secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  const handleRenameSecondaryChannelMutation = useCallback(
    async (channelId: string, title: string) => {
      const wid = secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      await renameChannel.mutateAsync({ channelId, title, workspaceId: wid });
    },
    [renameChannel, secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  const parentJumpTarget = useMemo(
    () =>
      jumpTarget && !jumpTarget.threadRootId && jumpTarget.channelId === deferredChannelId
        ? { channelId: jumpTarget.channelId, messageId: jumpTarget.messageId }
        : null,
    [jumpTarget, deferredChannelId],
  );

  const secondaryJumpTarget: { channelId: string; messageId: string } | null = null;

  const secondaryJumpPrimePending = false;

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

  const parentJumpPrimePending = useMemo(
    () =>
      parentJumpTarget !== null &&
      isPrimePendingFor(parentJumpTarget.channelId, parentJumpTarget.messageId),
    [isPrimePendingFor, parentJumpTarget],
  );

  const threadJumpPhase = useMemo(
    () =>
      threadJumpMessageId !== null && selectedChannelId !== null
        ? primePhaseFor(selectedChannelId, threadJumpMessageId)
        : null,
    [primePhaseFor, threadJumpMessageId, selectedChannelId],
  );

  const handleOpenThreadFromChannel = (rootMessageId: string, jumpToMessageId?: string): void => {
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

  return {
    chat: {
      route,
      nav,
      appSection,
      view,
      selectedWorkspaceId,

      directDraftAgentId,
      workspaceSidebarPane,
      workspaceSidebarVisible,

      workspaces,
      agentsById,

      savedItems,

      attentionBadges,
      resolveNavWorkspaceId,
      deferredSection,
      handleSelectWorkspace,
      handleSelectChannel,
      handleJumpToMessage,

      sidebarSelectedConversationId,
    },
    activity: {
      appSection,
      selectedChannelId,
      agentsById,
      workspaceRefById,
      deferredSection,
      handleJumpToMessageStable,
    },
    panes: {
      nav,
      selectedWorkspaceId,
      selectedChannelId,
      directDraftAgentId,
      threadRootId,
      agentPanelId,

      requestJump,
      workspaceNameById,
      archiveChannel,
      handleOpenAdvancedSearch,
      directPair,
      directPairLoadFailed,
      directPairNotFound,
      secondaryDescriptor,
      selectedChannel,
      parentMembership,
      channelIndexesAvailable,
      filesListMounted,
      threadsListMounted,
      parentChannelResolving,
      conversationRefsById,
      openTaskInPane,
      taskPaneId,
      setTaskPaneEditing,
      requestCloseTaskPane,
      paneAttachmentRequest,
      setPaneAttachmentRequest,
      handleOpenChannelByName,
      handleJumpToMessage,
      closeSecondary,
      handleMessageAgent,
      handleDraftOpenedPair,
      handleJumped,
      handleArchiveChannelMutation,
      handleRenameChannelMutation,
      handleSetChannelVisibilityMutation,
      handleLeaveChannelMutation,
      selectedChannelDescriptor,
      primaryPaneDescriptor,
      primaryPaneCapabilities,

      primaryPaneHasChannelNamespace,
      primaryThreadComposerDirectory,
      secondaryViewInputs,
      secondaryConversationDescriptor,
      handleArchiveSecondaryChannelMutation,
      handleRenameSecondaryChannelMutation,
      parentJumpTarget,
      secondaryJumpTarget,
      secondaryJumpPrimePending,
      threadJumpMessageId,
      parentJumpPrimePending,
      threadJumpPhase,
      handleOpenThreadFromChannel,
    },
    app: {
      toggleWorkspaceSidebar,
      nav,
      appSection,
      workspaceSidebarVisible,
      selectedWorkspace,
      titlebarWorkspaceName,
      openAgentConversation,
      deferredSection,
      handleJumpToMessage,
      handleMessageAgent,
      secondaryDescriptor,
      routeFullscreen,
    },
  };
}
export type ConversationShellModel = ReturnType<typeof useConversationShell>;
