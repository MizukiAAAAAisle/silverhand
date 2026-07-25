import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import {
  indexWorkspacePaths,
  WorkspaceRegistry,
} from '../../src/daemon/workspace-registry/index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-index-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('indexWorkspacePaths', () => {
  it('returns regular registry roots and materialized agent-home roots', async () => {
    const root = tempRoot();
    const stateDir = join(root, 'workspace-data');
    const agentRoot = join(root, 'agents');
    const registry = new WorkspaceRegistry({
      stateDir,
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    const regularPath = registry.provision('w1').path;
    mkdirSync(regularPath, { recursive: true });
    const agentPath = join(agentRoot, 'a1');
    mkdirSync(agentPath, { recursive: true });

    await expect(
      indexWorkspacePaths(
        {
          workspaces: [
            { workspace_id: 'w1', kind: 'regular', owner_agent_id: null },
            {
              workspace_id: agentHomeWorkspaceId('a1'),
              kind: 'agent_home',
              owner_agent_id: 'a1',
            },
          ],
        },
        { registry, agentHomeRootDir: agentRoot },
      ),
    ).resolves.toEqual({
      ok: true,
      entries: [
        { workspace_id: 'w1', path: regularPath },
        { workspace_id: agentHomeWorkspaceId('a1'), path: agentPath },
      ],
      unresolved: [],
    });
  });

  it('degrades missing bindings, missing directories, and invalid DM refs per entry', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    registry.provision('missing-dir');

    await expect(
      indexWorkspacePaths(
        {
          workspaces: [
            {
              workspace_id: 'not-provisioned',
              kind: 'regular',
              owner_agent_id: null,
            },
            {
              workspace_id: 'missing-dir',
              kind: 'regular',
              owner_agent_id: null,
            },
            {
              workspace_id: 'wrong-agent-home-id',
              kind: 'agent_home',
              owner_agent_id: 'a1',
            },
          ],
        },
        { registry, agentHomeRootDir: join(root, 'agents') },
      ),
    ).resolves.toEqual({
      ok: true,
      entries: [],
      unresolved: [
        'not-provisioned',
        'missing-dir',
        'wrong-agent-home-id',
      ],
    });
  });
});
