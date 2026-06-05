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

  it('does not pass an MCP config after the CLI cutover', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new ClaudeDriver().buildArgs(built.ctx);

    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).toContain('--append-system-prompt-file');
    expect(args).toContain(built.ctx.systemPromptPath);
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

describe('ClaudeDriver.parseLine', () => {
  it('projects Claude system api_error as a safe non-fatal error event', () => {
    const events = new ClaudeDriver().parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        error: {
          type: null,
          cause: {
            code: 'ConnectionRefused',
            path: 'http://127.0.0.1:9090/v1/messages?beta=true',
            errno: 0,
          },
        },
        retryAttempt: 3,
      }),
    );

    expect(events).toEqual([
      {
        kind: 'error',
        code: 'api_connection_refused',
        message: 'Claude API gateway unreachable; retrying (attempt 3)',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('127.0.0.1');
    expect(JSON.stringify(events)).not.toContain('/v1/messages');
  });

  it('classifies stale --resume result errors as fatal', () => {
    const events = new ClaudeDriver().parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        session_id: '46af7b63-3663-4614-a4e5-a1e93f3a0230',
        errors: [
          'No conversation found with session ID: 11111111-1111-4111-8111-111111111111',
        ],
      }),
    );

    expect(events[0]).toEqual({
      kind: 'error',
      code: 'session_not_found',
      fatal: true,
      message:
        'No conversation found with session ID: 11111111-1111-4111-8111-111111111111',
    });
    expect(events[1]).toEqual({
      kind: 'turn_end',
      sessionId: '46af7b63-3663-4614-a4e5-a1e93f3a0230',
    });
  });
});
