import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../../src/drivers/claude.js';
import type { DriverSpawnContext } from '../../src/drivers/index.js';

function makeSpawnCtx(overrides: Partial<DriverSpawnContext> = {}): {
  ctx: DriverSpawnContext;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-driver-test-'));
  const systemPromptPath = join(tmp, 'system-prompt.md');
  writeFileSync(systemPromptPath, 'STANDING PROMPT\n', 'utf-8');

  const ctx: DriverSpawnContext = {
    agentId: 'agent-1',
    agentName: 'tester',
    workspacePath: tmp,
    cliSessionId: null,
    model: null,
    reasoningEffort: null,
    fastMode: null,
    systemPromptPath,
    mcpConfigPath: join(tmp, 'mcp.json'),
    chatBridge: { command: 'node', args: ['cli.js'] },
    initialPrompt: '',
    ...overrides,
  };

  return {
    ctx,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('ClaudeDriver.buildArgs', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('defaults to opus when no model is configured', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new ClaudeDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--model');

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('opus');
  });

  it('uses an explicitly configured model', () => {
    const built = makeSpawnCtx({ model: 'sonnet' });
    cleanup = built.cleanup;

    const args = new ClaudeDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--model');

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('sonnet');
  });
});

describe('ClaudeDriver.classifyInitProgress', () => {
  it('treats any complete stream-json frame as protocol-ready', () => {
    const d = new ClaudeDriver();
    expect(
      d.classifyInitProgress(
        JSON.stringify({ type: 'system', subtype: 'status', status: 'warming' }),
      ),
    ).toBe('protocol_ready');
  });

  it('treats system init as session-ready', () => {
    const d = new ClaudeDriver();
    expect(
      d.classifyInitProgress(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-1' }),
      ),
    ).toBe('session_ready');
  });

  it('ignores non-json lines', () => {
    expect(new ClaudeDriver().classifyInitProgress('not json')).toBeNull();
  });
});
