import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexDriver } from '../../src/drivers/codex.js';
import type { DriverIO, DriverSpawnContext } from '../../src/drivers/index.js';

/**
 * Pure unit tests for CodexDriver — exercise the JSON-RPC handshake and
 * `parseLine` event mapping without spawning a real `codex` binary.
 *
 * The handshake test uses a fake DriverIO that captures every line the
 * driver tries to write; we assert the issued requests / notifications
 * line up with what `codex app-server` expects.
 */

interface CapturedIO extends DriverIO {
  lines: string[];
}

function makeIO(spawnCtx: DriverSpawnContext): CapturedIO {
  const lines: string[] = [];
  return {
    spawnCtx,
    lines,
    writeLine: async (line: string) => {
      lines.push(line);
    },
  };
}

function makeSpawnCtx(overrides: Partial<DriverSpawnContext> = {}): {
  ctx: DriverSpawnContext;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-driver-test-'));
  const systemPromptPath = join(tmp, 'system-prompt.md');
  writeFileSync(systemPromptPath, 'STANDING PROMPT\n', 'utf-8');

  // codex requires a git repo — make this a real one so bindIO doesn't
  // shell out to git.
  writeFileSync(join(tmp, '.git'), '');

  const ctx: DriverSpawnContext = {
    agentId: 'agent-1',
    agentName: 'tester',
    workspacePath: tmp,
    cliSessionId: null,
    model: null,
    systemPromptPath,
    mcpConfigPath: join(tmp, 'mcp.json'),
    chatBridge: {
      command: '/usr/bin/env',
      args: ['node', '/path/to/chat-bridge/cli.js'],
      env: { SILVERHAND_BACKEND_URL: 'http://127.0.0.1:0' },
    },
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

/** Wait one microtask tick so `bindIO`'s `queueMicrotask` runs. */
async function tick(): Promise<void> {
  await new Promise(r => queueMicrotask(() => r(undefined)));
}

describe('CodexDriver static config', () => {
  it('exposes the expected runtime metadata', () => {
    const d = new CodexDriver();
    expect(d.kind).toBe('codex');
    expect(d.binary).toBe('codex');
    expect(d.busyDeliveryMode).toBe('direct');
    expect(d.oneShot).toBe(false);
    expect(d.supportsNativeStandingPrompt).toBe(true);
    expect(d.mcpToolPrefix).toBe('mcp_chat_');
  });

  it('applyEnv adds NO_COLOR without mutating the input', () => {
    const d = new CodexDriver();
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const out = d.applyEnv(base);
    expect(out.NO_COLOR).toBe('1');
    expect(out.PATH).toBe('/usr/bin');
    expect(base.NO_COLOR).toBeUndefined();
  });

  it('encodeInterruptControl returns null (no protocol cancel)', () => {
    expect(new CodexDriver().encodeInterruptControl()).toBeNull();
  });
});

describe('CodexDriver.buildArgs', () => {
  it('passes app-server stdio + one -c per env var', () => {
    const { ctx, cleanup } = makeSpawnCtx();
    try {
      const args = new CodexDriver().buildArgs(ctx);
      expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
      // Each `-c key=value` entry comes in pairs.
      const kv = collectCArgs(args);
      expect(kv.get('mcp_servers.chat.command')).toBe(
        JSON.stringify(ctx.chatBridge.command),
      );
      expect(kv.get('mcp_servers.chat.args')).toBe(
        JSON.stringify(ctx.chatBridge.args),
      );
      expect(kv.get('mcp_servers.chat.enabled')).toBe('true');
      expect(kv.get('mcp_servers.chat.required')).toBe('true');
      expect(kv.get('mcp_servers.chat.env.SILVERHAND_BACKEND_URL')).toBe(
        JSON.stringify(ctx.chatBridge.env!.SILVERHAND_BACKEND_URL),
      );
    } finally {
      cleanup();
    }
  });

  it('quotes env keys that aren\'t TOML-bare-key safe', () => {
    const { ctx, cleanup } = makeSpawnCtx({
      chatBridge: {
        command: 'node',
        args: ['cli.js'],
        env: { 'with.dot': 'v' },
      },
    });
    try {
      const args = new CodexDriver().buildArgs(ctx);
      const kv = collectCArgs(args);
      // Quoted-key form: mcp_servers.chat.env."with.dot"
      const found = [...kv.keys()].find(k => k.endsWith('."with.dot"'));
      expect(found).toBeDefined();
      expect(kv.get(found!)).toBe('"v"');
    } finally {
      cleanup();
    }
  });
});

describe('CodexDriver JSON-RPC handshake', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('initialize → initialized → thread/start, then session_init on thread/started', async () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();

    expect(io.lines).toHaveLength(1);
    const init = JSON.parse(io.lines[0]!);
    expect(init).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        clientInfo: { name: 'silverhand', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
    expect(typeof init.id).toBe('number');

    // Server replies to initialize → driver should send `initialized`
    // notification + `thread/start` request.
    const events1 = driver.parseLine(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }),
    );
    expect(events1).toEqual([]);
    expect(io.lines).toHaveLength(3);
    const initialized = JSON.parse(io.lines[1]!);
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
    expect(initialized.id).toBeUndefined();
    const threadStart = JSON.parse(io.lines[2]!);
    expect(threadStart).toMatchObject({
      jsonrpc: '2.0',
      method: 'thread/start',
      params: {
        cwd: built.ctx.workspacePath,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions: 'STANDING PROMPT\n',
      },
    });

    // Either `thread/started` notification OR a `result.thread` reply
    // surfaces the threadId. Try the notification path here.
    const events2 = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-abc' } },
      }),
    );
    expect(events2).toEqual([{ kind: 'session_init', sessionId: 'thread-abc' }]);

    // Subsequent thread/started with the SAME id should not re-announce.
    const events3 = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-abc' } },
      }),
    );
    expect(events3.find(e => e.kind === 'session_init')).toBeUndefined();
  });

  it('uses thread/resume when cliSessionId is set', async () => {
    const built = makeSpawnCtx({ cliSessionId: 'thread-resumed' });
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();
    const init = JSON.parse(io.lines[0]!);

    driver.parseLine(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }),
    );
    const threadCall = JSON.parse(io.lines[2]!);
    expect(threadCall.method).toBe('thread/resume');
    expect(threadCall.params).toMatchObject({
      threadId: 'thread-resumed',
      cwd: built.ctx.workspacePath,
    });
  });

  it('does not send turn/start to a resume target before thread/resume is ready', async () => {
    const built = makeSpawnCtx({ cliSessionId: 'thread-resumed' });
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();
    const init = JSON.parse(io.lines[0]!);
    driver.parseLine(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }),
    );
    const resume = JSON.parse(io.lines[2]!);
    expect(resume.method).toBe('thread/resume');

    expect(driver.encodeStdinMessage('queued while starting', 'thread-resumed')).toBeNull();

    const events = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: resume.id,
        result: { thread: { id: 'thread-resumed' } },
      }),
    );
    expect(events).toEqual([{ kind: 'session_init', sessionId: 'thread-resumed' }]);

    const line = driver.encodeStdinMessage('after resume', 'thread-resumed');
    expect(line).not.toBeNull();
    const turn = JSON.parse(line!);
    expect(turn).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-resumed',
        input: [{ type: 'text', text: 'after resume' }],
      },
    });
  });

  it('fires the initial turn/start automatically when initialPrompt is set', async () => {
    const built = makeSpawnCtx({ initialPrompt: 'hello there' });
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();
    const init = JSON.parse(io.lines[0]!);
    driver.parseLine(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }),
    );
    // thread/started → triggers session_init AND startInitialTurn
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-xyz' } },
      }),
    );

    const last = JSON.parse(io.lines[io.lines.length - 1]!);
    expect(last.method).toBe('turn/start');
    expect(last.params).toMatchObject({
      threadId: 'thread-xyz',
      input: [{ type: 'text', text: 'hello there' }],
    });
  });

  it('emits an error event when initialize fails', async () => {
    const built = makeSpawnCtx();
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();
    const init = JSON.parse(io.lines[0]!);

    const events = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: init.id,
        error: { code: -32000, message: 'bad config' },
      }),
    );
    expect(events).toEqual([{ kind: 'error', message: 'bad config' }]);
    // No follow-up requests should be issued.
    expect(io.lines).toHaveLength(1);
  });

  it('marks thread-not-found resume errors as fatal', async () => {
    const built = makeSpawnCtx({ cliSessionId: 'thread-stale' });
    cleanup = built.cleanup;
    const io = makeIO(built.ctx);
    const driver = new CodexDriver();

    driver.bindIO(io);
    await tick();
    const init = JSON.parse(io.lines[0]!);
    driver.parseLine(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }),
    );

    const resume = JSON.parse(io.lines[2]!);
    expect(resume.method).toBe('thread/resume');
    const events = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: resume.id,
        error: { code: -32602, message: 'thread not found: thread-stale' },
      }),
    );
    expect(events).toEqual([
      {
        kind: 'error',
        message: 'thread not found: thread-stale',
        code: 'thread_not_found',
        fatal: true,
      },
    ]);
  });
});

