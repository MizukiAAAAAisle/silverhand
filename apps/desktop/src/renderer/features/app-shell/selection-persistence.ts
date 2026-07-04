import { useEffect, useRef, type MutableRefObject } from 'react';
import type { AgentDto } from '@silverhand/shared';
import {
  useTouchSort,
  type ChannelListItem,
  type WorkspaceListItem,
} from '@/features/workspaces/hooks';
import {
  lastChannelByWorkspace,
  persistLastChannel,
  recordLastWorkspace,
} from '@/lib/place-memory';

/**
 * Selection-persistence side-effects lifted out of `App` (#task:1295) so the
 * shell stays a thinner composition root. These are the low-coupling
 * view-state persistence effects — last-viewed-channel memory, recent-opened
 * sort stamps (channel + workspace rail), and members/chat last-selected
 * memory. Each effect body is preserved byte-for-byte and keeps its original
 * relative order, so hook order and behavior are unchanged; this is a pure
 * boundary extraction. The high-risk restore / auto-select / layout-watermark
 * effects deliberately stay inline in `App`.
 *
 * `lastSelectedWorkspaceId` / `lastSelectedAgentId` are passed in because they
 * are shared with effects that stay in `App` (the workspace-restore reader and
 * the members-default nav). The per-list touch dedup refs and the touch
 * mutation are private to this hook.
 */
export function useSelectionPersistenceEffects(params: {
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;
  selectedAgentId: string | null;
  activeChannels: ChannelListItem[];
  workspaces: WorkspaceListItem[];
  agents: AgentDto[];
  lastSelectedWorkspaceId: MutableRefObject<string | null>;
  lastSelectedAgentId: MutableRefObject<string | null>;
}): void {
  const {
    selectedWorkspaceId,
    selectedChannelId,
    selectedAgentId,
    activeChannels,
    workspaces,
    agents,
    lastSelectedWorkspaceId,
    lastSelectedAgentId,
  } = params;

  const touchSort = useTouchSort();
  // Dedup guard for the recent-opened touch ping (#task:1146): the last
  // `<workspaceId>:<channelId>` we stamped, so re-renders that don't change
  // the selection don't re-POST /api/sort/touch.
  const lastTouchedChannelRef = useRef<string | null>(null);
  // Same dedup for the workspace rail's recent-opened stamp (#task:1146).
  const lastTouchedWorkspaceRef = useRef<string | null>(null);

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

  // Stamp "recently opened" for the channel sort list whenever the viewer
  // selects a top-level channel (#task:1146). Recent = recently-OPENED by
  // this viewer, so the write-point is selection, not message activity.
  // Fire-and-forget + deduped per (workspace, channel) so a re-render with
  // the same selection doesn't re-ping; the reorder lands on the next list
  // fetch (no jump under the cursor).
  useEffect(() => {
    if (!selectedWorkspaceId || !selectedChannelId) return;
    const isTopLevel = activeChannels.some(c => c.id === selectedChannelId);
    if (!isTopLevel) return;
    const key = `${selectedWorkspaceId}:${selectedChannelId}`;
    if (lastTouchedChannelRef.current === key) return;
    lastTouchedChannelRef.current = key;
    touchSort.mutate({
      list_key: `channels:${selectedWorkspaceId}`,
      entity_id: selectedChannelId,
    });
  }, [selectedWorkspaceId, selectedChannelId, activeChannels]);

  // Stamp "recently opened" for the workspace rail whenever the viewer selects
  // a workspace (#task:1146). Same write-point (selection, not activity) +
  // fire-and-forget + per-workspace dedup as the channel stamp above. Archived
  // workspaces are out of the rail's sort scope, so skip them (the backend
  // filters them on read anyway, but this avoids the redundant POST).
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const ws = workspaces.find(w => w.id === selectedWorkspaceId);
    if (!ws || ws.archived_at !== null) return;
    if (lastTouchedWorkspaceRef.current === selectedWorkspaceId) return;
    lastTouchedWorkspaceRef.current = selectedWorkspaceId;
    touchSort.mutate({ list_key: 'workspaces', entity_id: selectedWorkspaceId });
  }, [selectedWorkspaceId, workspaces]);

  // Record the last valid agent selected in the members panel this run, so the
  // members-default effect (kept in `App`) can restore it on re-entry.
  useEffect(() => {
    if (!selectedAgentId) return;
    if (!agents.some(a => a.id === selectedAgentId)) return;
    lastSelectedAgentId.current = selectedAgentId;
  }, [agents, selectedAgentId]);

  // Remember the workspace the user is actively viewing so returning to the
  // chat section (via bare `/chat`) restores it rather than `workspaces[0]`.
  // Persist this through app restarts; ref-only memory regressed to the first
  // STARRED row after quitting and reopening (#task:1222/#task:1229).
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (!workspaces.some(w => w.id === selectedWorkspaceId)) return;
    if (lastSelectedWorkspaceId.current === selectedWorkspaceId) return;
    lastSelectedWorkspaceId.current = selectedWorkspaceId;
    recordLastWorkspace(selectedWorkspaceId);
  }, [workspaces, selectedWorkspaceId]);
}
