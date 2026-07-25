import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  WorkspaceRegistry,
  type RegistryBinding,
} from '@silverhand/host';
import {
  legacyWorkspacesRootDir,
  resolveComputerSlotPaths,
} from '@silverhand/shared/app-data-layout';

export interface LocalWorkspacePathRef {
  workspace_id: string;
  workspace_kind: 'regular' | 'dm';
  owner_agent_id: string | null;
}

export interface LocalWorkspacePathContext {
  app_root: string;
  host_id: string;
  backend_mode: 'embedded' | 'remote';
  server_url: string;
}

export type LocalWorkspacePathsResult =
  | {
      ok: true;
      entries: Array<{ workspace_id: string; path: string }>;
    }
  | {
      ok: false;
      reason: 'not_bound' | 'invalid_input' | 'registry_unavailable';
    };

const MAX_WORKSPACE_REFS = 10_000;
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]+$/;

function isLocalWorkspacePathRef(value: unknown): value is LocalWorkspacePathRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Partial<Record<keyof LocalWorkspacePathRef, unknown>>;
  return (
    typeof ref.workspace_id === 'string' &&
    ref.workspace_id.length > 0 &&
    (ref.workspace_kind === 'regular' || ref.workspace_kind === 'dm') &&
    (ref.owner_agent_id === null || typeof ref.owner_agent_id === 'string')
  );
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the paths displayed by desktop UI from this computer's local
 * authority. Regular workspaces come from WorkspaceRegistry; DM workspaces
 * point at their materialized agent L1 directory. No server-projected path is
 * accepted as input or used as a fallback.
 */
export function resolveLocalWorkspacePaths(
  input: unknown,
  context: LocalWorkspacePathContext | null,
): LocalWorkspacePathsResult {
  if (
    !Array.isArray(input) ||
    input.length > MAX_WORKSPACE_REFS ||
    !input.every(isLocalWorkspacePathRef)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (context === null) {
    return { ok: false, reason: 'not_bound' };
  }

  const slot = resolveComputerSlotPaths(context.app_root, context.host_id);
  let binding: RegistryBinding;
  try {
    binding = {
      server_origin:
        context.backend_mode === 'embedded'
          ? 'local-embedded'
          : new URL(context.server_url).origin,
      host_id: context.host_id,
    };
  } catch {
    return { ok: false, reason: 'registry_unavailable' };
  }

  let regularPaths: Map<string, string>;
  try {
    const registry = new WorkspaceRegistry({
      stateDir: slot.workspaceData,
      binding,
      silverhandStateRoot: context.app_root,
      legacyWorkspacesRoot: legacyWorkspacesRootDir(context.app_root),
      protectedRoots: [slot.workspaceData, slot.agents, context.app_root],
    });
    regularPaths = new Map(
      registry.list().map(entry => [entry.workspace_id, entry.path]),
    );
  } catch {
    return { ok: false, reason: 'registry_unavailable' };
  }

  const entries: Array<{ workspace_id: string; path: string }> = [];
  const seen = new Set<string>();
  for (const ref of input) {
    if (seen.has(ref.workspace_id)) continue;
    seen.add(ref.workspace_id);

    if (ref.workspace_kind === 'regular') {
      const path = regularPaths.get(ref.workspace_id);
      if (path !== undefined) entries.push({ workspace_id: ref.workspace_id, path });
      continue;
    }

    const agentId = ref.owner_agent_id;
    if (!agentId || !SAFE_AGENT_ID.test(agentId)) continue;
    const path = join(slot.agents, agentId);
    if (isExistingDirectory(path)) {
      entries.push({ workspace_id: ref.workspace_id, path });
    }
  }

  return { ok: true, entries };
}
