/**
 * Unit tests for `RuntimeBridge` — the command-side seam to
 * silverhand-daemon. The fixture stubs `HostClient` with an in-memory
 * recorder so we can assert exactly what intent + params the bridge
 * shipped, without spinning up a real daemon socket.
 *
 * The behaviors we lock in here:
 *
 * 1. `runtimeStart` is a thin typed proxy. It must not add backend
 *    cwd/system-prompt/env derivatives to `options`.
 *
 * 2. `clearRuntimeSession` naming (Cindy `KMJFmcS4hf_tJ5hj` boundary 4):
 *    bridge method is called `clearRuntimeSession` (NOT `clearSession`)
 *    and forwards to daemon intent `runtime_clear_session`.
 *
 * 3. Bridge holds no state — every call delegates to a fresh
 *    `HostClient.runtime*` invocation.
 */
import { describe, expect, it } from 'vitest';
import type {
  HostClient,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStopParams,
  RuntimeStopResult,
  RuntimeWakeParams,
  RuntimeWakeResult,
  RuntimeStatusResult,
  RuntimeClearSessionResult,
  RuntimeStopAllResult,
  RuntimeCloseActivityLogResult,
} from '@silverhand/host';
import { RuntimeBridge } from '../../src/runtime/bridge.js';

interface RecordedCall {
  intent: string;
  params: unknown;
}

/**
 * Hand-rolled fake — we only need the runtime* methods the bridge
 * actually calls. Cast to `HostClient` at construction; missing
 * fields aren't relevant to these tests.
 */
function makeFakeClient(): {
  client: HostClient;
  calls: RecordedCall[];
  setNext: (intent: string, value: unknown) => void;
} {
  const calls: RecordedCall[] = [];
  const responses = new Map<string, unknown>();
  const setNext = (intent: string, value: unknown) => {
    responses.set(intent, value);
  };
  const record = <T,>(intent: string, params: unknown, fallback: T): Promise<T> => {
    calls.push({ intent, params });
    return Promise.resolve((responses.get(intent) as T) ?? fallback);
  };
  const fake = {
    runtimeStart: (p: RuntimeStartParams) =>
      record<RuntimeStartResult>('runtime_start', p, {
        started: true,
        pid: 1234,
        started_at: 1700000000000,
      }),
    runtimeStop: (p: RuntimeStopParams) =>
      record<RuntimeStopResult>('runtime_stop', p, {
        mode: 'hard',
        stopped: true,
        exit_code: 0,
      }),
    runtimeWake: (p: RuntimeWakeParams) =>
      record<RuntimeWakeResult>('runtime_wake', p, {
        delivered: true,
        delivery_ids: [...p.delivery_ids],
      }),
    runtimeStatus: (p: unknown) =>
      record<RuntimeStatusResult>('runtime_status', p, { runtimes: [] }),
    runtimeClearSession: (p: unknown) =>
      record<RuntimeClearSessionResult>('runtime_clear_session', p, {
        cleared: true,
      }),
    runtimeStopAll: () =>
      record<RuntimeStopAllResult>('runtime_stop_all', {}, { stopped_count: 0 }),
    runtimeCloseActivityLog: () =>
      record<RuntimeCloseActivityLogResult>(
        'runtime_close_activity_log',
        {},
        { flushed: true },
      ),
  } as unknown as HostClient;
  return { client: fake, calls, setNext };
}

function startOptions(): RuntimeStartParams['options'] {
  return {
    agent: {
      id: 'a1',
      name: 'Cindy',
      home_dir: '/Users/shiki/.silverhand/agents/a1',
    },
    workspace: {
      id: 'ws1',
      name: 'silverhand',
      kind: 'regular',
      path: '/Users/shiki/workspace/silverhand',
    },
    workspace_memory_index: [
      {
        id: 'ws1',
        name: 'silverhand',
        kind: 'regular',
        path: '/Users/shiki/workspace/silverhand',
      },
    ],
    session: {
      conversation_id: 'c1',
      kind: 'channel',
      title: 'runtime-start',
      parent_conversation_id: null,
      parent_title: null,
      spawned_by_agent_id: null,
      members: [
        {
          kind: 'agent',
          agent_id: 'a1',
          name: 'Cindy',
          display_name: 'Cindy',
          runtime: 'codex',
        },
      ],
    },
    driver: {
      kind: 'codex',
      cli_session_id: null,
      model: 'gpt-5',
      reasoning_effort: null,
      fast_mode: null,
    },
    env_policy: {
      silverhand: {
        server_url: 'http://127.0.0.1:1984',
        auth_token: 'agent-token',
      },
      silverhand_cli: {
        command: 'silverhand',
        args: [],
      },
      proxy: {
        url: 'http://127.0.0.1:7897',
        allowlist: ['codex'],
      },
    },
  };
}

