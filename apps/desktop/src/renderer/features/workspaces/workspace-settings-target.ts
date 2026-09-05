import { isAgentSpace } from './workspace-ownership';

type WorkspaceIdentity = { id: string; owner_agent_id: string | null };

export function resolveWorkspaceSettingsTarget<T extends WorkspaceIdentity>(workspaces: readonly T[], settingsId: string | null): T | null {
  return workspaces.find(workspace => workspace.id === settingsId) ?? null;
}

/** Deleting another workspace must not replace the reader's current conversation. */
export function workspaceDeletionDestination(workspaces: readonly WorkspaceIdentity[], deletedId: string, selectedId: string | null):
  | { kind: 'stay' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'chat' } {
  if (deletedId !== selectedId) return { kind: 'stay' };
  const deleted = workspaces.find(workspace => workspace.id === deletedId);
  const sameGroup = deleted ? workspaces.filter(workspace => isAgentSpace(workspace) === isAgentSpace(deleted)) : [];
  const index = sameGroup.findIndex(workspace => workspace.id === deletedId);
  const next = (sameGroup.length > 1 && index >= 0 ? sameGroup[(index + 1) % sameGroup.length] : null)
    ?? workspaces.find(workspace => workspace.id !== deletedId);
  return next ? { kind: 'workspace', workspaceId: next.id } : { kind: 'chat' };
}
