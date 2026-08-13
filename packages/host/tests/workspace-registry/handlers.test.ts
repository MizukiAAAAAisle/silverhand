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
  indexAgentWorkspaces,
  AgentL2SeedError,
  seedAgentL2,
  AgentFilesPurgeError,
  purgeAgentFiles,
  type RegistryBinding,
} from '../../src/daemon/workspace-registry/index.js';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import {
  bundleL2Present,
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../../src/daemon/agent-materialize/index.js';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';

/**
 * D4.e-1 slice ② handler unit tests. The daemon handlers sit between the
 * dispatcher and the fs: `indexAgentWorkspaces` (route-time `agent_dir`
 * resolver), `seedAgentL2`, and `purgeAgentFiles`. Pins:
 *   - index resolves agent-home from the explicit `agentHomeRootDir`, a regular workspace to its
 *     deterministic agent-centric bundle dir when that dir is a usable cwd
 *     (relocation-v1 §7 task 4: `agent_dir` is a CWD-existence fact via
 *     `bundleCwdUsable`, NOT a registry binding), and pushes never-materialized
 *     / unsafe ids to `unresolved` (read fail-closed, agent_dir null).
 */

const STANDALONE: RegistryBinding = {
  server_origin: 'https://app.example.com',
  host_id: 'host_abc',
};

let stateDir: string;
let agentHomeRootDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'shd4e1-h-'));
  agentHomeRootDir = mkdtempSync(join(tmpdir(), 'shd4e1-agents-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(agentHomeRootDir, { recursive: true, force: true });
});

function makeRegistry(binding: RegistryBinding = STANDALONE) {
  return new WorkspaceRegistry({ stateDir, binding });
}

/**
 * The deterministic agent-centric L2 bundle dir a regular workspace resolves
 * to now (relocation-v1 §3.2): `<agent home>/workspaces/<workspace_id>`, no
 * longer `<registry ws path>/.silverhand/agents/<agent>`. Pinned against the
 * real resolver so a layout change is caught here. `agentHomeRootDir` — the
 * EXPLICIT agents root (#task:1813) — is read at call time (set per-test in
 * beforeEach).
 */
function bundleDir(agentId: string, workspaceId: string): string {
  return resolveAgentWorkspaceBundleDir(agentId, workspaceId, { agentHomeRootDir });
}

/**
 * The agent's L1 home dir (`<agentHomeRootDir>/<agent_id>` — ONE join onto the
 * explicit agents root) — the coordinate an agent-home (DM) workspace id
 * resolves to. Pinned against the real resolver; `agentHomeRootDir` is read at
 * call time (set per-test in beforeEach).
 */
function agentHomeDir(agentId: string): string {
  return resolveAgentDir(agentId, { agentHomeRootDir });
}

