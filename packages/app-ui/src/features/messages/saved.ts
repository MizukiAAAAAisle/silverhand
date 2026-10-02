import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { SavedMessageDto, ServerFrame } from "@silverhand/shared";
import { api } from "@/lib/api";
import {
  onWsFrame,
  subscribeViewerScope,
  isCurrentViewerScope,
  subscribeWsScope,
} from "@/lib/ws-client";
import { useWorkspaces } from "@/features/workspaces/hooks";

/**
 *  Prefix key of every Saved list variant. The per-variant key appends the
 *  filter object (`['saved', { workspaceId, since, userId, agentId }]`), so a
 *  channel-scoped cleanup must walk ALL loaded variants, not one canonical key
 */
export const savedKey = ["saved"] as const;
const savedInvalidationTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

function invalidateSavedDebounced(qc: QueryClient): void {
  const existing = savedInvalidationTimers.get(qc);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    savedInvalidationTimers.delete(qc);
    void qc.invalidateQueries({ queryKey: savedKey });
  }, 100);
  savedInvalidationTimers.set(qc, timer);
}

export function removeChannelFromSaved(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const prev = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!prev) continue;
    const next = prev.filter((row) => row.place.conversation_id !== channelId);
    if (next.length === prev.length) continue;
    qc.setQueryData<SavedMessageDto[]>(q.queryKey, next);
  }
}

export function savedHeldChannelIds(qc: QueryClient, workspaceId: string): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: savedKey })) {
    const data = qc.getQueryData<SavedMessageDto[]>(q.queryKey);
    if (!data) continue;
    for (const row of data) {
      if (row.place.kind === "workspace_channel" && row.place.workspace_id === workspaceId) {
        ids.add(row.place.conversation_id);
      }
    }
  }
  return [...ids];
}

export function savedWorkspaceFrameInvalidates(
  frame: ServerFrame,
  scopes: ReadonlySet<string>,
): boolean {
  if (frame.type === "snapshot_required") return scopes.has(frame.scope);
  return (
    frame.type === "event" && frame.kind === "workspace_channels_changed" && scopes.has(frame.scope)
  );
}

export interface SavedMessagesQuery {
  workspaceId?: string | null;
  since?: number | null;
  userId?: string | null;
  agentId?: string | null;
}

export function useSavedMessages(params?: SavedMessagesQuery) {
  const qc = useQueryClient();
  const workspaceId = params?.workspaceId ?? null;
  const since = params?.since ?? null;
  const userId = params?.userId ?? null;
  const agentId = params?.agentId ?? null;

  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame((frame) => {
      if (
        frame.type === "event" &&
        isCurrentViewerScope(frame.scope) &&
        frame.kind === "saved_changed"
      ) {
        invalidateSavedDebounced(qc);
      } else if (frame.type === "snapshot_required" && isCurrentViewerScope(frame.scope)) {
        invalidateSavedDebounced(qc);
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);

  const { data: workspaces = [] } = useWorkspaces();
  // Stable, order-independent key over the id set so the effect re-subscribes
  // only when membership actually changes, not on every equal-ids refetch.
  const workspaceScopeKey = useMemo(
    () => [...workspaces.map((w) => w.id)].sort().join(","),
    [workspaces],
  );
  useEffect(() => {
    const ids = workspaceScopeKey ? workspaceScopeKey.split(",") : [];
    if (ids.length === 0) return;
    const scopes = new Set(ids.map((id) => `workspace:${id}`));
    const subs = ids.map((id) => subscribeWsScope(`workspace:${id}`));
    const unsub = onWsFrame((frame) => {
      if (savedWorkspaceFrameInvalidates(frame, scopes)) invalidateSavedDebounced(qc);
    });
    return () => {
      for (const s of subs) s.unsubscribe();
      unsub();
    };
  }, [qc, workspaceScopeKey]);

  return useQuery({
    queryKey: [...savedKey, { workspaceId, since, userId, agentId }] as const,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (workspaceId) qs.set("workspace_id", workspaceId);
      if (since != null) qs.set("since", String(since));
      if (userId) qs.set("user_id", userId);
      // Emitted independently, NOT `else if`: the two are mutually exclusive by
      // construction (one single-select value), and if a caller ever broke that
      // the server's own refine should refuse the request loudly rather than
      // this line silently preferring one axis.
      if (agentId) qs.set("agent_id", agentId);
      const suffix = qs.toString();
      const res = await api<{ saved: SavedMessageDto[] }>(
        `/api/saved${suffix ? `?${suffix}` : ""}`,
      );
      return res.saved;
    },
  });
}

/** Set of message_ids that are currently saved — used by MessageItem to
 *  show the active state. Computed off the saved list to avoid an extra
 *  query per message list. */
export function useSavedMessageIds(): Set<string> {
  const { data = [] } = useSavedMessages();
  return new Set(data.map((s) => s.message.id));
}

export function useSaveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const res = await api<{ saved: SavedMessageDto }>(`/api/messages/${messageId}/save`, {
        method: "POST",
      });
      return res.saved;
    },
    onSuccess: () => {
      invalidateSavedDebounced(qc);
    },
  });
}

export function useUnsaveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      await api(`/api/messages/${messageId}/save`, { method: "DELETE" });
    },
    onSuccess: () => {
      invalidateSavedDebounced(qc);
    },
  });
}

/** Toggle save state — picks save / unsave based on the cached set so
 *  consumers can pass a single onClick. */
export function useToggleSave() {
  const save = useSaveMessage();
  const unsave = useUnsaveMessage();
  const ids = useSavedMessageIds();
  return {
    toggle: (messageId: string) => {
      if (ids.has(messageId)) unsave.mutate(messageId);
      else save.mutate(messageId);
    },
    isPending: save.isPending || unsave.isPending,
  };
}
