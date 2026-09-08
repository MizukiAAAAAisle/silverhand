import { useEffect, useRef } from "react";

import { useSelectionPersistenceEffects } from "@/features/app-shell/selection-persistence";
import { type ChannelListItem } from "@/features/workspaces/hooks";

import { useMessageUnreadCounts } from "@/features/channels/hooks";

import { type MessageJumpTarget } from "@/features/channels/useMessageJumpController";

import {
  buildChannelLayoutUrl,
  layoutMemoryFromRoute,
  routes,
  useNav,
  useRouteState,
  type ChannelLayout,
} from "@/router";
import {
  getChannelLayout,
  getCloseWatermark,
  getLastChatPlace,
  getLastWorkspaceId,
  lastChannelByWorkspace,
  recordChannelLayout,
  recordCloseWatermark,
} from "@/lib/place-memory";
import { resolveChatPlaceRestore, type DirectPairAuthority } from "@/lib/chat-place-restore";

import { pickWorkspaceToRestore } from "@/lib/workspace-restore";
import { resolveRestoreNavigation } from "@/lib/restore-navigation";

import type { RefObject } from "react";
import type { WorkspaceListItem } from "@/features/workspaces/hooks";
import type { RemovedPrimary } from "@/features/conversation-shell/use-conversation-invalidation";
export function useChatRouteRecovery({
  workspaces,
  channels,
  memberActiveChannels,
  messageUnreadData,
  directPairAuthority,
  jumpTarget,
  onJump,
  recentlyRemovedPrimaryRef,
}: {
  workspaces: WorkspaceListItem[];
  channels: ChannelListItem[];
  memberActiveChannels: ChannelListItem[];
  messageUnreadData: ReturnType<typeof useMessageUnreadCounts>["data"];
  directPairAuthority: DirectPairAuthority;
  jumpTarget: MessageJumpTarget | null;
  onJump: (target: MessageJumpTarget) => boolean;
  recentlyRemovedPrimaryRef: RefObject<RemovedPrimary | null>;
}) {
  const route = useRouteState();
  const nav = useNav();
  const {
    section: appSection,
    chatView: view,
    workspaceId: selectedWorkspaceId,
    channelId: selectedChannelId,
    directConversationId,
    directDraftAgentId,
    sideConversationId,
    threadRootId,
    threadsListOpen,
  } = route;
  const handleJumpToMessage = onJump;
  const lastSelectedWorkspaceId = useRef<string | null>(getLastWorkspaceId());
  useEffect(() => {
    if (appSection !== "chat" || view !== "channel") {
      return;
    }
    // `/chat/d/:id` is a chat-channel URL with NO workspace on purpose
    // (#task:2035) — a `direct_pair` has no workspace to auto-pick, so this
    // restore would navigate the user straight out of the DM they just opened.
    // The absent workspace is the route's meaning here, not a gap to fill.
    if (directConversationId) {
      return;
    }
    // Same for the pre-mint draft `/chat/d/new/:agentId` (#task:2039): a line that
    // does not exist yet has no workspace either, and the pair it mints will not
    // have one.
    if (directDraftAgentId) {
      return;
    }
    if (selectedWorkspaceId) {
      return;
    }
    const restore = resolveChatPlaceRestore({
      place: getLastChatPlace(),
      pairs: directPairAuthority,
    });
    // Hold the bare route: the pair list is still answering whether that line is
    // still the viewer's. One extra render of `/chat` is cheaper than a
    // navigation that has to be taken back.
    if (restore.kind === "wait") {
      return;
    }
    if (restore.kind === "open-direct") {
      nav.go(routes.chatDirect(restore.conversationId), { replace: true });
      return;
    }
    if (workspaces.length === 0) {
      return;
    }
    const target = pickWorkspaceToRestore(workspaces, lastSelectedWorkspaceId.current);
    if (target) {
      nav.go(`/chat/w/${target}`, { replace: true });
    }
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

  useEffect(() => {
    if (!selectedWorkspaceId || workspaces.length === 0) {
      return;
    }
    if (!workspaces.some((w) => w.id === selectedWorkspaceId)) {
      nav.go("/chat", { replace: true });
    }
  }, [selectedWorkspaceId, workspaces, nav.go]);

  useEffect(() => {
    // Chat-only: this restore drives `/chat/w/.../c/...` paths. The Activity
    // section is a peer navigator whose right pane stays empty until the user
    // picks a row (no auto-select) — restoring a channel here would hijack
    // `/activity/...` back into chat (#task:1394).
    if (appSection !== "chat") {
      return;
    }
    if (!selectedWorkspaceId) {
      return;
    }
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
    const rememberedChannelId = lastChannelByWorkspace.get(selectedWorkspaceId) ?? null;
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
      rememberedCloseWatermark: rememberedChannelId ? getCloseWatermark(rememberedChannelId) : null,
      rememberedLayout: rememberedChannelId ? getChannelLayout(rememberedChannelId) : null,
    });
    switch (action.kind) {
      case "none":
        return;
      case "open-channel":
        nav.go(`/chat/w/${selectedWorkspaceId}/c/${action.channelId}`, {
          replace: true,
        });
        return;
      case "open-remembered":
        nav.go(buildChannelLayoutUrl(selectedWorkspaceId, action.channelId, action.layout), {
          replace: true,
        });
        return;
      case "jump-unread":
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

  useSelectionPersistenceEffects({
    selectedWorkspaceId,
    selectedChannelId,
    chatSectionActive: appSection === "chat",
    directConversationId,
    directDraftAgentId,
    activeChannels: memberActiveChannels,
    workspaces,
    lastSelectedWorkspaceId,
  });

  const prevLayoutRef = useRef<{
    channelId: string;
    kind: ChannelLayout["kind"];
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
      prev.kind !== "none" &&
      layout.kind === "none"
    ) {
      const seq = messageUnreadData?.latest_by_conversation?.[selectedChannelId]?.seq;
      if (seq != null) {
        recordCloseWatermark(selectedChannelId, seq);
      }
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
}
