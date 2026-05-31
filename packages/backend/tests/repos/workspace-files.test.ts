import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  ensureAgentL1Dir,
  initWorkspaceDir,
} from '../../src/workspace-files.js';
import { makeTempSilverhandDir } from '../utils/db.js';

// D4.e-3 — backend `seedAgentL2` is REMOVED; L2 (per-workspace) seeding is now
// owned by the daemon (`agent_l2_seed` →
// `packages/host/tests/workspace-registry/handlers.test.ts`). The L2 shape /
// idempotency / no-system_prompt.md invariants are pinned there. What stays on
// the backend is `initWorkspaceDir` (workspace skeleton) + `ensureAgentL1Dir`
// (the agent-materialize test fake's L1 seeder).

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

describe('ensureAgentL1Dir', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
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
});
