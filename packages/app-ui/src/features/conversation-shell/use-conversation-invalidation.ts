import { useCallback, useEffect, useRef } from "react";

import { type ChannelListItem } from "@/features/workspaces/hooks";

import {
  useForeignWorkspaceChannelRemovalSync,
  useViewerChannelRemovalSync,
} from "@/features/channels/use-viewer-channel-removal-sync";

import { useNav, useRouteState } from "@/router";
import { lastChannelByWorkspace, persistLastChannel } from "@/features/app-shell/place-memory";

import { pickFallbackAfterArchive } from "@/features/app-shell/archive-fallback";

export interface RemovedPrimary {
  workspaceId: string;
  channelId: string;
}
export function useConversationInvalidation({
  activeChannels,
  archivedChannels,
  memberActiveChannels,
  activeSettled,
  archivedSettled,
  visibleWorkspaceIds,
}: {
  activeChannels: ChannelListItem[];
  archivedChannels: ChannelListItem[];
  memberActiveChannels: ChannelListItem[];
  activeSettled: boolean;
  archivedSettled: boolean;
  visibleWorkspaceIds: string[];
}) {
  const { workspaceId: selectedWorkspaceId, channelId: selectedChannelId } = useRouteState();
  const nav = useNav();
  const recentlyRemovedPrimaryRef = useRef<{
    workspaceId: string;
    channelId: string;
  } | null>(null);

  const departPrimaryPane = useCallback(
    (channelId: string) => {
      if (channelId !== selectedChannelId) {
        return;
      }
      const wid = selectedWorkspaceId;
      if (!wid) {
        return;
      }
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
    [selectedChannelId, selectedWorkspaceId, memberActiveChannels, nav.toChannel, nav.toWorkspace],
  );

  useViewerChannelRemovalSync({
    workspaceId: selectedWorkspaceId,
    active: activeChannels,
    archived: archivedChannels,
    activeSettled: activeSettled,
    archivedSettled: archivedSettled,
    onVisibilityLoss: departPrimaryPane,
  });
  useForeignWorkspaceChannelRemovalSync({
    workspaceIds: visibleWorkspaceIds,
    selectedWorkspaceId,
  });
  useEffect(() => {
    const rec = recentlyRemovedPrimaryRef.current;
    if (rec && !activeChannels.some((c) => c.id === rec.channelId)) {
      recentlyRemovedPrimaryRef.current = null;
    }
  }, [activeChannels]);

  return {
    recentlyRemovedPrimaryRef,
    departPrimaryPane,
  };
}
