import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  WorkspaceProvisionError,
  provisionWorkspace,
  AgentWorkspaceIndexError,
  indexAgentWorkspaces,
  AgentL2SeedError,
  seedAgentL2,
  WORKSPACE_CONSENSUS_DEFAULT,
  type RegistryBinding,
} from '../../src/daemon/workspace-registry/index.js';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import { chmodSync, readdirSync } from 'node:fs';

/**
 * D4.e-1 slice ② handler unit tests. The two daemon handlers sit between
 * the dispatcher and the registry: `provisionWorkspace` (bind + skeleton)
 * and `indexAgentWorkspaces` (route-time `agent_dir` resolver). Pins:
 *   - provision creates the `.silverhand/` skeleton at the managed path
 *     and reports `provisioned` (created) idempotently;
 *   - provision rejects `agent_home` with `unsupported_kind` (no fs write);
 *   - index resolves agent-home from `homeDir`, regular from the registry,
 *     and pushes never-provisioned ids to `unresolved` (read fail-closed).
 */

const STANDALONE: RegistryBinding = {
  server_origin: 'https://app.example.com',
  host_id: 'host_abc',
};

let stateDir: string;
let homeDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'shd4e1-h-'));
  homeDir = mkdtempSync(join(tmpdir(), 'shd4e1-home-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function makeRegistry(binding: RegistryBinding = STANDALONE) {
  return new WorkspaceRegistry({ stateDir, binding, now: () => 1_700_000_000_000 });
}

describe('provisionWorkspace', () => {
  it('binds a regular workspace and creates the .silverhand skeleton', async () => {
    const registry = makeRegistry();
    const r = await provisionWorkspace(
      { workspace_id: 'ws_1', kind: 'regular' },
      { registry },
    );
    const path = registry.resolve('ws_1');
    expect(r).toEqual({ ok: true, provisioned: true, bound_workspace_path: path });

    expect(existsSync(join(path, '.silverhand', 'agents'))).toBe(true);
    const consensus = readFileSync(
      join(path, '.silverhand', 'CONSENSUS.md'),
      'utf-8',
    );
    expect(consensus).toBe(WORKSPACE_CONSENSUS_DEFAULT);
  });

  it('is idempotent: re-provision reports provisioned=false and does not clobber CONSENSUS', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const path = registry.resolve('ws_1');
    // Mutate CONSENSUS so we can detect a clobber.
    const consensusPath = join(path, '.silverhand', 'CONSENSUS.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(consensusPath, '# edited by a member\n', 'utf-8');

    const r = await provisionWorkspace(
      { workspace_id: 'ws_1', kind: 'regular' },
      { registry },
    );
    expect(r).toEqual({ ok: true, provisioned: false, bound_workspace_path: path });
    expect(readFileSync(consensusPath, 'utf-8')).toBe('# edited by a member\n');
  });

  it('rejects kind=agent_home with unsupported_kind and writes nothing', async () => {
    const registry = makeRegistry();
    await expect(
      provisionWorkspace(
        { workspace_id: 'wsah_aid', kind: 'agent_home' },
        { registry },
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_kind',
    });
    expect(registry.has('wsah_aid')).toBe(false);
  });

  it('throws a WorkspaceProvisionError instance (typed surface)', async () => {
    const registry = makeRegistry();
    const err = await provisionWorkspace(
      { workspace_id: 'wsah_aid', kind: 'agent_home' },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
  });

  // P1-1 (Cindy): registry persistence (mkdir/write/rename) can throw raw
  // fs errno — these MUST classify the same as skeleton-stage fs errors,
  // never get black-holed into internal_error.
  function throwingRegistry(toThrow: unknown): WorkspaceRegistry {
    return {
      provision() {
        throw toThrow;
      },
    } as unknown as WorkspaceRegistry;
  }

  it.each([
    ['ENOSPC', 'fs_quota_exceeded'],
    ['EDQUOT', 'fs_quota_exceeded'],
    ['EACCES', 'fs_unavailable'],
    ['EPERM', 'fs_unavailable'],
    ['EROFS', 'fs_unavailable'],
    ['ENOENT', 'fs_unavailable'],
    ['ENOTDIR', 'fs_unavailable'],
    ['EEXIST', 'fs_unavailable'],
  ] as const)(
    'maps registry-write errno %s to %s (not internal_error)',
    async (errno, expected) => {
      const e = new Error(`${errno}: simulated`) as NodeJS.ErrnoException;
      e.code = errno;
      const err = await provisionWorkspace(
        { workspace_id: 'ws_1', kind: 'regular' },
        { registry: throwingRegistry(e) },
      ).catch(x => x);
      expect(err).toBeInstanceOf(WorkspaceProvisionError);
      expect((err as WorkspaceProvisionError).code).toBe(expected);
    },
  );

  it('maps an unrecognized registry-write errno to internal_error', async () => {
    const e = new Error('EIO: i/o error') as NodeJS.ErrnoException;
    e.code = 'EIO';
    const err = await provisionWorkspace(
      { workspace_id: 'ws_1', kind: 'regular' },
      { registry: throwingRegistry(e) },
    ).catch(x => x);
    expect((err as WorkspaceProvisionError).code).toBe('internal_error');
  });

  it('maps a foreign/corrupt registry on the provision path to registry_unavailable', async () => {
    const err = await provisionWorkspace(
      { workspace_id: 'ws_1', kind: 'regular' },
      {
        registry: throwingRegistry(
          new WorkspaceRegistryError('registry_corrupt', 'bad json'),
        ),
      },
    ).catch(x => x);
    expect((err as WorkspaceProvisionError).code).toBe('registry_unavailable');
  });
});

describe('indexAgentWorkspaces', () => {
  it('resolves agent-home from homeDir, never via the registry', async () => {
    const registry = makeRegistry();
    const agentHome = agentHomeWorkspaceId('aid_x');
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: [agentHome] },
      { registry, homeDir },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toEqual({
      workspace_id: agentHome,
      agent_dir: join(homeDir, '.silverhand', 'agents', 'aid_x'),
    });
  });

  it('resolves a provisioned regular workspace to <ws>/.silverhand/agents/<agent_id>', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const wsPath = registry.resolve('ws_1');

    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: ['ws_1'] },
      { registry, homeDir },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.entries[0]).toEqual({
      workspace_id: 'ws_1',
      agent_dir: join(wsPath, '.silverhand', 'agents', 'aid_x'),
    });
  });

  it('pushes never-provisioned regular ids to unresolved (read fail-closed)', async () => {
    const registry = makeRegistry();
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: ['ws_missing'] },
      { registry, homeDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual(['ws_missing']);
  });

  it('mixes resolved + unresolved + agent-home in one call, preserving order', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_ok', kind: 'regular' }, { registry });
    const agentHome = agentHomeWorkspaceId('aid_x');

    const r = await indexAgentWorkspaces(
      {
        agent_id: 'aid_x',
        workspace_ids: [agentHome, 'ws_missing', 'ws_ok'],
      },
      { registry, homeDir },
    );
    expect(r.entries.map(e => e.workspace_id)).toEqual([agentHome, 'ws_ok']);
    expect(r.unresolved).toEqual(['ws_missing']);
  });

  it('does NOT treat a wsah_ id for a different agent as agent-home', async () => {
    // `wsah_other` is agent-home for `other`, not for `aid_x`. For `aid_x`
    // it is just an unprovisioned regular id → unresolved, never resolved
    // from homeDir.
    const registry = makeRegistry();
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: [agentHomeWorkspaceId('other')] },
      { registry, homeDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual([agentHomeWorkspaceId('other')]);
  });

  it('maps a corrupt registry to AgentWorkspaceIndexError(registry_unavailable)', async () => {
    const registry = makeRegistry();
    registry.provision('ws_1');
    // Corrupt the registry file on disk; the next read fails the whole
    // call with a typed registry error → handler maps to registry_unavailable.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(registry.registryFilePath(), '{ not valid json', 'utf-8');

    const err = await indexAgentWorkspaces(
      { agent_id: 'aid', workspace_ids: ['ws_1'] },
      { registry, homeDir },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentWorkspaceIndexError);
    expect((err as AgentWorkspaceIndexError).code).toBe('registry_unavailable');
  });
});

