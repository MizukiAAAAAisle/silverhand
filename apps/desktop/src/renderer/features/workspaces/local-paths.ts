import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  apiPaths,
  WorkspaceLocalPathsResponseSchema,
  type WorkspaceLocalPathsResponse,
} from '@silverhand/shared';
import { api } from '@/lib/api';

export const localWorkspacePathsKey = ['local-workspace-paths'] as const;

export function localWorkspacePathMap(
  result: WorkspaceLocalPathsResponse | undefined,
): ReadonlyMap<string, string> {
  if (!result) return new Map();
  return new Map(result.entries.map(entry => [entry.workspace_id, entry.path]));
}

/**
 * One backend-authorized batch read across connected computers. Each path is
 * stamped by the workspace's home daemon; the DB path is not part of this API.
 */
export function useLocalWorkspacePaths(
  visibleWorkspaceIds: readonly string[],
): ReadonlyMap<string, string> {
  const visibilityRevision = useMemo(
    () => [...visibleWorkspaceIds].sort(),
    [visibleWorkspaceIds],
  );
  const query = useQuery({
    queryKey: [...localWorkspacePathsKey, visibilityRevision],
    queryFn: async () =>
      WorkspaceLocalPathsResponseSchema.parse(
        await api<unknown>(apiPaths.workspaceLocalPaths),
      ),
  });
  return useMemo(() => localWorkspacePathMap(query.data), [query.data]);
}