describe('CodexDriver.parseLine event mapping', () => {
  it('returns kind=unknown for non-JSON lines', () => {
    const events = new CodexDriver().parseLine('not json at all');
    expect(events).toEqual([{ kind: 'unknown', raw: 'not json at all' }]);
  });

  it('ignores empty / whitespace-only lines', () => {
    expect(new CodexDriver().parseLine('   ')).toEqual([]);
  });

  it('emits a zero-width thinking event on turn/started', () => {
    const events = new CodexDriver().parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { turn: { id: 'turn-1' } },
      }),
    );
    expect(events).toEqual([{ kind: 'thinking', text: '' }]);
  });

  it('streams text deltas via item/agentMessage/delta', () => {
    const driver = new CodexDriver();
    const events = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { itemId: 'msg-1', delta: 'Hello' },
      }),
    );
    expect(events).toEqual([{ kind: 'text', text: 'Hello' }]);
  });

  it('does NOT re-emit text on item/completed when the message was streamed', () => {
    const driver = new CodexDriver();
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { itemId: 'msg-1', delta: 'Hello' },
      }),
    );
    const completion = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'msg-1', text: 'Hello' } },
      }),
    );
    expect(completion.find(e => e.kind === 'text')).toBeUndefined();
  });

  it('emits text on item/completed agentMessage when no delta was streamed', () => {
    const events = new CodexDriver().parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'msg-2', text: 'Whole message' } },
      }),
    );
    expect(events).toEqual([{ kind: 'text', text: 'Whole message' }]);
  });

  it('translates mcpToolCall items with the chat-server prefix shorthand', () => {
    const driver = new CodexDriver();
    const started = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          item: {
            type: 'mcpToolCall',
            server: 'chat',
            tool: 'send_message',
            arguments: { text: 'hi' },
          },
        },
      }),
    );
    expect(started).toEqual([
      {
        kind: 'tool_call',
        name: 'mcp_chat_send_message',
        input: { text: 'hi' },
      },
    ]);

    const completed = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            server: 'chat',
            tool: 'send_message',
          },
        },
      }),
    );
    expect(completed).toEqual([
      { kind: 'tool_output', name: 'mcp_chat_send_message' },
    ]);
  });

  it('translates shell command execution items', () => {
    const driver = new CodexDriver();
    const start = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { type: 'commandExecution', command: 'ls -al' } },
      }),
    );
    expect(start).toEqual([
      { kind: 'tool_call', name: 'shell', input: { command: 'ls -al' } },
    ]);
    const end = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'commandExecution', command: 'ls -al' } },
      }),
    );
    expect(end).toEqual([{ kind: 'tool_output', name: 'shell' }]);
  });

  it('emits compaction lifecycle events', () => {
    const driver = new CodexDriver();
    expect(
      driver.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/started',
          params: { item: { type: 'contextCompaction' } },
        }),
      ),
    ).toEqual([{ kind: 'compaction_started' }]);
    expect(
      driver.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { item: { type: 'contextCompaction' } },
        }),
      ),
    ).toEqual([{ kind: 'compaction_finished' }]);
  });

  it('emits turn_end on turn/completed and surfaces failed turns as errors', () => {
    const driver = new CodexDriver();
    // Need a threadId so the sessionId field is populated.
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-q' } },
      }),
    );
    const failed = driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          turn: {
            id: 't-1',
            status: 'failed',
            error: { message: 'rate limited' },
          },
        },
      }),
    );
    expect(failed).toEqual([
      { kind: 'error', message: 'rate limited' },
      { kind: 'turn_end', sessionId: 'thread-q' },
    ]);
  });
});

describe('CodexDriver.encodeStdinMessage', () => {
  it('returns null until threadId is established', () => {
    const driver = new CodexDriver();
    expect(driver.encodeStdinMessage('hi', null)).toBeNull();
  });

  it('encodes turn/start when no turn is active', () => {
    const driver = new CodexDriver();
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-1' } },
      }),
    );
    const line = driver.encodeStdinMessage('hello', null);
    expect(line).not.toBeNull();
    const msg = JSON.parse(line!);
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello' }],
      },
    });
  });

  it('encodes turn/steer when a turn is active', () => {
    const driver = new CodexDriver();
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'thread-1' } },
      }),
    );
    driver.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { turn: { id: 'turn-9' } },
      }),
    );
    const line = driver.encodeStdinMessage('please pivot', null);
    const msg = JSON.parse(line!);
    expect(msg).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-9',
        input: [{ type: 'text', text: 'please pivot' }],
      },
    });
  });
});

/** Walk an argv list collecting every `-c key=value` pair into a map. */
function collectCArgs(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) {
      const next = args[i + 1]!;
      const eq = next.indexOf('=');
      if (eq > 0) out.set(next.slice(0, eq), next.slice(eq + 1));
      i++;
    }
  }
  return out;
}