describe('indexAgentWorkspaces', () => {
  it('resolves a materialized agent-home from agentHomeRootDir, never via the registry', async () => {
    // Cindy 2026-08-04: agent-home `agent_dir` is a CWD fact too — report it
    // ONLY when the L1 dir is a usable cwd (the SAME `bundleCwdUsable` predicate
    // as regular workspaces), never fabricated. Materialize it first.
    const agentHome = agentHomeWorkspaceId('aid_x');
    mkdirSync(agentHomeDir('aid_x'), { recursive: true });
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: [agentHome] },
      { agentHomeRootDir },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toEqual({
      workspace_id: agentHome,
      agent_dir: agentHomeDir('aid_x'),
    });
  });

  it('pushes a never-materialized agent-home to unresolved (never fabricates the L1 path)', async () => {
    // B2 (Cindy 2026-08-04): the agent-home arm must NOT return a path
    // unconditionally. With no L1 dir on disk yet, the coordinate is valid but
    // the cwd is not usable → unresolved (agent_dir null), same as a regular id.
    const agentHome = agentHomeWorkspaceId('aid_x');
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: [agentHome] },
      { agentHomeRootDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual([agentHome]);
  });

  it('reports a non-traversable (000) agent-home dir as unresolved (same cwd predicate)', async () => {
    // B2 falsifier: an existing-but-non-enterable L1 dir must be reported
    // unusable, matching what a spawn could actually chdir into.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const agentHome = agentHomeWorkspaceId('aid_x');
    const dir = agentHomeDir('aid_x');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    try {
      const r = await indexAgentWorkspaces(
        { agent_id: 'aid_x', workspace_ids: [agentHome] },
        { agentHomeRootDir },
      );
      expect(r.entries).toEqual([]);
      expect(r.unresolved).toEqual([agentHome]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('resolves a materialized regular workspace to its agent-centric bundle dir', async () => {
    // relocation-v1 §7 task 4: `agent_dir` is a CWD-existence fact
    // (`bundleCwdUsable`), not a registry binding. Materialize the coordinate
    // by creating the dir; the handler then reports it.
    mkdirSync(bundleDir('aid_x', 'ws_1'), { recursive: true });

    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: ['ws_1'] },
      { agentHomeRootDir },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.entries[0]).toEqual({
      workspace_id: 'ws_1',
      agent_dir: bundleDir('aid_x', 'ws_1'),
    });
  });

  it('pushes a never-materialized regular id to unresolved (lazy window)', async () => {
    // A pure-DB membership add gives a valid coordinate but no dir yet →
    // agent_dir null (surfaced as `unresolved`), never a fabricated path.
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: ['ws_missing'] },
      { agentHomeRootDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual(['ws_missing']);
  });

  it('mixes resolved + unresolved + agent-home in one call, preserving order', async () => {
    mkdirSync(bundleDir('aid_x', 'ws_ok'), { recursive: true });
    mkdirSync(agentHomeDir('aid_x'), { recursive: true });
    const agentHome = agentHomeWorkspaceId('aid_x');

    const r = await indexAgentWorkspaces(
      {
        agent_id: 'aid_x',
        workspace_ids: [agentHome, 'ws_missing', 'ws_ok'],
      },
      { agentHomeRootDir },
    );
    expect(r.entries.map(e => e.workspace_id)).toEqual([agentHome, 'ws_ok']);
    expect(r.unresolved).toEqual(['ws_missing']);
  });

  it('does NOT treat a wsah_ id for a different agent as agent-home', async () => {
    // `wsah_other` is agent-home for `other`, not for `aid_x`. For `aid_x`
    // it is just a regular id with no materialized dir → unresolved, never
    // resolved from agentHomeRootDir.
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid_x', workspace_ids: [agentHomeWorkspaceId('other')] },
      { agentHomeRootDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual([agentHomeWorkspaceId('other')]);
  });

  it('pushes an unsafe id segment to unresolved (never fabricates a path)', async () => {
    // relocation-v1 §7 task 4: an unsafe id can never form a bundle
    // coordinate. The handler degrades it to `unresolved` (→ agent_dir null),
    // never a guessed path and never a hard failure.
    const r = await indexAgentWorkspaces(
      { agent_id: 'aid', workspace_ids: ['../../escape'] },
      { agentHomeRootDir },
    );
    expect(r.entries).toEqual([]);
    expect(r.unresolved).toEqual(['../../escape']);
  });

  it('reports a non-traversable (000) bundle dir as unresolved, matching what a spawn could enter', async () => {
    // Cindy 2026-08-04 nail 1: `agent_dir` must use the SAME cwd-usable
    // predicate as the pre-spawn cwd-ensure (`bundleCwdUsable`: directory +
    // process-enterable via X_OK), NOT bare existence. A dir that exists but the
    // process cannot enter must be reported UNUSABLE, else list would advertise
    // a cwd the spawn then chokes on.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const dir = bundleDir('aid_x', 'ws_locked');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    try {
      const r = await indexAgentWorkspaces(
        { agent_id: 'aid_x', workspace_ids: ['ws_locked'] },
        { agentHomeRootDir },
      );
      expect(r.entries).toEqual([]);
      expect(r.unresolved).toEqual(['ws_locked']);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

// M1 (shiki + Cindy 2026-08-04): the memory-availability predicate must judge
// MEMORY.md a readable regular FILE — a directory (or other non-file) named
// MEMORY.md is "no memory yet", never handed to the prompt as a path.
describe('bundleL2Present', () => {
  it('true for a readable MEMORY.md file, false for a directory of that name', async () => {
    const withFile = bundleDir('aid_x', 'ws_file');
    mkdirSync(withFile, { recursive: true });
    writeFileSync(join(withFile, 'MEMORY.md'), '# memory');
    expect(await bundleL2Present(withFile)).toBe(true);

    const withDir = bundleDir('aid_x', 'ws_dir');
    mkdirSync(join(withDir, 'MEMORY.md'), { recursive: true });
    expect(await bundleL2Present(withDir)).toBe(false);
  });
});

// D4.e-3 slice handler unit tests for `seedAgentL2` — the daemon-owned L2
// (per-workspace) memory seeder. relocation-v1 §7 task 4: there is no registry
// establishment gate any more — seeding IS what makes the deterministic
// agent-centric bundle coordinate
// `<agent home>/workspaces/<workspace_id>/{MEMORY.md,notes/…}` available. It
// fails closed only on the fs (hard write error) or an unsafe id segment, never
// on a registry binding.
// Cindy D4.e-3 review focuses (still pinned):
//   #2 regular-only — an agent-home id is refused structurally (internal_error),
//      never seeded as a spurious `workspaces/<agent-home-id>` bundle;
//   #3 L2 must NEVER carry L1 `system_prompt.md`; MEMORY.md/notes/ present;
//      idempotent re-seed preserves edited content (never overwrites).
describe('seedAgentL2', () => {
  const AGENT_ID = 'aid_member';

  function l2DirFor(workspaceId: string): string {
    return bundleDir(AGENT_ID, workspaceId);
  }

  it('seeds MEMORY.md + notes/ but NEVER system_prompt.md (L1-only)', async () => {
    const r = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { agentHomeRootDir },
    );
    expect(r).toEqual({ ok: true, seeded: true, l2_present: true });

    const l2 = l2DirFor('ws_1');
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

  it('seeds a never-provisioned regular id (seeding IS establishment, no registry gate)', async () => {
    // relocation-v1 §7 task 4: there is no prior provision step — a member
    // agent's first spawn seeds the coordinate directly. This is the primary
    // forward-path behavior change from the registry model.
    const r = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_fresh', template_choice: 'default' },
      { agentHomeRootDir },
    );
    expect(r).toEqual({ ok: true, seeded: true, l2_present: true });
    expect(existsSync(join(l2DirFor('ws_fresh'), 'MEMORY.md'))).toBe(true);
  });

  it('is idempotent: re-seed reports seeded=false and preserves edited content', async () => {
    const l2 = l2DirFor('ws_1');

    await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { agentHomeRootDir },
    );
    // An agent edits its MEMORY.md after the first seed.
    const memPath = join(l2, 'MEMORY.md');
    writeFileSync(memPath, '# edited by the agent\n', 'utf-8');

    const r = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
      { agentHomeRootDir },
    );
    // Nothing new written; the edit survives (no clobber).
    expect(r).toEqual({ ok: true, seeded: false, l2_present: true });
    expect(readFileSync(memPath, 'utf-8')).toBe('# edited by the agent\n');
  });

  it('refuses an agent-home id structurally (regular-only, never seeds an L2==L1 bundle)', async () => {
    // Cindy #2: an agent-home (DM) workspace's L2 IS its L1 home, materialized
    // by agent_materialize. The seeder is regular-only and refuses an agent-home
    // id rather than creating a spurious `workspaces/<agent-home-id>` dir. With
    // no registry gate this is a structural check → internal_error (the backend
    // never sends one).
    const err = await seedAgentL2(
      {
        agent_id: AGENT_ID,
        workspace_id: agentHomeWorkspaceId(AGENT_ID),
        template_choice: 'default',
      },
      { agentHomeRootDir },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('internal_error');
    // No spurious bundle dir was created for the agent-home id.
    expect(existsSync(l2DirFor(agentHomeWorkspaceId(AGENT_ID)))).toBe(false);
  });

  it('rejects an unsupported template_choice with unsupported_template (no fs write)', async () => {
    const err = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'minimal' },
      { agentHomeRootDir },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('unsupported_template');
    // Template is validated before any path is touched → no L2 dir created.
    expect(existsSync(l2DirFor('ws_1'))).toBe(false);
  });

  it('maps an unsafe id segment (invalid_path) to registry_unavailable', async () => {
    // relocation-v1 §7 task 4 — an unsafe workspace id can never become a path
    // segment under the agent home. It fails closed BEFORE touching disk, mapped
    // to the SAME registry_unavailable the other consumers use, never falling
    // through to internal_error.
    const err = await seedAgentL2(
      { agent_id: AGENT_ID, workspace_id: '../../escape', template_choice: 'default' },
      { agentHomeRootDir },
    ).catch(e => e);
    expect(err).toBeInstanceOf(AgentL2SeedError);
    expect((err as AgentL2SeedError).code).toBe('registry_unavailable');
  });

  it('fails closed with fs_unavailable on a HARD fs write error', async () => {
    // chmod 000 on the agent home dir makes the l2Dir mkdir (of its
    // `workspaces/<id>` child) throw EACCES — a hard write error must surface
    // as the typed fs_unavailable (fail-closed), never a silent success.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    const agentHomeDir = join(agentHomeRootDir, AGENT_ID);
    mkdirSync(agentHomeDir, { recursive: true });
    chmodSync(agentHomeDir, 0o000);
    try {
      const err = await seedAgentL2(
        { agent_id: AGENT_ID, workspace_id: 'ws_1', template_choice: 'default' },
        { agentHomeRootDir },
      ).catch(e => e);
      expect(err).toBeInstanceOf(AgentL2SeedError);
      expect((err as AgentL2SeedError).code).toBe('fs_unavailable');
    } finally {
      chmodSync(agentHomeDir, 0o755);
    }
  });
});

describe('purgeAgentFiles', () => {
  const AGENT_ID = 'aid_purge';

  function l1Dir(): string {
    return join(agentHomeRootDir, AGENT_ID);
  }
  function l2DirFor(workspaceId: string): string {
    return bundleDir(AGENT_ID, workspaceId);
  }
  // Materialize an L1 + a per-workspace L2 dir with a marker file so we can
  // assert removal.
  function seedDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '# marker\n', 'utf-8');
  }

  it('removes the whole agent home (L1 + all nested L2) as one target', async () => {
    seedDir(l1Dir());
    seedDir(l2DirFor('ws_1'));
    seedDir(l2DirFor('ws_2'));

    const r = await purgeAgentFiles({ agent_id: AGENT_ID }, { agentHomeRootDir });
    // One rm of the agent home subsumes L1 and every nested L2 bundle
    // (relocation-v1 §3.2 / §7 task 4), so exactly one target is counted and
    // NO registry is consulted.
    expect(r).toEqual({ ok: true, purged_count: 1 });
    expect(r).not.toHaveProperty('quiesced_count');
    expect(existsSync(l1Dir())).toBe(false);
    expect(existsSync(l2DirFor('ws_1'))).toBe(false);
    expect(existsSync(l2DirFor('ws_2'))).toBe(false);
  });

  it('is idempotent: purging an already-gone home succeeds with purged_count=0 (ENOENT not a failure)', async () => {
    // Nothing seeded — the agent home does not exist yet.
    const r = await purgeAgentFiles({ agent_id: AGENT_ID }, { agentHomeRootDir });
    expect(r).toEqual({ ok: true, purged_count: 0 });
  });

  it('fails closed with partial_purge on a HARD fs removal error', async () => {
    // chmod 000 on the agent home makes the recursive rm throw EACCES — a hard
    // error must surface as the typed partial_purge (fail-closed), never a
    // silent success.
    if (process.getuid?.() === 0) return; // root bypasses perms — skip
    seedDir(l1Dir());
    chmodSync(l1Dir(), 0o000);
    try {
      const err = await purgeAgentFiles({ agent_id: AGENT_ID }, { agentHomeRootDir }).catch(
        e => e,
      );
      expect(err).toBeInstanceOf(AgentFilesPurgeError);
      expect((err as AgentFilesPurgeError).code).toBe('partial_purge');
    } finally {
      chmodSync(l1Dir(), 0o755);
    }
  });
});
