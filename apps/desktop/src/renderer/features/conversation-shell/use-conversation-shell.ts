import { buildConversationPanes } from "./build-conversation-panes";
import { senderFilterToParam } from "@/components/ui/sender-filter-select";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import { useLayoutKeyboardShortcuts } from "@/features/app-shell/effects";
import { useMessageUnreadCounts } from "@/features/channels/hooks";
import { useChatRouteRecovery } from "@/features/chat-shell/use-chat-route-recovery";
import { findAgentDirectPair } from "@/features/direct-pairs/hooks";
import { useNotificationToasts } from "@/features/notifications/hooks";
import { useSavedMessages } from "@/features/saved/hooks";
import type { AdvancedSearchSeed } from "@/features/search/advanced-search-seed";
import { useLayoutSettings } from "@/hooks/use-layout-settings";
import { resolveChannelOpen } from "@/features/conversation-shell/model/channel-open";
import { getChannelLayout, getCloseWatermark } from "@/features/app-shell/place-memory";
import {
  buildChannelLayoutUrl,
  buildChannelPathPreservingAgent,
  routes,
  useNav,
  useRouteState,
} from "@/router";
import { useCallback, useDeferredValue, useMemo } from "react";
import type { ConversationShellModel, ConversationShellSignals } from "./conversation-shell-models";
import { useConversationInvalidation } from "./use-conversation-invalidation";
import { useConversationJump } from "./use-conversation-jump";
import { useConversationPanes } from "./use-conversation-panes";
import { useConversationReadModel } from "./use-conversation-read-model";

