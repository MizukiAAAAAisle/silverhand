import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { QueryClient } from "@tanstack/react-query";
import type {
  FavoriteRowDto,
  ListFavoritesDto,
  UnreadUpdatedMessagePayload,
} from "@silverhand/shared";
import { apiPaths } from "@silverhand/shared";
import { api } from "@/lib/api";
import type {
  FavoritesWatchScope,
  StarMembership,
} from "@/features/chat-shell/model/home-grouping";
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
  subscribeWsScope,
} from "@/lib/ws-client";

export const favoritesKey = ["favorites", "all"] as const;

export function patchFavoritesUnread(
  qc: QueryClient,
  payload: UnreadUpdatedMessagePayload,
): "patched" | "unchanged" | "absent" | "cold" {
  const prev = qc.getQueryData<ListFavoritesDto>(favoritesKey);
  if (!prev) return "cold"; // list not loaded → no-op
  const idx = prev.items.findIndex((it) => it.entity_id === payload.conversation_id);
  if (idx < 0) return "absent"; // no such favorite row → no-op (never insert)
  const row = prev.items[idx];
  if (!row) return "absent"; // unreachable (idx >= 0) — narrows the index access
  if (row.unread_count === payload.conversation_unread_count) {
    return "unchanged";
  }
  const items = prev.items.slice();
  items[idx] = { ...row, unread_count: payload.conversation_unread_count };
  qc.setQueryData<ListFavoritesDto>(favoritesKey, { ...prev, items });
  return "patched";
}

export function removeWorkspaceFromFavorites(qc: QueryClient, workspaceId: string): void {
  const prev = qc.getQueryData<ListFavoritesDto>(favoritesKey);
  if (!prev) return;

  const removedKeys = new Set(
    prev.items.filter((it) => it.workspace_id === workspaceId).map((it) => it.favorite_key),
  );
  const items = prev.items.filter((it) => it.workspace_id !== workspaceId);
  const entries = prev.viewer_sort.entries.filter((e) => !removedKeys.has(e.entity_id));
  const changed =
    items.length !== prev.items.length || entries.length !== prev.viewer_sort.entries.length;
  if (!changed) return; // nothing matched → no write
  qc.setQueryData<ListFavoritesDto>(favoritesKey, {
    ...prev,
    items,
    viewer_sort: { ...prev.viewer_sort, entries },
  });
}

export function useFavorites(watchWorkspaceIds: FavoritesWatchScope) {
  const qc = useQueryClient();
  const query = useFavoritesList();

  // Joined into a stable string so the effect re-subscribes only when the SET
  // changes, not on every render of the caller's array literal.
  const scopeKey = Array.from(new Set(watchWorkspaceIds)).sort().join(",");

  useEffect(() => {
    const scopeIds = scopeKey ? scopeKey.split(",") : [];
    const subs = scopeIds.map((id) => subscribeWsScope(`workspace:${id}`));
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      const viewerSnapshot =
        frame.type === "snapshot_required" && isCurrentViewerScope(frame.scope);
      void applyFavoritesSync(qc, frame, scopeIds, viewerSnapshot);
    });
    return () => {
      for (const s of subs) s.unsubscribe();
      sub.unsubscribe();
      unsub();
    };
  }, [qc, scopeKey]);

  return query;
}

export function useFavoritesList() {
  return useQuery<ListFavoritesDto>({
    queryKey: favoritesKey,
    queryFn: ({ signal }) => api<ListFavoritesDto>(apiPaths.favorites, { signal }),
  });
}

export function useStarMembership(conversationId: string | null): StarMembership {
  const { data, status } = useFavoritesList();
  if (conversationId === null) return "unknown";
  if (!data) return status === "error" ? "unstarred" : "unknown";
  return data.items.some((it) => it.entity_id === conversationId) ? "starred" : "unstarred";
}

/** Minimal WS frame shape {@link decideFavoritesInvalidation} consumes, so the
 *  decision can be exercised without React or a socket (mirrors
 *  `ViewerSyncFrame` in `features/workspaces/hooks`). */
export interface FavoritesSyncFrame {
  type: string;
  /** Optional so a raw `ServerFrame` (whose non-scoped variants carry none) can
   *  be passed straight in — a frame with no scope matches no watched workspace. */
  scope?: string;
  kind?: string;
}

export function decideFavoritesInvalidation(
  frame: FavoritesSyncFrame,
  scopeIds: readonly string[],
): boolean {
  const watched = scopeIds.some((id) => frame.scope === `workspace:${id}`);
  if (frame.type === "snapshot_required") return watched;
  if (frame.type !== "event") return false;
  if (frame.kind !== "workspace_channels_changed") return false;
  return watched;
}

export function useUnstarFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: FavoriteRowDto) => {
      await api<unknown>(apiPaths.channelStar(item.entity_id), { method: "DELETE" });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: favoritesKey });
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: () => {
      toast.error("Failed to unstar, please retry");
    },
  });
}

/** The subscribed workspace set survives an empty favorites projection. */
export function applyFavoritesSync(
  qc: QueryClient,
  frame: FavoritesSyncFrame,
  scopeIds: readonly string[],
  viewerSnapshot = false,
): Promise<void> {
  if (viewerSnapshot || decideFavoritesInvalidation(frame, scopeIds)) {
    return qc.invalidateQueries({ queryKey: favoritesKey });
  }
  return Promise.resolve();
}
