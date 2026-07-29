import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_UNBIND_MAX_BATCH,
  WorkspaceUnbindParamsSchema,
} from '../../src/protocol.js';
import {
  unbindWorkspaces,
  WorkspaceRegistry,
  WorkspaceUnbindError,
} from '../../src/daemon/workspace-registry/index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-unbind-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// #task:1719 — workspace_unbind handler: registry-mapping removal for
// backend-deleted workspaces. Mapping only, idempotent, foreign/corrupt
// registry fails the whole call closed.
describe('unbindWorkspaces', () => {
  it('removes bound ids and reports never-bound ids as absent (idempotent success)', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    registry.provision('w1');
    registry.provision('w2');

    await expect(
      unbindWorkspaces(
        { workspace_ids: ['w1', 'never-bound', 'w1'] },
        { registry },
      ),
    ).resolves.toEqual({
      ok: true,
      removed: ['w1'],
      absent: ['never-bound'],
    });
    // Only the requested mapping is gone; the other binding survives.
    expect(registry.has('w1')).toBe(false);
    expect(registry.has('w2')).toBe(true);

    // Re-dispatch of the same batch is pure `absent` — never an error.
    await expect(
      unbindWorkspaces({ workspace_ids: ['w1'] }, { registry }),
    ).resolves.toEqual({ ok: true, removed: [], absent: ['w1'] });
  });

  it('never touches the workspace directory or its contents (#1594)', async () => {
    const root = tempRoot();
    const registry = new WorkspaceRegistry({
      stateDir: join(root, 'workspace-data'),
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    const { path } = registry.provision('w1');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep.txt'), 'user data');

    await expect(
      unbindWorkspaces({ workspace_ids: ['w1'] }, { registry }),
    ).resolves.toEqual({ ok: true, removed: ['w1'], absent: [] });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(path, 'keep.txt'), 'utf-8')).toBe('user data');
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
    const foreign = new WorkspaceRegistry({
      stateDir,
      binding: { server_origin: 'https://other.test', host_id: 'h2' },
    });

    await expect(
      unbindWorkspaces({ workspace_ids: ['w1'] }, { registry: foreign }),
    ).rejects.toMatchObject({
      name: 'WorkspaceUnbindError',
      code: 'registry_unavailable',
    });
    // Fail closed means no partial mutation of the foreign file either.
    expect(original.has('w1')).toBe(true);
  });

  it('fails closed as registry_unavailable on a corrupt registry', async () => {
    const root = tempRoot();
    const stateDir = join(root, 'workspace-data');
    const registry = new WorkspaceRegistry({
      stateDir,
      binding: { server_origin: 'https://server.test', host_id: 'h1' },
    });
    registry.provision('w1');
    writeFileSync(registry.registryFilePath(), '{ not valid json');

    let thrown: unknown;
    try {
      await unbindWorkspaces({ workspace_ids: ['w1'] }, { registry });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceUnbindError);
    expect((thrown as WorkspaceUnbindError).code).toBe('registry_unavailable');
  });
});

// #task:1719 P1-2 — the wire schema itself enforces the batch bounds so an
// empty or oversized `workspace_ids` never reaches the handler; the backend
// chunks larger sets by the exported WORKSPACE_UNBIND_MAX_BATCH constant.
describe('WorkspaceUnbindParamsSchema — batch bounds', () => {
  it('rejects an empty batch (caller bug, not an idempotent no-op)', () => {
    expect(
      WorkspaceUnbindParamsSchema.safeParse({ workspace_ids: [] }).success,
    ).toBe(false);
  });

  it(`accepts exactly WORKSPACE_UNBIND_MAX_BATCH (${WORKSPACE_UNBIND_MAX_BATCH}) ids and rejects one more`, () => {
    const atMax = Array.from(
      { length: WORKSPACE_UNBIND_MAX_BATCH },
      (_, i) => `ws_${i}`,
    );
    expect(
      WorkspaceUnbindParamsSchema.safeParse({ workspace_ids: atMax }).success,
    ).toBe(true);
    expect(
      WorkspaceUnbindParamsSchema.safeParse({
        workspace_ids: [...atMax, 'ws_overflow'],
      }).success,
    ).toBe(false);
  });
});
