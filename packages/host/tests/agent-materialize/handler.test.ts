import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_HOME_SENTINEL_FILENAME,
  AGENT_HOME_TEMPLATE_VERSION,
  AgentMaterializeError,
  computeAgentDir,
  computeAgentDirFromRoot,
  materializeAgent,
  readSentinel,
} from '../../src/daemon/agent-materialize/index.js';

/**
 * D4.d D2 handler tests. The handler is the §4.6 decision tree;
 * each `it` below pins one of the seven cases (success, idempotent,
 * three mismatch flavors, foreign-content, fs-classification).
 *
 * Tmp home dir convention: each test gets its own `mkdtempSync` so
 * cases cannot bleed (especially the "permission-denied" arm, which
 * leaves a dir mode flipped). Tests run on the daemon's local fs;
 * the handler's `homeDir` injection points us at the tmp tree.
 */

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'silverhand-d4d-d2-'));
});

afterEach(() => {
  // Restore writable mode in case a test flipped it; rmSync ignores
  // the perms but trying to clean up cleanly keeps CI output sane.
  try {
    chmodSync(homeDir, 0o755);
  } catch {
    // ignore
  }
  rmSync(homeDir, { recursive: true, force: true });
});

function baseParams(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agent_id: 'aid_abc',
    agent_home_workspace_id: 'wsah_aid_abc',
    name: 'TestAgent',
    runtime: 'claude' as const,
    template_choice: 'default' as const,
    ...overrides,
  };
}

