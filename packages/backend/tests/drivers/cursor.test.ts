import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CursorDriver } from '../../src/drivers/cursor.js';
import type { DriverSpawnContext } from '../../src/drivers/index.js';

/**
 * Pure unit tests for CursorDriver. Cursor is the simpler protocol —
 * the interesting bits are:
 *  - `buildArgs` writes `<workspace>/.cursor/mcp.json` and packs the
 *    standing prompt into the trailing argv string
 *  - `parseLine` translates cursor-agent's stream-json frames
 *  - `encodeStdinMessage` returns null (oneShot, see ConversationManager)
 *
 * The "respawn-on-pending-inbox" behaviour itself lives in
 * ConversationManager and is exercised by the smoke harness once a mock
 * cursor is added — out of scope for this driver-level suite.
 */

function makeSpawnCtx(overrides: Partial<DriverSpawnContext> = {}): {
  ctx: DriverSpawnContext;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'cursor-driver-test-'));
  const systemPromptPath = join(tmp, 'system-prompt.md');
  writeFileSync(systemPromptPath, 'STANDING PROMPT', 'utf-8');

  const ctx: DriverSpawnContext = {
    agentId: 'agent-1',
    agentName: 'tester',
    workspacePath: tmp,
    cliSessionId: null,
    model: null,
    reasoningEffort: null,
    systemPromptPath,
    mcpConfigPath: join(tmp, 'mcp.json'),
    chatBridge: {
      command: 'node',
      args: ['/abs/path/cli.js'],
      env: { SILVERHAND_BACKEND_URL: 'http://127.0.0.1:0' },
    },
    initialPrompt: '',
    ...overrides,
  };
  return {
    ctx,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('CursorDriver static config', () => {
  it('exposes the expected runtime metadata', () => {
    const d = new CursorDriver();
    expect(d.kind).toBe('cursor');
    expect(d.binary).toBe('cursor-agent');
    expect(d.busyDeliveryMode).toBe('none');
    expect(d.oneShot).toBe(true);
    expect(d.supportsNativeStandingPrompt).toBe(false);
    expect(d.mcpToolPrefix).toBe('mcp__chat__');
  });

  it('applyEnv disables color without mutating the input', () => {
    const d = new CursorDriver();
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', FORCE_COLOR: '1' };
    const out = d.applyEnv(base);
    expect(out.FORCE_COLOR).toBe('0');
    expect(out.NO_COLOR).toBe('1');
    expect(out.PATH).toBe('/usr/bin');
    expect(base.FORCE_COLOR).toBe('1');
    expect(base.NO_COLOR).toBeUndefined();
  });

  it('encodeStdinMessage / encodeInterruptControl both return null', () => {
    const d = new CursorDriver();
    expect(d.encodeStdinMessage('anything', null)).toBeNull();
    expect(d.encodeStdinMessage('anything', 'cli-1')).toBeNull();
    expect(d.encodeInterruptControl()).toBeNull();
  });
});

describe('CursorDriver.buildArgs', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('writes .cursor/mcp.json and emits the expected positional argv', () => {
    const built = makeSpawnCtx({ initialPrompt: 'do the thing' });
    cleanup = built.cleanup;
    const args = new CursorDriver().buildArgs(built.ctx);

    // Fixed prefix.
    expect(args.slice(0, 6)).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--yolo',
      '--approve-mcps',
      '--trust',
    ]);

    // Last arg is the combined kickoff prompt.
    const kickoff = args[args.length - 1];
    expect(kickoff).toContain('STANDING PROMPT');
    expect(kickoff).toContain('do the thing');

    // .cursor/mcp.json was written with the chat-bridge config.
    const mcpJson = JSON.parse(
      readFileSync(join(built.ctx.workspacePath, '.cursor', 'mcp.json'), 'utf-8'),
    );
    expect(mcpJson).toEqual({
      mcpServers: {
        chat: {
          command: 'node',
          args: ['/abs/path/cli.js'],
          env: { SILVERHAND_BACKEND_URL: 'http://127.0.0.1:0' },
        },
      },
    });
  });

  it('falls back to a stand-by nudge when initialPrompt is empty', () => {
    const built = makeSpawnCtx({ initialPrompt: '   ' });
    cleanup = built.cleanup;
    const args = new CursorDriver().buildArgs(built.ctx);
    const kickoff = args[args.length - 1];
    expect(kickoff).toMatch(/stand by/i);
  });

  it('appends --resume <cliSessionId> when resuming an existing thread', () => {
    const built = makeSpawnCtx({ cliSessionId: 'sess-resume-42' });
    cleanup = built.cleanup;
    const args = new CursorDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('sess-resume-42');
  });

  it('appends --model <model> when set', () => {
    const built = makeSpawnCtx({ model: 'sonnet-4.6' });
    cleanup = built.cleanup;
    const args = new CursorDriver().buildArgs(built.ctx);
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('sonnet-4.6');
  });

  it('omits the env block from mcp.json when chatBridge.env is undefined', () => {
    const built = makeSpawnCtx({
      chatBridge: { command: 'node', args: ['cli.js'] },
    });
    cleanup = built.cleanup;
    new CursorDriver().buildArgs(built.ctx);
    const mcpJson = JSON.parse(
      readFileSync(join(built.ctx.workspacePath, '.cursor', 'mcp.json'), 'utf-8'),
    );
    expect(mcpJson.mcpServers.chat.env).toBeUndefined();
  });
});

