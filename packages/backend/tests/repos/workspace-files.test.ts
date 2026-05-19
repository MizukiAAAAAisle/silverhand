import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  ensureAgentL1Dir,
  initWorkspaceDir,
  seedAgentL2,
} from '../../src/workspace-files.js';
import { makeTempSilverhandDir } from '../utils/db.js';

describe('initWorkspaceDir', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  it('creates .silverhand/agents and a CONSENSUS.md placeholder, idempotently', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'work');

    await initWorkspaceDir(ws);
    const consensus = join(ws, '.silverhand', 'CONSENSUS.md');
    const agentsDir = join(ws, '.silverhand', 'agents');

    const body = await fs.readFile(consensus, 'utf8');
    expect(body).toContain('Workspace Consensus');
    expect((await fs.stat(agentsDir)).isDirectory()).toBe(true);

    await fs.writeFile(consensus, 'EDITED');
    await initWorkspaceDir(ws);
    expect(await fs.readFile(consensus, 'utf8')).toBe('EDITED');
  });
});

describe('seedAgentL2 + ensureAgentL1Dir', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  it('seeds an L2 MEMORY.md but does NOT copy system_prompt.md from L1', async () => {
    // Per the four-file model: system_prompt.md is L1-only. seedAgentL2
    // must not materialize an L2 copy under any circumstance, even if
    // L1 already has one — the assembler reads system_prompt.md from L1
    // directly. See docs/agent-system-prompt-memory.md.
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);

    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'agent-xyz';
    const agentL1Dir = join(t.silverhandDir, 'agents', agentId);
    await ensureAgentL1Dir(agentL1Dir);
    await fs.writeFile(join(agentL1Dir, 'system_prompt.md'), 'L1-PROMPT');

    await seedAgentL2({ workspacePath: ws, agentId });

    const l2Dir = join(ws, '.silverhand', 'agents', agentId);
    const l2Memory = join(l2Dir, 'MEMORY.md');
    const l2Prompt = join(l2Dir, 'system_prompt.md');

    expect(await fs.readFile(l2Memory, 'utf8')).toContain('Key Knowledge');
    await expect(fs.access(l2Prompt)).rejects.toThrow();
  });

  it('preserves an existing L2 MEMORY.md on re-seed', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);

    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);
    const agentId = 'agent-reseed';

    await seedAgentL2({ workspacePath: ws, agentId });
    const memoryPath = join(ws, '.silverhand', 'agents', agentId, 'MEMORY.md');
    await fs.writeFile(memoryPath, 'L2-EDITED');

    await seedAgentL2({ workspacePath: ws, agentId });
    expect(await fs.readFile(memoryPath, 'utf8')).toBe('L2-EDITED');
  });

  it('seeds L1 memory and notes on first ensure; preserves them on re-ensure', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);

    const agentL1Dir = join(t.silverhandDir, 'agents', 'agent-l1');
    await ensureAgentL1Dir(agentL1Dir);

    const memoryPath = join(agentL1Dir, 'MEMORY.md');
    const workLogPath = join(agentL1Dir, 'notes', 'work-log.md');
    const memory = await fs.readFile(memoryPath, 'utf8');
    const workLog = await fs.readFile(workLogPath, 'utf8');

    expect(memory).toContain('Key Knowledge');
    expect(memory).toContain('Role source: system_prompt.md');
    expect(memory).toContain('work-log.md');
    expect(memory).toContain('current handoff');
    expect(memory).not.toContain('## Role');
    expect(workLog).toContain('Work Log');

    await fs.writeFile(memoryPath, 'L1-EDITED');
    await fs.writeFile(workLogPath, 'WORK-LOG-EDITED');
    await ensureAgentL1Dir(agentL1Dir);

    expect(await fs.readFile(memoryPath, 'utf8')).toBe('L1-EDITED');
    expect(await fs.readFile(workLogPath, 'utf8')).toBe('WORK-LOG-EDITED');
  });

  it('seeds onboarding and memory notes into notes/ on first seed', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'notes-agent';
    await seedAgentL2({ workspacePath: ws, agentId });

    const notesDir = join(ws, '.silverhand', 'agents', agentId, 'notes');
    const guide = await fs.readFile(join(notesDir, 'onboarding-guide.md'), 'utf8');
    const faq = await fs.readFile(join(notesDir, 'onboarding-faq.md'), 'utf8');
    const userPreferences = await fs.readFile(join(notesDir, 'user-preferences.md'), 'utf8');
    const project = await fs.readFile(join(notesDir, 'project.md'), 'utf8');
    const workLog = await fs.readFile(join(notesDir, 'work-log.md'), 'utf8');

    expect(guide).toContain('Silverhand Onboarding Guide');
    expect(faq).toContain('Silverhand Onboarding FAQ');
    expect(userPreferences).toContain('User Preferences');
    expect(project).toContain('Project Notes');
    expect(workLog).toContain('Work Log');
  });

  it('the onboarding guide reflects the four-file model (L1 identity, L2 memory)', async () => {
    // Drift test: the seed copy of the guide must teach the new model,
    // not the legacy "system_prompt.md per workspace" wording. If the
    // user adds a third file, this test reminds them to update the guide.
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'drift-agent';
    await seedAgentL2({ workspacePath: ws, agentId });

    const guide = await fs.readFile(
      join(ws, '.silverhand', 'agents', agentId, 'notes', 'onboarding-guide.md'),
      'utf8',
    );

    // New-model phrasing.
    expect(guide).toContain('L1 — agent identity');
    expect(guide).toContain('L2 — workspace memory');
    expect(guide).toContain('DM-only writes');
    // Old-model phrasing must not survive.
    expect(guide).not.toContain('update system_prompt.md first');
  });

  it('preserves existing notes files on re-seed', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'notes-preserve';
    await seedAgentL2({ workspacePath: ws, agentId });

    const guidePath = join(ws, '.silverhand', 'agents', agentId, 'notes', 'onboarding-guide.md');
    await fs.writeFile(guidePath, 'AGENT-EDITED');

    // Re-seed must not overwrite agent's edits.
    await seedAgentL2({ workspacePath: ws, agentId });
    expect(await fs.readFile(guidePath, 'utf8')).toBe('AGENT-EDITED');
  });

  it('MEMORY.md placeholder includes Key Knowledge index for fresh L2 seeds', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'memory-placeholder';
    await seedAgentL2({ workspacePath: ws, agentId });

    const memory = await fs.readFile(
      join(ws, '.silverhand', 'agents', agentId, 'MEMORY.md'),
      'utf8',
    );
    expect(memory).toContain('Key Knowledge');
    expect(memory).toContain('Role source: system_prompt.md');
    expect(memory).toContain('onboarding-guide.md');
    expect(memory).toContain('onboarding-faq.md');
    expect(memory).toContain('user-preferences.md');
    expect(memory).toContain('project.md');
    expect(memory).toContain('work-log.md');
    expect(memory).toContain('current handoff');
    expect(memory).not.toContain('## Role');
  });
});
