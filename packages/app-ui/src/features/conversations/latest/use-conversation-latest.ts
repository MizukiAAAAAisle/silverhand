import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CONVERSATION_LATEST_CHANGED_EVENT,
  ConversationLatestDtoSchema,
  apiPaths,
  type ConversationLatestDto,
  type ConversationLatestListResponse,
} from "@silverhand/shared";
import { api } from "@/lib/api";
import { isCurrentViewerScope, onWsFrame, subscribeViewerScope } from "@/lib/ws-client";
import { applyLatestEvent, applyLatestSnapshot, type LatestMap } from "./latest-merge";

export type ConversationLatest = ConversationLatestDto;

export const conversationLatestKey = ["conversation-latest"] as const;

/**
 * The latest message of every conversation the viewer takes part in, for the
 * Recent sidebar only. Read when the sidebar mounts (so switching back from the
 * tree re-reads it) and after a `snapshot_required`; between reads the viewer
 * event moves single rows.
 */
export function useConversationLatest(): LatestMap<ConversationLatest> | undefined {
  const qc = useQueryClient();

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      if (frame.type === "snapshot_required" && isCurrentViewerScope(frame.scope)) {
        void qc.invalidateQueries({ queryKey: conversationLatestKey });
        return;
      }
      if (
        frame.type !== "event" ||
        frame.kind !== CONVERSATION_LATEST_CHANGED_EVENT ||
        !isCurrentViewerScope(frame.scope)
      ) {
        return;
      }

      const parsed = ConversationLatestDtoSchema.safeParse(frame.payload);
      if (!parsed.success) {
        return;
      }

      const entry = parsed.data;
      // Kept even before the first snapshot answers: that response merges with
      // whatever is here, so an older snapshot cannot drop this message.
      qc.setQueryData<LatestMap<ConversationLatest>>(conversationLatestKey, (current) =>
        applyLatestEvent(current ?? new Map(), entry),
      );
    });

    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  const query = useQuery({
    queryKey: conversationLatestKey,
    queryFn: async ({ signal }) => {
      const res = await api<ConversationLatestListResponse>(apiPaths.conversationLatest, {
        signal,
      });
      return applyLatestSnapshot(
        qc.getQueryData<LatestMap<ConversationLatest>>(conversationLatestKey),
        res.items,
      );
    },
    refetchOnMount: "always",
    staleTime: Infinity,
    retry: false,
  });

  return query.data;
}