// D4.e-1 (A — single intent): `provisionWorkspace` with a caller-PROPOSED
// `requested_path` (M1 folder picker / sandbox typed path / legacy
// backfill all unify here). The daemon re-validates the path host-side
// (absolute / not root / not home / not inside the managed root / not
// already bound) before binding + creating the skeleton — it never
// blindly trusts the backend.
describe('provisionWorkspace with requested_path', () => {
  let requestedDir: string;

  beforeEach(() => {
    requestedDir = mkdtempSync(join(tmpdir(), 'shd4e1-req-'));
  });

  afterEach(() => {
    rmSync(requestedDir, { recursive: true, force: true });
  });

  it('binds the caller-proposed path, creates the skeleton there, returns it as bound_workspace_path', async () => {
    const registry = makeRegistry();
    const r = await provisionWorkspace(
      { workspace_id: 'ws_custom', kind: 'regular', requested_path: requestedDir },
      { registry },
    );
    expect(r).toEqual({
      ok: true,
      provisioned: true,
      bound_workspace_path: requestedDir,
    });
    expect(registry.resolve('ws_custom')).toBe(requestedDir);
    expect(existsSync(join(requestedDir, '.silverhand', 'agents'))).toBe(true);
  });

  it('is idempotent: re-provision of the same id→path reports provisioned=false', async () => {
    const registry = makeRegistry();
    await provisionWorkspace(
      { workspace_id: 'ws_custom', kind: 'regular', requested_path: requestedDir },
      { registry },
    );
    const r = await provisionWorkspace(
      { workspace_id: 'ws_custom', kind: 'regular', requested_path: requestedDir },
      { registry },
    );
    expect(r).toEqual({
      ok: true,
      provisioned: false,
      bound_workspace_path: requestedDir,
    });
  });

  it('rejects a divergent path for an already-bound id with path_conflict (no overwrite)', async () => {
    const registry = makeRegistry();
    await provisionWorkspace(
      { workspace_id: 'ws_custom', kind: 'regular', requested_path: requestedDir },
      { registry },
    );
    const other = mkdtempSync(join(tmpdir(), 'shd4e1-req2-'));
    try {
      const err = await provisionWorkspace(
        { workspace_id: 'ws_custom', kind: 'regular', requested_path: other },
        { registry },
      ).catch(e => e);
      expect(err).toBeInstanceOf(WorkspaceProvisionError);
      expect((err as WorkspaceProvisionError).code).toBe('path_conflict');
      expect(registry.resolve('ws_custom')).toBe(requestedDir);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects a different id binding an already-bound path with path_conflict (cross-workspace)', async () => {
    const registry = makeRegistry();
    await provisionWorkspace(
      { workspace_id: 'ws_a', kind: 'regular', requested_path: requestedDir },
      { registry },
    );
    const err = await provisionWorkspace(
      { workspace_id: 'ws_b', kind: 'regular', requested_path: requestedDir },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    expect((err as WorkspaceProvisionError).code).toBe('path_conflict');
    expect(registry.has('ws_b')).toBe(false);
  });

  it.each([
    ['relative path', 'work/custom'],
    ['filesystem root', '/'],
  ] as const)('rejects %s with invalid_path (no skeleton, not bound)', async (_label, badPath) => {
    const registry = makeRegistry();
    const err = await provisionWorkspace(
      { workspace_id: 'ws_bad', kind: 'regular', requested_path: badPath },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    expect((err as WorkspaceProvisionError).code).toBe('invalid_path');
    expect(registry.has('ws_bad')).toBe(false);
  });

  it('rejects a requested path inside the daemon-managed root with invalid_path', async () => {
    const registry = makeRegistry();
    // Provision one default (managed) workspace to realize the managed
    // root, then try to propose a path inside it.
    await provisionWorkspace({ workspace_id: 'ws_managed', kind: 'regular' }, { registry });
    const insideManaged = registry.resolve('ws_managed');
    const err = await provisionWorkspace(
      { workspace_id: 'ws_custom', kind: 'regular', requested_path: insideManaged },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    expect((err as WorkspaceProvisionError).code).toBe('invalid_path');
  });

  it('rejects kind=agent_home even with a requested_path (never bind a DM L1 here)', async () => {
    const registry = makeRegistry();
    const err = await provisionWorkspace(
      { workspace_id: 'wsah_aid', kind: 'agent_home', requested_path: requestedDir },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    expect((err as WorkspaceProvisionError).code).toBe('unsupported_kind');
    expect(registry.has('wsah_aid')).toBe(false);
  });
});

// D4.e-1 P1-1 (Cindy): the registry persists the id→path mapping BEFORE the
// skeleton is built, so a skeleton failure must COMPENSATE by rolling the
// mapping back — otherwise the id is stuck pointing at an unusable path and
// a retry with a corrected path would hit path_conflict. The rollback is
// best-effort and must NEVER mask the original skeleton error.
describe('provisionWorkspace — skeleton-failure compensation', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shd4e1-comp-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // A structurally-valid requested path whose PARENT is a regular file, so
  // `mkdir` inside the skeleton step fails (ENOTDIR) after the registry has
  // already persisted the entry.
  function uncreatablePath(): string {
    const aFile = join(baseDir, 'a-file');
    writeFileSync(aFile, 'not a dir', 'utf-8');
    return join(aFile, 'ws-root');
  }

  it('rolls the registry entry back on skeleton failure, freeing the id for retry', async () => {
    const registry = makeRegistry();
    const bad = uncreatablePath();
    const err = await provisionWorkspace(
      { workspace_id: 'ws_x', kind: 'regular', requested_path: bad },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    // P2 (Cindy): a parent-is-a-file path is ENOTDIR — a property of the
    // user's path choice, NOT an internal bug → fs_unavailable, not internal_error.
    expect((err as WorkspaceProvisionError).code).toBe('fs_unavailable');
    // The entry was compensated away — NOT left stuck at the bad path.
    expect(registry.has('ws_x')).toBe(false);

    // Retry with a good path on the SAME id succeeds (no path_conflict).
    const good = join(baseDir, 'good-root');
    const r = await provisionWorkspace(
      { workspace_id: 'ws_x', kind: 'regular', requested_path: good },
      { registry },
    );
    expect(r.provisioned).toBe(true);
    expect(registry.resolve('ws_x')).toBe(good);
    expect(existsSync(join(good, '.silverhand', 'agents'))).toBe(true);
  });

  it('does NOT roll back an idempotent re-provision whose skeleton step fails', async () => {
    // First provision binds + builds the skeleton successfully.
    const registry = makeRegistry();
    const good = join(baseDir, 'already');
    await provisionWorkspace(
      { workspace_id: 'ws_y', kind: 'regular', requested_path: good },
      { registry },
    );
    // Now delete the skeleton dir so a re-provision's skeleton step throws,
    // but the entry already existed (created=false) → must NOT be removed.
    rmSync(good, { recursive: true, force: true });
    writeFileSync(good, 'now a file', 'utf-8'); // make re-create fail (ENOTDIR/EEXIST)
    await provisionWorkspace(
      { workspace_id: 'ws_y', kind: 'regular', requested_path: good },
      { registry },
    ).catch(e => e);
    // Entry preserved: an idempotent re-provision is not torn down.
    expect(registry.has('ws_y')).toBe(true);
    expect(registry.resolve('ws_y')).toBe(good);
  });

  it('best-effort rollback never masks the original skeleton error and warns', async () => {
    const bad = uncreatablePath();
    const real = makeRegistry();
    const warnings: unknown[] = [];
    // Wrap the registry so provision() works (persists) but remove() throws,
    // simulating a rollback failure. The handler must still reject with the
    // ORIGINAL skeleton error and only WARN about the failed rollback.
    const wrapped = {
      provision: (id: string, p?: string) => real.provision(id, p),
      remove: () => {
        throw new Error('rollback boom');
      },
    } as unknown as WorkspaceRegistry;

    const err = await provisionWorkspace(
      { workspace_id: 'ws_z', kind: 'regular', requested_path: bad },
      { registry: wrapped, logger: { warn: obj => warnings.push(obj) } },
    ).catch(e => e);

    // Original skeleton error surfaced (NOT "rollback boom").
    expect(err).toBeInstanceOf(WorkspaceProvisionError);
    expect((err as WorkspaceProvisionError).code).toBe('fs_unavailable');
    expect((err as Error).message).not.toContain('rollback boom');
    // The failed rollback was warned about.
    expect(warnings).toHaveLength(1);
    // The entry remains in the real registry (rollback failed) — that is the
    // accepted residue; correctness of the error is what matters here.
    expect(real.has('ws_z')).toBe(true);
  });
});

// D4.e-3 slice handler unit tests for `seedAgentL2` — the daemon-owned L2
// (per-workspace) memory seeder that replaces backend `seedAgentL2` (gap
// G1). The daemon resolves the workspace's host-local path from its own
// registry and writes `<ws>/.silverhand/agents/<agent>/{MEMORY.md,notes/…}`.
// Cindy D4.e-3 review focuses:
//   #2 regular-only — agent-home / unprovisioned id fails closed
//      (workspace_not_provisioned) purely via registry.resolve, no `kind`;
//   #3 L2 must NEVER carry L1 `system_prompt.md`; MEMORY.md/notes/ present;
//      idempotent re-seed preserves edited content (never overwrites).
describe('seedAgentL2', () => {
  const AGENT_ID = 'aid_member';

  function l2DirFor(wsPath: string): string {
    return join(wsPath, '.silverhand', 'agents', AGENT_ID);
  }

  it('seeds MEMORY.md + notes/ but NEVER system_prompt.md (L1-only)', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const wsPath = registry.resolve('ws_1');

    const r = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { registry },
    );
    expect(r).toEqual({ ok: true, seeded: true, l2_present: true });

    const l2 = l2DirFor(wsPath);
    // L1 identity must NOT leak into L2.
    expect(existsSync(join(l2, 'system_prompt.md'))).toBe(false);
    // L2 carries MEMORY.md + notes/.
    expect(existsSync(join(l2, 'MEMORY.md'))).toBe(true);
    expect(readdirSync(join(l2, 'notes')).sort()).toEqual([
      'onboarding-faq.md',
      'onboarding-guide.md',
      'project.md',
      'user-preferences.md',
      'work-log.md',
    ]);
  });

  it('is idempotent: re-seed reports seeded=false and preserves edited content', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const wsPath = registry.resolve('ws_1');
    const l2 = l2DirFor(wsPath);

    await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { registry },
    );
    // An agent edits its MEMORY.md after the first seed.
    const memPath = join(l2, 'MEMORY.md');
    writeFileSync(memPath, '# edited by the agent\n', 'utf-8');

    const r = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { registry },
    );
    // Nothing new written; the edit survives (no clobber).
    expect(r).toEqual({ ok: true, seeded: false, l2_present: true });
    expect(readFileSync(memPath, 'utf-8')).toBe('# edited by the agent\n');
  });

  it('fails closed with workspace_not_provisioned for a never-provisioned id', async () => {
    const registry = makeRegistry();
    const err = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_missing', template_choice: 'default' },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('workspace_not_provisioned');
  });

  it('fails closed with workspace_not_provisioned for an agent-home id (regular-only, no kind param)', async () => {
    // Cindy #2: an agent-home (DM) workspace has no registry binding, so
    // resolve() throws not_provisioned. The handler relies on this — it does
    // NOT take a `kind` and never seeds an agent-home L2 (== L1, already
    // materialized by agent_materialize).
    const registry = makeRegistry();
    const err = await seedAgentL2(
      {
        agent_id: AGENT_ID,
        workspace_id: agentHomeWorkspaceId(AGENT_ID),
        template_choice: 'default',
      },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('workspace_not_provisioned');
  });

  it('rejects an unsupported template_choice with unsupported_template (no fs write)', async () => {
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const wsPath = registry.resolve('ws_1');
    const err = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'minimal' },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('unsupported_template');
    // Template is validated before any path is touched → no L2 dir created.
    expect(existsSync(l2DirFor(wsPath))).toBe(false);
  });

  it('maps a registry_corrupt resolve to registry_unavailable (whole-registry failure)', async () => {
    const registry = makeRegistry();
    registry.provision('ws_1');
    // Corrupt the registry file so resolve() throws registry_corrupt.
    writeFileSync(registry.registryFilePath(), '{ not valid json', 'utf-8');
    const err = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { registry },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('registry_unavailable');
  });

  it('fails closed with fs_unavailable on a HARD fs write error', async () => {
    // chmod 000 on the workspace's `.silverhand/agents` dir makes the
    // l2Dir mkdir throw EACCES — a hard write error must surface as the
    // typed fs_unavailable (fail-closed), never a silent success.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const registry = makeRegistry();
    await provisionWorkspace({ workspace_id: 'ws_1', kind: 'regular' }, { registry });
    const wsPath = registry.resolve('ws_1');
    const agentsDir = join(wsPath, '.silverhand', 'agents');
    chmodSync(agentsDir, 0o000);
    try {
      const err = await seedAgentL2(
        { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
        { registry },
      ).catch(e => e);
      expect(err).toBeInstanceOf(AgentL2SeedError);
      expect((err as AgentL2SeedError).code).toBe('fs_unavailable');
    } finally {
      chmodSync(agentsDir, 0o755);
    }
  });
});
