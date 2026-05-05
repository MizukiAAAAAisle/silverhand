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

  it('copies L1 files to L2 on first seed; preserves L2 on re-seed', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);

    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'agent-xyz';
    const agentL1Dir = join(t.silverhandDir, 'agents', agentId);
    await ensureAgentL1Dir(agentL1Dir);

    await fs.writeFile(join(agentL1Dir, 'system_prompt.md'), 'L1-PROMPT');
    await fs.writeFile(join(agentL1Dir, 'MEMORY.md'), 'L1-MEMORY');

    await seedAgentL2({ workspacePath: ws, agentId, agentL1Dir });

    const l2Prompt = join(ws, '.silverhand', 'agents', agentId, 'system_prompt.md');
    const l2Memory = join(ws, '.silverhand', 'agents', agentId, 'MEMORY.md');
    expect(await fs.readFile(l2Prompt, 'utf8')).toBe('L1-PROMPT');
    expect(await fs.readFile(l2Memory, 'utf8')).toBe('L1-MEMORY');

    await fs.writeFile(l2Prompt, 'L2-EDITED');
    await fs.writeFile(join(agentL1Dir, 'system_prompt.md'), 'L1-CHANGED');
    await seedAgentL2({ workspacePath: ws, agentId, agentL1Dir });
    expect(await fs.readFile(l2Prompt, 'utf8')).toBe('L2-EDITED');
  });

  it('writes a placeholder when L1 is missing entirely', async () => {
    const t = makeTempSilverhandDir();
    cleanups.push(t.cleanup);
    const ws = join(t.silverhandDir, 'ws');
    await initWorkspaceDir(ws);

    const agentId = 'unseeded';
    const agentL1Dir = join(t.silverhandDir, 'agents', agentId);
    await seedAgentL2({ workspacePath: ws, agentId, agentL1Dir });

    const l2Prompt = await fs.readFile(
      join(ws, '.silverhand', 'agents', agentId, 'system_prompt.md'),
      'utf8',
    );
    expect(l2Prompt).toContain('Role');
  });
});
