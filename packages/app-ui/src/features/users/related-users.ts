import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  apiPaths,
  WorkspaceMembersChangedEventSchema,
  type ServerFrame,
  type UsersResponse,
  type UserDto,
} from "@silverhand/shared";
import { api } from "@/lib/api";
import { onWsFrame, subscribeWsScope, subscribeViewerScope } from "@/lib/ws-client";
import { useWorkspaces } from "@/features/workspaces/hooks";

export const relatedUsersKey = (viewerId: string | null) => ["related-users", viewerId] as const;

export function relatedUsersChanged(
  frame: ServerFrame,
  viewerId: string,
  scopes: ReadonlySet<string>,
): boolean {
  const scope = "scope" in frame ? frame.scope : undefined;
  const relevant = scope === "app" || scope === `viewer:${viewerId}` || scopes.has(scope ?? "");
  if (!relevant) return false;

  if (
    frame.type === "snapshot_required" ||
    (frame.type === "error" && frame.code === "forbidden")
  ) {
    return true;
  }
  if (frame.type !== "event") return false;
  if (frame.scope === "app") return frame.kind === "user_changed";
  if (frame.scope === `viewer:${viewerId}`) return frame.kind === "viewer_workspaces_changed";

  const parsed = WorkspaceMembersChangedEventSchema.safeParse(frame.payload);
  return (
    frame.kind === "workspace_members_changed" &&
    parsed.success &&
    frame.scope === `workspace:${parsed.data.workspace_id}`
  );
}

export function resetRelatedUsers(qc: QueryClient, viewerId: string) {
  return qc.resetQueries({ queryKey: relatedUsersKey(viewerId), exact: true });
}

/** The server owns the union. Never fall back to the global invitation directory. */
export function useRelatedUsers(viewerId: string | null) {
  const qc = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces({ enabled: viewerId !== null });
  const scopeKey = JSON.stringify(workspaces.map((w) => `workspace:${w.id}`).sort());
  const query = useQuery<UsersResponse, Error, UserDto[]>({
    queryKey: relatedUsersKey(viewerId),
    queryFn: ({ signal }) => api(apiPaths.relatedUsers, { signal }),
    select: (response) => response.users,
    enabled: viewerId !== null,
  });

  useEffect(() => {
    if (!viewerId) return;
    const scopes = new Set<string>(JSON.parse(scopeKey));
    const invalidate = () => {
      // Clear revoked rows immediately and cancel pre-change requests; their late
      // response must not restore a previous membership snapshot.
      void resetRelatedUsers(qc, viewerId);
    };
    const unsubscribe = onWsFrame((frame) => {
      if (relatedUsersChanged(frame, viewerId, scopes)) invalidate();
    });
    const subscriptions = [
      subscribeWsScope("app"),
      subscribeViewerScope(),
      ...Array.from(scopes, (scope) => subscribeWsScope(scope)),
    ];

    // Covers changes before discovery/subscription and workspace create/delete.
    invalidate();
    return () => {
      unsubscribe();
      subscriptions.forEach((s) => s.unsubscribe());
    };
  }, [qc, viewerId, scopeKey]);

  return query;
}
