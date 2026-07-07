import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SILVERHAND_OPENCODE_AGENT } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';

import type { DriverIO, DriverSpawnContext } from '../../src/drivers/index.js';
import { OpenCodeDriver } from '../../src/drivers/opencode.js';

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
  const tmp = mkdtempSync(join(tmpdir(), 'opencode-driver-test-'));
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
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

async function tick(): Promise<void> {
  await new Promise(r => queueMicrotask(() => r(undefined)));
}

function parseLast(io: CapturedIO): any {
  return JSON.parse(io.lines.at(-1)!);
}

describe('OpenCodeDriver static config', () => {
  it('exposes the expected runtime metadata', () => {
    const d = new OpenCodeDriver();
    expect(d.kind).toBe('opencode');
    expect(d.binary).toBe('opencode');
    expect(d.busyDeliveryMode).toBe('gated');
    expect(d.oneShot).toBe(false);
    expect(d.supportsNativeStandingPrompt).toBe(true);
  });

  it('builds opencode acp args with cwd', () => {
    const { ctx, cleanup } = makeSpawnCtx();
    try {
      expect(new OpenCodeDriver().buildArgs(ctx)).toEqual([
        'acp',
        '--cwd',
        ctx.workspacePath,
      ]);
    } finally {
      cleanup();
    }
  });

  it('applyEnv adds NO_COLOR without mutating the input', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const out = new OpenCodeDriver().applyEnv(base);
    expect(out.NO_COLOR).toBe('1');
    expect(out.PATH).toBe('/usr/bin');
    expect(base.NO_COLOR).toBeUndefined();
  });
});

describe('OpenCodeDriver ACP handshake', () => {
  it('classifies ACP frames as protocol-ready only; parseLine owns session_init', () => {
    const d = new OpenCodeDriver();
    expect(
      d.classifyInitProgress(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { sessionId: 'ses_1' },
        }),
      ),
    ).toBe('protocol_ready');
    expect(d.classifyInitProgress('not json')).toBeNull();
  });

  it('initializes, creates a session, then accepts turn-boundary prompts', async () => {
    const { ctx, cleanup } = makeSpawnCtx();
    try {
      const d = new OpenCodeDriver();
      const io = makeIO(ctx);
      d.bindIO(io);
      await tick();

      expect(io.lines).toHaveLength(1);
      expect(parseLast(io)).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'silverhand' },
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
            terminal: false,
          },
        },
      });
      expect(d.readyToEncode()).toBe(false);

      expect(
        d.parseLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })),
      ).toEqual([]);
      expect(parseLast(io)).toMatchObject({
        id: 2,
        method: 'session/new',
        params: { cwd: ctx.workspacePath, mcpServers: [] },
      });

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { sessionId: 'ses_1' },
          }),
        ),
      ).toEqual([]);
      expect(parseLast(io)).toMatchObject({
        id: 3,
        method: 'session/set_config_option',
        params: {
          sessionId: 'ses_1',
          configId: 'mode',
          value: SILVERHAND_OPENCODE_AGENT,
        },
      });
      expect(d.readyToEncode()).toBe(false);

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { configOptions: [] },
          }),
        ),
      ).toEqual([{ kind: 'session_init', sessionId: 'ses_1' }]);
      expect(d.readyToEncode()).toBe(true);

      const encoded = d.encodeStdinMessage('hello', null);
      expect(JSON.parse(encoded!)).toMatchObject({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: {
          sessionId: 'ses_1',
          prompt: [{ type: 'text', text: 'hello' }],
        },
      });
      expect(d.readyToEncode()).toBe(false);

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            result: { stopReason: 'end_turn' },
          }),
        ),
      ).toEqual([{ kind: 'turn_end', sessionId: 'ses_1' }]);
      expect(d.readyToEncode()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('resumes existing sessions and waits for mode and model config before session_init', async () => {
    const { ctx, cleanup } = makeSpawnCtx({
      cliSessionId: 'ses_existing',
      model: 'opencode/deepseek-v4-flash-free',
    });
    try {
      const d = new OpenCodeDriver();
      const io = makeIO(ctx);
      d.bindIO(io);
      await tick();

      d.parseLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      expect(parseLast(io)).toMatchObject({
        id: 2,
        method: 'session/resume',
        params: {
          cwd: ctx.workspacePath,
          mcpServers: [],
          sessionId: 'ses_existing',
        },
      });

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            // OpenCode 1.17.14 returns only configOptions on session/resume.
            // The requested cliSessionId remains the authoritative session id.
            result: { configOptions: [] },
          }),
        ),
      ).toEqual([]);
      expect(parseLast(io)).toMatchObject({
        id: 3,
        method: 'session/set_config_option',
        params: {
          sessionId: 'ses_existing',
          configId: 'mode',
          value: SILVERHAND_OPENCODE_AGENT,
        },
      });
      expect(d.readyToEncode()).toBe(false);

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { configOptions: [] },
          }),
        ),
      ).toEqual([]);
      expect(parseLast(io)).toMatchObject({
        id: 4,
        method: 'session/set_config_option',
        params: {
          sessionId: 'ses_existing',
          configId: 'model',
          value: 'opencode/deepseek-v4-flash-free',
        },
      });
      expect(d.readyToEncode()).toBe(false);

      expect(
        d.parseLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            result: { configOptions: [] },
          }),
        ),
      ).toEqual([{ kind: 'session_init', sessionId: 'ses_existing' }]);
      expect(d.readyToEncode()).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('OpenCodeDriver ACP event mapping', () => {
  it('maps message chunks and tool calls from session/update', () => {
    const d = new OpenCodeDriver();
    expect(
      d.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          },
        }),
      ),
    ).toEqual([{ kind: 'text', text: 'hello' }]);

    expect(
      d.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'thinking' },
            },
          },
        }),
      ),
    ).toEqual([{ kind: 'thinking', text: 'thinking' }]);

    expect(
      d.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool_1',
              title: 'Bash',
              rawInput: { command: 'pnpm test' },
              status: 'pending',
            },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        name: 'Bash',
        input: { command: 'pnpm test' },
        toolCallId: 'tool_1',
      },
    ]);

    expect(
      d.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool_1',
              status: 'completed',
            },
          },
        }),
      ),
    ).toEqual([{ kind: 'tool_output', toolCallId: 'tool_1' }]);
  });

  it('auto-approves permission requests to match full-access runtime posture', async () => {
    const { ctx, cleanup } = makeSpawnCtx();
    try {
      const d = new OpenCodeDriver();
      const io = makeIO(ctx);
      d.bindIO(io);
      await tick();

      d.parseLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'session/request_permission',
          params: {
            sessionId: 'ses_1',
            toolCall: { toolCallId: 'tool_1', title: 'Bash' },
            options: [
              { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
            ],
          },
        }),
      );
      await tick();

      expect(parseLast(io)).toEqual({
        jsonrpc: '2.0',
        id: 9,
        result: {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      });
    } finally {
      cleanup();
    }
  });
});
