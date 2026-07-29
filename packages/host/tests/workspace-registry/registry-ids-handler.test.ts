import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listWorkspaceRegistryIds,
  WorkspaceRegistry,
  WorkspaceRegistryIdsError,
} from '../../src/daemon/workspace-registry/index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-registry-ids-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// #task:1719 — workspace_registry_ids handler: the ready-generation
// reconcile pull. Ids ONLY (never paths), empty registry is success,
// foreign/corrupt registry fails the whole call closed.
describe('listWorkspaceRegistryIds', () => {
  it('returns every bound id and NOTHING else — no paths on the wire', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    registry.provision('w1');
    registry.provision('w2', '/Users/someone/projects/w2');

    const result = await listWorkspaceRegistryIds({}, { registry });
    expect(result.ok).toBe(true);
    expect([...result.workspace_ids].sort()).toEqual(['w1', 'w2']);
    // Ids only: the serialized result must not leak any bound path (I1).
    expect(JSON.stringify(result)).not.toContain('/Users/someone/projects/w2');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('an absent registry file is SUCCESS with an empty list (fresh computer)', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    await expect(
      listWorkspaceRegistryIds({}, { registry }),
    ).resolves.toEqual({ ok: true, workspace_ids: [] });
  });

  it('fails the whole call closed as registry_unavailable on a foreign registry', async () => {
    const root = tempRoot();
    const stateDir = join(root, 'workspace-data');
    const original = new WorkspaceRegistry({
      stateDir,
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    original.provision('w1');
    // Same file re-opened under a different control-plane binding → foreign.
    // Reporting [] here would make the backend treat w1 as a ghost.
    const foreign = new WorkspaceRegistry({
      stateDir,
      binding: { server_origin: 'https://other.test', host_id: 'h2' },
    });
    await expect(
      listWorkspaceRegistryIds({}, { registry: foreign }),
    ).rejects.toMatchObject({
      name: 'WorkspaceRegistryIdsError',
      code: 'registry_unavailable',
    });
  });

  it('fails closed as registry_unavailable on a corrupt registry', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    registry.provision('w1');
    writeFileSync(registry.registryFilePath(), '{ not valid json');

    let thrown: unknown;
    try {
      await listWorkspaceRegistryIds({}, { registry });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceRegistryIdsError);
    expect((thrown as WorkspaceRegistryIdsError).code).toBe(
      'registry_unavailable',
    );
  });
});
