import { useMemo } from "react";
import type { DirectPairCounterpart } from "@silverhand/shared";
import { useDirectPairsList } from "@/features/direct-pairs/hooks";
import { directLinePairVisibleInSidebar } from "@/features/direct-pairs/direct-line-rows";
import { useChannelsAcrossWorkspaces, useWorkspaces } from "@/features/workspaces/hooks";
import { orderRecentRows } from "./recent-rows";
import { useConversationLatest, type ConversationLatest } from "./use-conversation-latest";

export type RecentConversation =
  | {
      kind: "channel";
      id: string;
      createdAt: number;
      latest: ConversationLatest | null;
      title: string;
      workspaceId: string;
      workspaceName: string;
    }
  | {
      kind: "direct";
      id: string;
      createdAt: number;
      latest: ConversationLatest | null;
      counterpart: DirectPairCounterpart;
    };

const NO_PINS: ReadonlySet<string> = new Set();

/** Every conversation the viewer is in, newest message first: the joined, live
 *  channels of each live project and the visible direct pairs. */
export function useRecentConversations(): RecentConversation[] {
  const workspaces = useWorkspaces().data;
  const live = useMemo(
    () => (workspaces ?? []).filter((w) => w.archived_at === null),
    [workspaces],
  );
  const workspaceIds = useMemo(() => live.map((w) => w.id), [live]);
  const channelLists = useChannelsAcrossWorkspaces(workspaceIds);
  const pairs = useDirectPairsList().data?.direct_pairs;
  const latest = useConversationLatest();

  const rows: RecentConversation[] = [];
  live.forEach((workspace, index) => {
    for (const channel of channelLists[index]?.data ?? []) {
      if (channel.is_member !== true || channel.archived_at !== null) {
        continue;
      }

      rows.push({
        kind: "channel",
        id: channel.id,
        createdAt: channel.created_at,
        latest: latest?.get(channel.id) ?? null,
        title: channel.title,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
    }
  });
  for (const pair of pairs ?? []) {
    if (!directLinePairVisibleInSidebar(pair)) {
      continue;
    }

    rows.push({
      kind: "direct",
      id: pair.conversation_id,
      createdAt: pair.created_at,
      latest: latest?.get(pair.conversation_id) ?? null,
      counterpart: pair.counterpart,
    });
  }

  return orderRecentRows(rows, NO_PINS);
}
