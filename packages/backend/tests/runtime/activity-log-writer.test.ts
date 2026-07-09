import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunState } from '@silverhand/shared';
import { JsonlActivityLogWriter } from '../../src/runtime/activity-log-writer.js';

const STATE: AgentRunState = {
  runId: 'r1',
  agentId: 'a1',
  conversationId: 'c1',
  status: 'tool_running',
  detail: 'Bash',
  startedAt: 1700000000000,
  updatedAt: 1700000000100,
  lastActivityAt: 1700000000100,
  activitySnippet: 'reading logs',
  activitySnippetKind: 'text',
  toolCallCounts: { Bash: 2 },
  compacting: true,
  compactingSince: 1700000000050,
  compactionStale: true,
};

describe('JsonlActivityLogWriter', () => {
  it('writes compact agent_activity JSONL entries and closes idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-activity-log-'));
    const warn = vi.fn();
    const writer = new JsonlActivityLogWriter({
      logDir: dir,
      logger: { warn },
    });
    expect(writer.logPath).toMatch(/agent-activity-.+\.log$/);

    writer.write(STATE);
    await writer.close();
    await writer.close();

    const line = (await readFile(writer.logPath!, 'utf8')).trim();
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      runId: 'r1',
      status: 'tool_running',
      lastActivityAt: 1700000000100,
      activitySnippet: 'reading logs',
      activitySnippetKind: 'text',
      toolCallCounts: { Bash: 2 },
      compacting: true,
      compactingSince: 1700000000050,
      compactionStale: true,
    });
    expect(typeof entry.ts).toBe('string');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is a no-op when logDir is absent', async () => {
    const writer = new JsonlActivityLogWriter({
      logDir: undefined,
      logger: { warn: vi.fn() },
    });
    expect(writer.logPath).toBeNull();
    writer.write(STATE);
    await writer.close();
  });
});
