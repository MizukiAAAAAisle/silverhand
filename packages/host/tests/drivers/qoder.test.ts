import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DriverSpawnContext } from '../../src/drivers/index.js';
import { QoderDriver } from '../../src/drivers/qoder.js';

function makeSpawnCtx(overrides: Partial<DriverSpawnContext> = {}): {
  ctx: DriverSpawnContext;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'qoder-driver-test-'));
  const systemPromptPath = join(tmp, 'system-prompt.md');
  writeFileSync(systemPromptPath, 'STANDING QODER PROMPT\n', 'utf-8');

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

describe('QoderDriver.buildArgs', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('inlines the standing prompt via --append-system-prompt (no file flag)', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new QoderDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--append-system-prompt');

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('STANDING QODER PROMPT\n');
    // Qoder has no --append-system-prompt-file; the path must NOT leak in.
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).not.toContain(built.ctx.systemPromptPath);
  });

  it('uses snake_case bypass_permissions and omits claude-only flags', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new QoderDriver().buildArgs(built.ctx);
    const pIdx = args.indexOf('--permission-mode');

    expect(args[pIdx + 1]).toBe('bypass_permissions');
    expect(args).toContain('--dangerously-skip-permissions');
    // Qoder's arg parser rejects these claude-only flags (prints usage).
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('denies Silverhand-conflicting plan / cron / goal tools', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new QoderDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--disallowed-tools');
    const list = args[idx + 1];

    for (const tool of [
      'EnterPlanMode',
      'ExitPlanMode',
      'CronCreate',
      'CronList',
      'CronDelete',
      'CreateGoal',
      'GetGoal',
      'UpdateGoal',
    ]) {
      expect(list).toContain(tool);
    }
  });

  it('omits --model when unset and passes it through when set', () => {
    const noModel = makeSpawnCtx();
    expect(new QoderDriver().buildArgs(noModel.ctx)).not.toContain('--model');
    noModel.cleanup();

    const withModel = makeSpawnCtx({ model: 'claude-sonnet-4.5' });
    cleanup = withModel.cleanup;
    const args = new QoderDriver().buildArgs(withModel.ctx);
    const idx = args.indexOf('--model');
    expect(args[idx + 1]).toBe('claude-sonnet-4.5');
  });

  it('adds --resume only when a cliSessionId is present', () => {
    const fresh = makeSpawnCtx();
    expect(new QoderDriver().buildArgs(fresh.ctx)).not.toContain('--resume');
    fresh.cleanup();

    const resumed = makeSpawnCtx({ cliSessionId: 'sess-42' });
    cleanup = resumed.cleanup;
    const args = new QoderDriver().buildArgs(resumed.ctx);
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe('sess-42');
  });

  it('passes stream-json in both directions and no MCP config (core driver)', () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;

    const args = new QoderDriver().buildArgs(built.ctx);
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args).not.toContain('--mcp-config');
  });
});

describe('QoderDriver.encode', () => {
  it('encodes a stream-json user turn, threading the session id', () => {
    const line = new QoderDriver().encodeStdinMessage('hello', 'sess-1');
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      session_id: 'sess-1',
    });
  });

  it('omits session_id when null', () => {
    const line = new QoderDriver().encodeStdinMessage('hi', null);
    expect(JSON.parse(line).session_id).toBeUndefined();
  });

  it('has no verified control-request interrupt (supervisor uses signals)', () => {
    expect(new QoderDriver().encodeInterruptControl()).toBeNull();
  });
});

describe('QoderDriver.classifyInitProgress', () => {
  it('treats any complete stream-json frame as protocol-ready', () => {
    expect(
      new QoderDriver().classifyInitProgress(
        JSON.stringify({ type: 'system', subtype: 'hook_started' }),
      ),
    ).toBe('protocol_ready');
  });

  it('treats system init as session-ready', () => {
    expect(
      new QoderDriver().classifyInitProgress(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'q-1' }),
      ),
    ).toBe('session_ready');
  });
});

describe('QoderDriver.parseLine', () => {
  it('drops Qoder hook frames silently (unmodeled system subtypes)', () => {
    expect(
      new QoderDriver().parseLine(
        JSON.stringify({ type: 'system', subtype: 'hook_started' }),
      ),
    ).toEqual([]);
  });

  it('projects model queue updates as visible runtime activity', () => {
    const driver = new QoderDriver();

    expect(
      driver.parseLine(
        JSON.stringify({
          type: 'system',
          subtype: 'model_queue_status',
          status: 'queued',
          queue_count: 573,
          wait_time_ms: 747_048,
          request_id: 'must-not-surface',
        }),
      ),
    ).toEqual([
      {
        kind: 'thinking',
        text: 'Qoder model request queued (queue size 573, estimated wait 12m 27s)',
      },
    ]);

    expect(
      driver.parseLine(
        JSON.stringify({
          type: 'system',
          subtype: 'model_queue_status',
          status: 'ready',
        }),
      ),
    ).toEqual([
      { kind: 'thinking', text: 'Qoder model is available; resuming request' },
    ]);
  });

  it('keeps malformed queue metadata bounded and does not expose identifiers', () => {
    expect(
      new QoderDriver().parseLine(
        JSON.stringify({
          type: 'system',
          subtype: 'model_queue_status',
          status: 'queued',
          queue_count: 'many',
          wait_time_ms: -1,
          request_id: 'request-secret',
        }),
      ),
    ).toEqual([
      { kind: 'thinking', text: 'Qoder model request queued' },
    ]);
  });

  it('projects assistant thinking / text / tool_use blocks', () => {
    const events = new QoderDriver().parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'answer' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      }),
    );

    expect(events).toEqual([
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'answer' },
      {
        kind: 'tool_call',
        name: 'Bash',
        input: { command: 'echo hi' },
        toolCallId: 'call_1',
      },
    ]);
  });

  it('projects a user tool_result frame (no name field)', () => {
    const events = new QoderDriver().parseLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'hi',
              is_error: false,
            },
          ],
        },
      }),
    );

    expect(events).toEqual([
      { kind: 'tool_output', name: undefined, toolCallId: 'call_1' },
    ]);
  });

  it('labels api_error snippets with the Qoder runtime and redacts the endpoint', () => {
    const events = new QoderDriver().parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        error: { cause: { code: 'ConnectionRefused', path: 'http://127.0.0.1:9090/v1' } },
        retryAttempt: 2,
      }),
    );

    expect(events).toEqual([
      {
        kind: 'error',
        code: 'api_connection_refused',
        message: 'Qoder API gateway unreachable; retrying (attempt 2)',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('127.0.0.1');
  });

  it('emits turn_end on a successful result frame', () => {
    const events = new QoderDriver().parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'q-1',
      }),
    );
    expect(events).toEqual([{ kind: 'turn_end', sessionId: 'q-1' }]);
  });

  it('does NOT classify errors as fatal (Qoder resume-failure is stderr, not a result frame)', () => {
    const events = new QoderDriver().parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        session_id: 'q-1',
        result: 'Some execution error',
      }),
    );

    expect(events[0]).toEqual({ kind: 'error', message: 'Some execution error' });
    expect(events[0]).not.toHaveProperty('fatal');
    expect(events[1]).toEqual({ kind: 'turn_end', sessionId: 'q-1' });
  });
});