describe('CursorDriver.parseLine event mapping', () => {
  it('returns kind=unknown for non-JSON lines', () => {
    expect(new CursorDriver().parseLine('garbage')).toEqual([
      { kind: 'unknown', raw: 'garbage' },
    ]);
  });

  it('ignores empty / whitespace-only lines', () => {
    expect(new CursorDriver().parseLine('  ')).toEqual([]);
  });

  it('emits session_init from system.subtype=init', () => {
    const events = new CursorDriver().parseLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    );
    expect(events).toEqual([{ kind: 'session_init', sessionId: 'sess-1' }]);
  });

  it('emits compaction lifecycle from system.subtype variants', () => {
    const driver = new CursorDriver();
    expect(
      driver.parseLine(
        JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
      ),
    ).toEqual([{ kind: 'compaction_started' }]);
    expect(
      driver.parseLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' })),
    ).toEqual([{ kind: 'compaction_finished' }]);
  });

  it('translates assistant content blocks: thinking / text / tool_use', () => {
    const events = new CursorDriver().parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'Hello!' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'mcp__chat__send_message',
              input: { text: 'hi' },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'Hello!' },
      {
        kind: 'tool_call',
        name: 'mcp__chat__send_message',
        input: { text: 'hi' },
        toolCallId: 'call-1',
      },
    ]);
  });

  it('emits turn_end on result success', () => {
    const events = new CursorDriver().parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-9',
      }),
    );
    expect(events).toEqual([{ kind: 'turn_end', sessionId: 'sess-9' }]);
  });

  it('emits error + turn_end on result with is_error / non-success subtype', () => {
    const events = new CursorDriver().parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        errors: ['boom'],
        result: 'see errors',
        session_id: 'sess-9',
      }),
    );
    expect(events).toEqual([
      { kind: 'error', message: 'boom | see errors' },
      { kind: 'turn_end', sessionId: 'sess-9' },
    ]);
  });

  it('falls back to a generic error message when no detail is provided', () => {
    const events = new CursorDriver().parseLine(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true }),
    );
    expect(events).toEqual([
      { kind: 'error', message: 'Execution failed' },
      { kind: 'turn_end' },
    ]);
  });

  it('ignores unknown event types silently', () => {
    expect(
      new CursorDriver().parseLine(JSON.stringify({ type: 'mystery' })),
    ).toEqual([]);
  });
});