describe('RuntimeBridge.runtimeStart — typed passthrough', () => {
  it('forwards typed options without adding cwd/system_prompt_path/env', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    const options = startOptions();
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      options,
    });
    expect(calls).toHaveLength(1);
    const params = calls[0]!.params as RuntimeStartParams;
    expect(params).toEqual({
      conversation_id: 'c1',
      agent_id: 'a1',
      options,
    });
    expect(JSON.stringify(params)).not.toContain('"cwd"');
    expect(JSON.stringify(params)).not.toContain('"system_prompt_path"');
    expect(JSON.stringify(params)).not.toContain('"spawn_dir"');
    expect(JSON.stringify(params)).not.toContain('"env"');
  });

  it('forwards startup_delivery verbatim when caller provides it', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      options: startOptions(),
      startupDelivery: {
        delivery_ids: [101, 102],
        text: 'hello',
      },
    });
    const params = calls[0]!.params as RuntimeStartParams;
    expect(params.startup_delivery?.delivery_ids).toEqual([101, 102]);
    expect(params.startup_delivery?.text).toEqual('hello');
  });

  it('passes through business-state init_cooldown result without throwing', async () => {
    const { client, calls, setNext } = makeFakeClient();
    setNext('runtime_start', {
      started: false,
      reason: 'init_cooldown',
      cooldown_until: 1700001000000,
    } satisfies RuntimeStartResult);
    const bridge = new RuntimeBridge(client);
    const result = await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      options: startOptions(),
    });
    expect(result).toEqual({
      started: false,
      reason: 'init_cooldown',
      cooldown_until: 1700001000000,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('RuntimeBridge.clearRuntimeSession — naming + intent routing', () => {
  it('forwards to daemon intent runtime_clear_session', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.clearRuntimeSession('c1', 'a1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      intent: 'runtime_clear_session',
      params: { conversation_id: 'c1', agent_id: 'a1' },
    });
  });

  it('method is named clearRuntimeSession, NOT clearSession (compile-time guard)', () => {
    const { client } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    // Surface check: the public method exists with the prefixed
    // name. If someone renames it back to `clearSession` this fails
    // at runtime and the failure name is unambiguous.
    expect(typeof bridge.clearRuntimeSession).toBe('function');
    expect((bridge as unknown as { clearSession?: unknown }).clearSession).toBeUndefined();
  });
});

describe('RuntimeBridge — other passthrough intents', () => {
  it('runtimeWake forwards params untouched', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeWake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'wake up',
    });
    expect(calls[0]!.intent).toBe('runtime_wake');
    const p = calls[0]!.params as RuntimeWakeParams;
    expect(p.delivery_ids).toEqual([42]);
    expect(p.kind).toBe('message');
  });

  it('runtimeStop forwards mode+directive untouched', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeStop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: '[stop]',
    });
    const p = calls[0]!.params as RuntimeStopParams;
    expect(p.mode).toBe('soft');
    expect(p.soft_directive).toEqual('[stop]');
  });

  it('runtimeStatus omits empty params (matches HostClient default arg)', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeStatus();
    expect(calls[0]!.params).toEqual({});
  });

  it('runtimeStatus narrows by conversationId+agentId when supplied', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeStatus({ conversationId: 'c1', agentId: 'a1' });
    expect(calls[0]!.params).toEqual({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
  });

  it('runtimeStopAll + runtimeCloseActivityLog are no-arg passthroughs', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(client);
    await bridge.runtimeStopAll();
    await bridge.runtimeCloseActivityLog();
    expect(calls.map(c => c.intent)).toEqual([
      'runtime_stop_all',
      'runtime_close_activity_log',
    ]);
  });
});