/** Session-lived assembly: directory reads, pane effects and section-specific entry actions. */
export function useConversationShell({
  attentionBadges,
  unreadCounts,
}: ConversationShellSignals): ConversationShellModel {
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
    directDraftTarget,
    threadRootId,
    fullscreen: routeFullscreen,
    agentPanelId,
  } = route;

  const read = useConversationReadModel();

  const workspaceSidebarPane = layout.workspaceSidebar;

  const workspaceSidebarVisible = workspaceSidebarPane.visible;

  useLayoutKeyboardShortcuts(toggleWorkspaceSidebar, appSection === "chat");

  const { data: agents = [] } = useAgents();

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const {
    recentlyRemovedPrimaryRef,
    archiveChannel,
    renameChannel,
    handleArchiveChannelMutation,
    handleRenameChannelMutation,
    handleSetChannelVisibilityMutation,
    handleLeaveChannelMutation,
  } = useConversationInvalidation({
    activeChannels: read.activeChannels,
    archivedChannels: read.archivedChannels,
    memberActiveChannels: read.memberActiveChannels,
    activeSettled: read.activeSettled,
    archivedSettled: read.archivedSettled,
    visibleWorkspaceIds: read.visibleWorkspaceIds,
  });

  const { data: savedItems } = useSavedMessages();

  const { data: messageUnreadData } = useMessageUnreadCounts(
    selectedWorkspaceId,
    read.workspaceResolved,
  );

  const openAgentConversation = (conversationId: string, workspaceId: string | null): void => {
    if (workspaceId === null) {
      nav.toDirect(conversationId);
      return;
    }
    const wid = read.resolveNavWorkspaceId(workspaceId, conversationId);
    if (!wid) {
      return;
    }
    nav.toChannel(wid, conversationId);
  };

  const jump = useConversationJump(read.directPairAuthority, read.resolveNavWorkspaceId);
  const { jumpTarget, requestJump, handleJumpToMessage, handleJumpToMessageStable, handleJumped } =
    jump;

  useChatRouteRecovery({
    workspaces: read.workspaces,
    channels: read.channels,
    memberActiveChannels: read.memberActiveChannels,
    messageUnreadData,
    directPairAuthority: read.directPairAuthority,
    jumpTarget,
    onJump: (target) => handleJumpToMessage(target),
    recentlyRemovedPrimaryRef,
  });

  const panes = useConversationPanes(read, jump);

  useNotificationToasts(panes.focusedConversation?.id ?? null, (target) =>
    handleJumpToMessage(target),
  );

  const deferredSection = useDeferredValue(appSection);

  const handleSelectWorkspace = (id: string): void => {
    // If the workspace has unread mentions, jump straight to the latest
    // source message — that is what the user clicked the badge to see.
    // Falls back to the
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
    // Pane visibility effects advance read cursors. Keeping
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
    if (intent.kind === "unread-thread") {
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

  const handleMessageAgent = useCallback(
    (agentId: string): void => {
      const existing = findAgentDirectPair(read.directPairs, agentId);
      if (existing) {
        nav.toDirect(existing.conversation_id);
        return;
      }
      nav.toDirectDraft({ kind: "agent", id: agentId });
    },
    [read.directPairs, nav.toDirect, nav.toDirectDraft],
  );

  const handleDraftOpenedPair = useCallback(
    (conversationId: string): void => {
      nav.go(routes.chatDirect(conversationId), { replace: true });
    },
    [nav.go],
  );

  const handleArchiveSecondaryChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      const wid = panes.secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      archiveChannel.mutate({ channelId, archived, workspaceId: wid });
    },
    [archiveChannel, panes.secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  const handleRenameSecondaryChannelMutation = useCallback(
    async (channelId: string, title: string) => {
      const wid = panes.secondaryViewInputs.archiveWorkspaceId ?? selectedWorkspaceId ?? undefined;
      await renameChannel.mutateAsync({ channelId, title, workspaceId: wid });
    },
    [renameChannel, panes.secondaryViewInputs.archiveWorkspaceId, selectedWorkspaceId],
  );

  return {
    chat: {
      route,
      nav,
      appSection,
      view,
      selectedWorkspaceId,

      directDraftTarget,
      workspaceSidebarPane,
      workspaceSidebarVisible,

      workspaces: read.workspaces,
      agentsById,

      savedItems,

      attentionBadges,
      resolveNavWorkspaceId: read.resolveNavWorkspaceId,
      deferredSection,
      handleSelectWorkspace,
      handleSelectChannel,
      handleJumpToMessage,

      sidebarSelectedConversationId: panes.sidebarSelectedConversationId,
    },
    activity: {
      appSection,
      selectedChannelId,
      agentsById,
      workspaceRefById: read.workspaceRefById,
      deferredSection,
      handleJumpToMessageStable,
    },
    panes: buildConversationPanes(
      route,
      read,
      {
        archivePending: archiveChannel.isPending,
        secondaryDescriptor: panes.secondaryDescriptor,
        channelIndexesAvailable: panes.channelIndexesAvailable,
        filesListMounted: panes.filesListMounted,
        threadsListMounted: panes.threadsListMounted,
        taskPaneId: panes.taskPaneId,
        paneAttachmentRequest: panes.paneAttachmentRequest,
        secondaryViewInputs: panes.secondaryViewInputs,
        secondaryConversationDescriptor: panes.secondaryConversationDescriptor,
        parentJumpTarget: panes.parentJumpTarget,
        secondaryJumpTarget: panes.secondaryJumpTarget,
        secondaryJumpPrimePending: panes.secondaryJumpPrimePending,
        threadJumpMessageId: panes.threadJumpMessageId,
        parentJumpPrimePending: panes.parentJumpPrimePending,
        threadJumpPhase: panes.threadJumpPhase,
      },
      {
        requestJump,
        handleOpenAdvancedSearch,
        openTaskInPane: panes.openTaskInPane,
        setTaskPaneEditing: panes.setTaskPaneEditing,
        requestCloseTaskPane: panes.requestCloseTaskPane,
        setPaneAttachmentRequest: panes.setPaneAttachmentRequest,
        handleOpenChannelByName,
        handleJumpToMessage,
        closeSecondary: panes.closeSecondary,
        handleMessageAgent,
        handleDraftOpenedPair,
        handleJumped,
        handleArchiveChannelMutation,
        handleRenameChannelMutation,
        handleSetChannelVisibilityMutation,
        handleLeaveChannelMutation,
        handleArchiveSecondaryChannelMutation,
        handleRenameSecondaryChannelMutation,
        handleOpenThreadFromChannel: panes.handleOpenThreadFromChannel,
        openSide: nav.openSide,
        toggleThreadsList: nav.toggleThreadsList,
        toggleFilesList: nav.toggleFilesList,
        closeAgentPanel: nav.closeAgentPanel,
        closeHumanPanel: nav.closeHumanPanel,
        closeFilesList: nav.closeFilesList,
        closeThread: nav.closeThread,
        closeThreadsList: nav.closeThreadsList,
        openThread: nav.openThread,
      },
    ),
    app: {
      toggleWorkspaceSidebar,
      nav,
      appSection,
      workspaceSidebarVisible,
      selectedWorkspace: read.selectedWorkspace,
      openAgentConversation,
      deferredSection,
      handleJumpToMessage,
      handleMessageAgent,
      resolveNavWorkspaceId: read.resolveNavWorkspaceId,
      secondaryDescriptor: panes.secondaryDescriptor,
      routeFullscreen,
    },
  };
}
