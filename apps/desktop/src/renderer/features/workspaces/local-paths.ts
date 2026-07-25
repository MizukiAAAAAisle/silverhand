import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

export interface LocalPathWorkspace {
  id: string;
  kind: 'regular' | 'dm';
  dm_agent_id: string | null;
}

export type LocalWorkspacePathsResult =
  Awaited<ReturnType<typeof window.silverhand.resolveLocalWorkspacePaths>>;

export const localWorkspacePathsKey = ['local-workspace-paths'] as const;

export function localWorkspacePathMap(
  result: LocalWorkspacePathsResult | undefined,
): ReadonlyMap<string, string> {
  if (!result?.ok) return new Map();
  return new Map(result.entries.map(entry => [entry.workspace_id, entry.path]));
}

/**
 * One batch read of this computer's daemon-local workspace authority. The
 * backend DTO path is deliberately absent from both the request and result.
 */
export function useLocalWorkspacePaths(
  workspaces: readonly LocalPathWorkspace[],
  bindingRevision: string | null,
): ReadonlyMap<string, string> {
  const refs = useMemo(
    () =>
      workspaces.map(workspace => ({
        workspace_id: workspace.id,
        workspace_kind: workspace.kind,
        owner_agent_id: workspace.dm_agent_id,
      })),
    [workspaces],
  );
  const query = useQuery({
    queryKey: [...localWorkspacePathsKey, bindingRevision, refs],
    queryFn: () => window.silverhand.resolveLocalWorkspacePaths(refs),
  });
  return useMemo(() => localWorkspacePathMap(query.data), [query.data]);
}
