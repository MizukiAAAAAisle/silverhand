import type { DirectMessageTarget } from "@/features/direct-pairs/target";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  useTouchSort,
  type ChannelListItem,
  type WorkspaceListItem,
} from "@/features/workspaces/hooks";
import {
  lastChannelByWorkspace,
  persistLastChannel,
  recordLastChatPlace,
  recordLastWorkspace,
} from "@/features/app-shell/place-memory";
import { chatPlaceForRoute } from "@/features/chat-shell/model/chat-place-restore";

/** Chat selection memory and recent-opened stamps. Page-specific selection lives in its Shell. */
export function useSelectionPersistenceEffects(params: {
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;
  chatSectionActive: boolean;
  directConversationId: string | null;
  directDraftTarget: DirectMessageTarget | null;
  activeChannels: ChannelListItem[];
  workspaces: WorkspaceListItem[];
  lastSelectedWorkspaceId: MutableRefObject<string | null>;
}): void {
  const {
    selectedWorkspaceId,
    selectedChannelId,
    chatSectionActive,
    directConversationId,
    directDraftTarget,
    activeChannels,
    workspaces,
    lastSelectedWorkspaceId,
  } = params;

  const touchSort = useTouchSort();
  // Dedup guard for the recent-opened touch ping (#task:1146): the last
  // `<workspaceId>:<channelId>` we stamped, so re-renders that don't change
  // the selection don't re-POST /api/sort/touch.
  const lastTouchedChannelRef = useRef<string | null>(null);

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

  // Record WHICH ARM of the Chat rail is open (#task:2042), beside the
  // workspace-keyed memory above rather than inside it: a direct line has no
  // workspace, so the effect above cannot see it, and stuffing a pair id into a
  // workspace-keyed map is exactly the drift #task:2035 closed. The arm decision
  // itself is pure (`chatPlaceForRoute`) — a null means "nothing worth
  // remembering", including the pre-mint draft route, so passing through the
  // rail's own restore never overwrites what it is restoring.
  useEffect(() => {
    const place = chatPlaceForRoute({
      chatSectionActive,
      directDraftTarget,
      directConversationId,
      selectedWorkspaceId,
    });
    if (place === null) return;
    recordLastChatPlace(place);
  }, [chatSectionActive, directDraftTarget, directConversationId, selectedWorkspaceId]);

  // Stamp "recently opened" for the channel sort list whenever the viewer
  // selects a top-level channel (#task:1146). Recent = recently-OPENED by
  // this viewer, so the write-point is selection, not message activity.
  // Fire-and-forget + deduped per (workspace, channel) so a re-render with
  // the same selection doesn't re-ping; the reorder lands on the next list
  // fetch (no jump under the cursor).
  useEffect(() => {
    if (!selectedWorkspaceId || !selectedChannelId) return;
    const isTopLevel = activeChannels.some((c) => c.id === selectedChannelId);
    if (!isTopLevel) return;
    const key = `${selectedWorkspaceId}:${selectedChannelId}`;
    if (lastTouchedChannelRef.current === key) return;
    lastTouchedChannelRef.current = key;
    touchSort.mutate({
      list_key: `channels:${selectedWorkspaceId}`,
      entity_id: selectedChannelId,
    });
  }, [selectedWorkspaceId, selectedChannelId, activeChannels]);

  // Remember the workspace the user is actively viewing so returning to the
  // chat section (via bare `/chat`) restores it rather than `workspaces[0]`.
  // Persist this through app restarts; ref-only memory regressed to the first
  // STARRED row after quitting and reopening (#task:1222/#task:1229).
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (!workspaces.some((w) => w.id === selectedWorkspaceId)) return;
    if (lastSelectedWorkspaceId.current === selectedWorkspaceId) return;
    lastSelectedWorkspaceId.current = selectedWorkspaceId;
    recordLastWorkspace(selectedWorkspaceId);
  }, [workspaces, selectedWorkspaceId]);
}