describe('materializeAgent — §4.6 decision tree', () => {
  it('first-time materialize: missing dir → seed + sentinel + ok', async () => {
    const result = await materializeAgent(baseParams(), {
      homeDir,
      now: () => 1_700_000_000_000,
    });

    const agentDir = computeAgentDir('aid_abc', homeDir);
    expect(result).toEqual({
      ok: true,
      agent_dir: agentDir,
      agent_home_workspace_path: agentDir, // §6.5 invariant
      materialized_at: 1_700_000_000_000,
    });

    // Template seeded — system_prompt + MEMORY + notes/ files
    expect(existsSync(join(agentDir, 'system_prompt.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(true);
    expect(readFileSync(join(agentDir, 'MEMORY.md'), 'utf8')).toContain(
      'Group live handoffs by source channel name',
    );
    expect(existsSync(join(agentDir, 'notes/onboarding-guide.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'notes/onboarding-faq.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'notes/user-preferences.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'notes/project.md'))).toBe(true);
    expect(existsSync(join(agentDir, 'notes/work-log.md'))).toBe(true);
    const onboardingGuide = readFileSync(
      join(agentDir, 'notes/onboarding-guide.md'),
      'utf8',
    );
    expect(onboardingGuide).toContain(
      'The daemon-resolved L1 `system_prompt.md` path',
    );
    expect(onboardingGuide).not.toContain('~/.silverhand');
    expect(
      readFileSync(join(agentDir, 'notes/user-preferences.md'), 'utf8'),
    ).toMatch(
      /^---\nname: user-preferences\ndescription: [^\n]+\nmetadata:\n  category: user\n---\n/u,
    );

    // Sentinel carries identity plus materialization-time runtime provenance.
    const sentinelPath = join(agentDir, AGENT_HOME_SENTINEL_FILENAME);
    const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    expect(sentinel).toEqual({
      version: AGENT_HOME_TEMPLATE_VERSION,
      agent_id: 'aid_abc',
      template_choice: 'default',
      runtime: 'claude',
      materialized_at: 1_700_000_000_000,
    });
  });

  it('uses agentHomeRootDir when provided', async () => {
    const agentHomeRootDir = join(homeDir, 'isolated-agents');
    const result = await materializeAgent(baseParams(), {
      agentHomeRootDir,
      now: () => 1_700_000_000_000,
    });

    const agentDir = computeAgentDirFromRoot('aid_abc', agentHomeRootDir);
    expect(result.agent_dir).toBe(agentDir);
    expect(result.agent_home_workspace_path).toBe(agentDir);
    expect(existsSync(join(agentDir, 'system_prompt.md'))).toBe(true);
    expect(existsSync(computeAgentDir('aid_abc', homeDir))).toBe(false);
  });

  it('idempotent re-call: sentinel identity fields match → ok without rewrite', async () => {
    await materializeAgent(baseParams(), {
      homeDir,
      now: () => 1_700_000_000_000,
    });
    const agentDir = computeAgentDir('aid_abc', homeDir);
    // Mutate a template file to prove the second call does NOT
    // re-seed (idempotent ok must not overwrite existing files).
    const promptPath = join(agentDir, 'system_prompt.md');
    writeFileSync(promptPath, 'user-edited content');

    const result = await materializeAgent(baseParams(), {
      homeDir,
      now: () => 1_700_999_999_999,
    });

    // materialized_at is the ORIGINAL sentinel time, NOT the
    // second-call now() — idempotent path returns sentinel state.
    expect(result.materialized_at).toBe(1_700_000_000_000);
    expect(readFileSync(promptPath, 'utf8')).toBe('user-edited content');
  });

  it.each(['agent_id', 'template_choice'] as const)(
    'sentinel mismatch on %s → agent_dir_collision',
    async field => {
      // First materialize with the canonical params.
      await materializeAgent(baseParams(), { homeDir });
      const agentDir = computeAgentDir('aid_abc', homeDir);
      const sentinelPath = join(agentDir, AGENT_HOME_SENTINEL_FILENAME);

      // Mutate ONE sentinel field so the second call (which sends
      // the canonical request) sees a stored mismatch. We mutate
      // the sentinel rather than the request because (a) `agent_id`
      // is part of the dir path so changing it would point at a
      // different dir entirely, and (b) `template_choice: 'onboarding'`
      // would trip `unsupported_template` first. Mutating the stored
      // sentinel exercises the pure §4.6 mismatch branch.
      const stored = JSON.parse(readFileSync(sentinelPath, 'utf8'));
      switch (field) {
        case 'agent_id':
          stored.agent_id = 'aid_someone_else';
          break;
        case 'template_choice':
          stored.template_choice = 'minimal';
          break;
      }
      writeFileSync(sentinelPath, JSON.stringify(stored));

      await expect(materializeAgent(baseParams(), { homeDir })).rejects.toMatchObject({
        name: 'AgentMaterializeError',
        code: 'agent_dir_collision',
        message: expect.stringContaining(field),
      });
    },
  );

  it('treats sentinel runtime as materialization provenance, not directory identity', async () => {
    await materializeAgent(baseParams(), { homeDir });
    const agentDir = computeAgentDir('aid_abc', homeDir);
    const file = join(agentDir, AGENT_HOME_SENTINEL_FILENAME);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.runtime = 'codex';
    writeFileSync(file, JSON.stringify(stored));

    const result = await materializeAgent(baseParams(), { homeDir });

    expect(result.ok).toBe(true);
    expect(result.materialized_at).toBe(stored.materialized_at);
    expect(JSON.parse(readFileSync(file, 'utf8')).runtime).toBe('codex');
  });

  it('foreign content in dir (no sentinel) → agent_dir_collision', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'someone-elses-file'), 'hello');

    await expect(materializeAgent(baseParams(), { homeDir })).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'agent_dir_collision',
      message: expect.stringContaining('someone-elses-file'),
    });
    // Foreign file untouched.
    expect(readFileSync(join(agentDir, 'someone-elses-file'), 'utf8')).toBe('hello');
    // No sentinel was written (handler did NOT fall through to seed).
    expect(existsSync(join(agentDir, AGENT_HOME_SENTINEL_FILENAME))).toBe(false);
  });

  it('empty dir (no sentinel) → seed (not collision)', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);
    mkdirSync(agentDir, { recursive: true });
    expect(readdirSync(agentDir)).toEqual([]);

    const result = await materializeAgent(baseParams(), { homeDir });
    expect(result.ok).toBe(true);
    expect(existsSync(join(agentDir, AGENT_HOME_SENTINEL_FILENAME))).toBe(true);
  });

  it('sentinel JSON corrupt → agent_dir_collision (fail-closed)', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, AGENT_HOME_SENTINEL_FILENAME),
      'this is not json {{{',
    );

    await expect(materializeAgent(baseParams(), { homeDir })).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'agent_dir_collision',
      message: expect.stringContaining('unrecognized sentinel'),
    });
  });

  it('sentinel with unknown version → agent_dir_collision', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, AGENT_HOME_SENTINEL_FILENAME),
      JSON.stringify({
        version: 99,
        agent_id: 'aid_abc',
        template_choice: 'default',
        runtime: 'claude',
        materialized_at: 1,
      }),
    );

    await expect(materializeAgent(baseParams(), { homeDir })).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'agent_dir_collision',
    });
  });

  it('unsupported template_choice → unsupported_template (fails before fs touch)', async () => {
    await expect(
      materializeAgent(baseParams({ template_choice: 'onboarding' }), {
        homeDir,
      }),
    ).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'unsupported_template',
    });

    // Critical: no dir was created. The template gate must trip
    // BEFORE the fs branches so a fail-fast doesn't half-create
    // an empty dir that the next retry would mistake for an
    // empty-but-claimed state.
    const agentDir = computeAgentDir('aid_abc', homeDir);
    expect(existsSync(agentDir)).toBe(false);
  });

  it('EACCES on dir read → fs_unavailable (preserves quota/unavailable distinction)', async () => {
    // First materialize to create the dir, then make the dir
    // unreadable. The next call's `readdirSync` will EACCES on
    // the parent silverhand dir.
    await materializeAgent(baseParams(), { homeDir });
    const agentParent = join(homeDir, '.silverhand', 'agents');
    chmodSync(agentParent, 0o000);

    try {
      await expect(
        materializeAgent(baseParams({ agent_id: 'aid_other' }), { homeDir }),
      ).rejects.toMatchObject({
        name: 'AgentMaterializeError',
        // EACCES → fs_unavailable (NOT internal_error — Cindy
        // pre-gate #3: don't squash recoverable / unavailable / collision)
        code: 'fs_unavailable',
      });
    } finally {
      chmodSync(agentParent, 0o755);
    }
  });

  it('exports AgentMaterializeError as a typed class', () => {
    // Sanity pin so a future refactor that turns the class into a
    // plain object stops with a typecheck rather than silently
    // breaking the dispatcher's `instanceof` detection.
    const err = new AgentMaterializeError('agent_dir_collision', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentMaterializeError);
    expect(err.code).toBe('agent_dir_collision');
  });

  // Cindy D2 P1-2: the path-equality invariant must live in the
  // schema, not just in a comment. A handler that returned a
  // diverging pair would otherwise pass result validation and ship
  // a wrong `agent_home_workspace_path` into the server's L3a
  // workspace row. We can't easily induce the divergence in a real
  // handler call (handler always sets both to `agentDir`), so the
  // pin lives at the schema level.
  it('AgentMaterializeResultSchema rejects mismatched agent_dir / agent_home_workspace_path', async () => {
    const { AgentMaterializeResultSchema } = await import(
      '../../src/protocol.js'
    );
    const parsed = AgentMaterializeResultSchema.safeParse({
      ok: true,
      agent_dir: '/home/x/.silverhand/agents/aid_a',
      agent_home_workspace_path: '/home/x/.silverhand/agents/aid_DIFFERENT',
      materialized_at: 1,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.errors.some(
        e =>
          e.path.includes('agent_home_workspace_path') &&
          /must equal agent_dir/.test(e.message),
      ),
    ).toBe(true);
  });

  // Cindy D2 round-2 P1: the §4.6 empty-dir collision check only
  // catches foreign content ALREADY present when `readdirSync(agentDir)`
  // runs — it short-circuits before `seedTemplate` / `linkSync` (that
  // case is covered above by 'foreign content in dir (no sentinel)').
  // The actual race-window bug she identified is:
  //
  //   1. empty-dir check passes (dir really is empty)
  //   2. <interleave> foreign writer drops a non-colliding file
  //      with a name that is NOT in the template (e.g. `marker`)
  //   3. seedTemplate runs — `linkSync` on every template file
  //      succeeds (foreign name doesn't conflict with any target)
  //   4. handler writes sentinel — daemon now formally adopts a
  //      directory containing foreign content
  //
  // The new `afterEmptyDirCheck` hook simulates that race by
  // dropping the foreign file at the exact point step 2 would
  // occur. The post-seed `verifyExpectedTree` scan must catch
  // it and refuse to write the sentinel.
  it('non-colliding foreign content dropped after empty-dir check → agent_dir_collision (post-seed scan catches it, sentinel NOT written)', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);

    await expect(
      materializeAgent(baseParams(), {
        homeDir,
        afterEmptyDirCheck: dir => {
          // Race winner drops a file the template doesn't own.
          // `notes/` is created by seedTemplate (in step 3) so we
          // drop the file at the root with a name that won't
          // collide with any template target.
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'foreign-marker'), 'race-winner content');
        },
      }),
    ).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'agent_dir_collision',
      message: expect.stringContaining('post-seed expected-tree scan'),
    });

    // Sentinel was NOT written — that's the load-bearing pin.
    // A retry will see foreign content via the §4.6 empty-dir
    // branch and collision identically; we never adopt an
    // unknown dir.
    expect(existsSync(join(agentDir, AGENT_HOME_SENTINEL_FILENAME))).toBe(false);
    // Foreign content untouched.
    expect(readFileSync(join(agentDir, 'foreign-marker'), 'utf8')).toBe(
      'race-winner content',
    );
  });

  // Cindy D2 round-2 P1: same race window but inside a nested
  // directory the template DOES create (`notes/`). Pins that the
  // `verifyExpectedTree` walk descends into template-declared
  // subdirs rather than only checking the top level.
  it('non-colliding foreign content dropped into template subdir → agent_dir_collision (nested scan catches it)', async () => {
    const agentDir = computeAgentDir('aid_abc', homeDir);

    await expect(
      materializeAgent(baseParams(), {
        homeDir,
        afterEmptyDirCheck: dir => {
          // Pre-create notes/ so we can drop a foreign file inside it
          // BEFORE seedTemplate runs. The template will then write
          // its own notes/* files via linkSync (no collision because
          // the foreign file has a unique name) and we need the
          // post-seed scan to catch the foreign nested entry.
          mkdirSync(join(dir, 'notes'), { recursive: true });
          writeFileSync(
            join(dir, 'notes/foreign-note.md'),
            'race-winner content',
          );
        },
      }),
    ).rejects.toMatchObject({
      name: 'AgentMaterializeError',
      code: 'agent_dir_collision',
      message: expect.stringContaining('notes/foreign-note.md'),
    });

    expect(existsSync(join(agentDir, AGENT_HOME_SENTINEL_FILENAME))).toBe(false);
    expect(readFileSync(join(agentDir, 'notes/foreign-note.md'), 'utf8')).toBe(
      'race-winner content',
    );
  });
});

describe('readSentinel — schema sanity', () => {
  it('returns kind:missing when the file does not exist', () => {
    const agentDir = computeAgentDir('aid_nope', homeDir);
    mkdirSync(agentDir, { recursive: true });
    const result = readSentinel(agentDir);
    expect(result.kind).toBe('missing');
  });

  it('returns kind:invalid for partial sentinel (missing runtime)', () => {
    const agentDir = computeAgentDir('aid_partial', homeDir);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, AGENT_HOME_SENTINEL_FILENAME),
      JSON.stringify({
        version: AGENT_HOME_TEMPLATE_VERSION,
        agent_id: 'aid_partial',
        template_choice: 'default',
        // runtime intentionally omitted
        materialized_at: 1,
      }),
    );
    const result = readSentinel(agentDir);
    expect(result.kind).toBe('invalid');
  });
});
