import { useCallback, useEffect, useRef } from 'react';

import type { ConversationVisibility } from '@silverhand/shared';

import {
  useArchiveChannel,
  useRenameChannel,
  useLeaveChannel,
  useSetChannelVisibility,
  type ChannelListItem,
} from '@/features/workspaces/hooks';

import {
  useForeignWorkspaceChannelRemovalSync,
  useViewerChannelRemovalSync,
} from '@/features/channels/useViewerChannelRemovalSync';

import { useNav, useRouteState } from '@/router';
import { lastChannelByWorkspace, persistLastChannel } from '@/lib/place-memory';

import { pickFallbackAfterArchive } from '@/lib/archive-fallback';

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

  const archiveChannel = useArchiveChannel(selectedWorkspaceId ?? null);

  const renameChannel = useRenameChannel(selectedWorkspaceId ?? null);

  const leaveChannel = useLeaveChannel(selectedWorkspaceId ?? null);

  const setChannelVisibility = useSetChannelVisibility(selectedWorkspaceId ?? null);

  const handleArchiveChannelMutation = useCallback(
    (channelId: string, archived: boolean) => {
      const movesPrimary = archived && channelId === selectedChannelId;
      archiveChannel.mutate(
        { channelId, archived, workspaceId: selectedWorkspaceId ?? undefined },
        movesPrimary ? { onSuccess: () => departPrimaryPane(channelId) } : undefined,
      );
    },
    [archiveChannel, selectedChannelId, selectedWorkspaceId, departPrimaryPane],
  );

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

  const handleLeaveChannelMutation = useCallback(
    async (channelId: string) => {
      const res = await leaveChannel.mutateAsync(channelId);
      const isPrivate =
        res.channel.roster_policy === 'open' && res.channel.visibility === 'private';
      if (!isPrivate) {
        return;
      }
      // Same ladder a third-party removal uses (`departPrimaryPane`): next/prev
      // neighbor, else clear to the workspace empty state. It no-ops when the
      // left channel isn't the primary selection.
      departPrimaryPane(channelId);
    },
    [leaveChannel, departPrimaryPane],
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
    archiveChannel,
    renameChannel,
    handleArchiveChannelMutation,
    handleRenameChannelMutation,
    handleSetChannelVisibilityMutation,
    handleLeaveChannelMutation,
  };
}
