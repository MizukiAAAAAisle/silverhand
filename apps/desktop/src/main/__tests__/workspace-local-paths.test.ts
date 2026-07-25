import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRegistry } from '@silverhand/host';
import { resolveComputerSlotPaths } from '@silverhand/shared/app-data-layout';
import {
  resolveLocalWorkspacePaths,
  type LocalWorkspacePathContext,
} from '../workspace-local-paths.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'silverhand-local-paths-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

function context(appRoot: string): LocalWorkspacePathContext {
  return {
    app_root: appRoot,
    host_id: 'host-1',
    backend_mode: 'remote',
    server_url: 'https://silverhand.example.test/path',
  };
}

describe('resolveLocalWorkspacePaths', () => {
  it('returns regular paths from the current computer registry and never accepts a server path', () => {
    const appRoot = root();
    const ctx = context(appRoot);
    const slot = resolveComputerSlotPaths(appRoot, ctx.host_id);
    const registry = new WorkspaceRegistry({
      stateDir: slot.workspaceData,
      binding: {
        server_origin: 'https://silverhand.example.test',
        host_id: ctx.host_id,
      },
      silverhandStateRoot: appRoot,
      protectedRoots: [slot.workspaceData, slot.agents, appRoot],
    });
    const provisioned = registry.provision('workspace-1').path;

    expect(
      resolveLocalWorkspacePaths(
        [
          {
            workspace_id: 'workspace-1',
            workspace_kind: 'regular',
            owner_agent_id: null,
            workspace_path: '/stale/server/path',
          },
          {
            workspace_id: 'workspace-missing',
            workspace_kind: 'regular',
            owner_agent_id: null,
          },
        ],
        ctx,
      ),
    ).toEqual({
      ok: true,
      entries: [{ workspace_id: 'workspace-1', path: provisioned }],
    });
  });

  it('returns only materialized DM agent homes from the current computer slot', () => {
    const appRoot = root();
    const ctx = context(appRoot);
    const slot = resolveComputerSlotPaths(appRoot, ctx.host_id);
    const agentHome = join(slot.agents, 'agent-1');
    mkdirSync(agentHome, { recursive: true });

    expect(
      resolveLocalWorkspacePaths(
        [
          {
            workspace_id: 'dm-1',
            workspace_kind: 'dm',
            owner_agent_id: 'agent-1',
          },
          {
            workspace_id: 'dm-missing',
            workspace_kind: 'dm',
            owner_agent_id: 'agent-2',
          },
        ],
        ctx,
      ),
    ).toEqual({
      ok: true,
      entries: [{ workspace_id: 'dm-1', path: agentHome }],
    });
  });

  it('uses the local-embedded binding for an embedded desktop', () => {
    const appRoot = root();
    const ctx: LocalWorkspacePathContext = {
      ...context(appRoot),
      backend_mode: 'embedded',
      server_url: 'http://127.0.0.1:43210',
    };
    const slot = resolveComputerSlotPaths(appRoot, ctx.host_id);
    const provisioned = new WorkspaceRegistry({
      stateDir: slot.workspaceData,
      binding: {
        server_origin: 'local-embedded',
        host_id: ctx.host_id,
      },
    }).provision('workspace-embedded').path;

    expect(
      resolveLocalWorkspacePaths(
        [
          {
            workspace_id: 'workspace-embedded',
            workspace_kind: 'regular',
            owner_agent_id: null,
          },
        ],
        ctx,
      ),
    ).toEqual({
      ok: true,
      entries: [
        { workspace_id: 'workspace-embedded', path: provisioned },
      ],
    });
  });

  it('fails closed when the desktop is unbound or the registry belongs to another control plane', () => {
    const appRoot = root();
    const ctx = context(appRoot);
    const slot = resolveComputerSlotPaths(appRoot, ctx.host_id);
    new WorkspaceRegistry({
      stateDir: slot.workspaceData,
      binding: {
        server_origin: 'https://other.example.test',
        host_id: ctx.host_id,
      },
    }).provision('workspace-1');

    const refs = [
      {
        workspace_id: 'workspace-1',
        workspace_kind: 'regular' as const,
        owner_agent_id: null,
      },
    ];
    expect(resolveLocalWorkspacePaths(refs, null)).toEqual({
      ok: false,
      reason: 'not_bound',
    });
    expect(resolveLocalWorkspacePaths(refs, ctx)).toEqual({
      ok: false,
      reason: 'registry_unavailable',
    });
  });
});
