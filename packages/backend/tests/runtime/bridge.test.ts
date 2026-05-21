/**
 * Unit tests for `RuntimeBridge` — the command-side seam to
 * silverhand-daemon. The fixture stubs `HostClient` with an in-memory
 * recorder so we can assert exactly what intent + params the bridge
 * shipped, without spinning up a real daemon socket.
 *
 * The behaviors we lock in here:
 *
 * 1. Proxy env semantics (Cindy `KzTBo4xxUmcx77yR` + `QDF5xr23ehj1RhzY`):
 *    - codex in allowlist → proxy keys land on `options.env`
 *    - claude NOT in allowlist → no proxy keys leak
 *    - empty allowlist → no proxy keys at all
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

function settings(map: Record<string, string | null>) {
  return {
    get(key: 'proxy_url' | 'proxy_runtimes') {
      return map[key] ?? null;
    },
  };
}

const PROXY_URL = 'http://127.0.0.1:7897';

describe('RuntimeBridge.runtimeStart — proxy env layering', () => {
  it('injects proxy env when runtime is codex AND codex is in allowlist', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: PROXY_URL, proxy_runtimes: 'codex' }),
    );
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'codex',
      baseEnv: { PATH: '/usr/bin', SILVERHAND_AGENT_ID: 'a1' },
      options: { runtime: 'codex' },
    });
    expect(calls).toHaveLength(1);
    const params = calls[0]!.params as RuntimeStartParams;
    const env = params.options.env as Record<string, string>;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SILVERHAND_AGENT_ID).toBe('a1');
    expect(env.HTTP_PROXY).toBe(PROXY_URL);
    expect(env.https_proxy).toBe(PROXY_URL);
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:7897');
  });

  it('does NOT inject proxy env when runtime is claude AND allowlist=codex', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: PROXY_URL, proxy_runtimes: 'codex' }),
    );
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'claude',
      baseEnv: { PATH: '/usr/bin' },
      options: { runtime: 'claude' },
    });
    const env = (calls[0]!.params as RuntimeStartParams).options.env as Record<
      string,
      string
    >;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
  });

  it('does NOT inject proxy env when allowlist is empty (Settings unset)', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: PROXY_URL, proxy_runtimes: '' }),
    );
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'codex',
      baseEnv: { PATH: '/usr/bin' },
      options: { runtime: 'codex' },
    });
    const env = (calls[0]!.params as RuntimeStartParams).options.env as Record<
      string,
      string
    >;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it('forwards startup_delivery verbatim when caller provides it', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'claude',
      baseEnv: {},
      options: { runtime: 'claude' },
      startupDelivery: {
        delivery_ids: [101, 102],
        payload: { type: 'user', content: 'hello' },
      },
    });
    const params = calls[0]!.params as RuntimeStartParams;
    expect(params.startup_delivery?.delivery_ids).toEqual([101, 102]);
    expect(params.startup_delivery?.payload).toEqual({
      type: 'user',
      content: 'hello',
    });
  });

  it('overwrites caller-supplied options.env (proxy layering is authoritative)', async () => {
    // Caller passes a stale HTTP_PROXY in options.env by mistake.
    // Bridge must NOT trust it — it should be replaced by the
    // freshly-computed env from baseEnv + applyProxyEnv.
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: PROXY_URL, proxy_runtimes: 'codex' }),
    );
    await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'codex',
      baseEnv: { PATH: '/usr/bin' },
      options: {
        runtime: 'codex',
        env: { HTTP_PROXY: 'http://stale-proxy:1' },
      },
    });
    const env = (calls[0]!.params as RuntimeStartParams).options.env as Record<
      string,
      string
    >;
    expect(env.HTTP_PROXY).toBe(PROXY_URL);
    // The caller-supplied stale env entirely disappears: bridge
    // rebuilds from baseEnv.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('passes through business-state init_cooldown result without throwing', async () => {
    const { client, calls, setNext } = makeFakeClient();
    setNext('runtime_start', {
      started: false,
      reason: 'init_cooldown',
      cooldown_until: 1700001000000,
    } satisfies RuntimeStartResult);
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    const result = await bridge.runtimeStart({
      conversationId: 'c1',
      agentId: 'a1',
      runtime: 'claude',
      baseEnv: {},
      options: { runtime: 'claude' },
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
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.clearRuntimeSession('c1', 'a1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      intent: 'runtime_clear_session',
      params: { conversation_id: 'c1', agent_id: 'a1' },
    });
  });

  it('method is named clearRuntimeSession, NOT clearSession (compile-time guard)', () => {
    const { client } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
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
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeWake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: { type: 'user', content: 'wake up' },
    });
    expect(calls[0]!.intent).toBe('runtime_wake');
    const p = calls[0]!.params as RuntimeWakeParams;
    expect(p.delivery_ids).toEqual([42]);
    expect(p.kind).toBe('message');
  });

  it('runtimeStop forwards mode+directive untouched', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeStop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: { type: 'user', content: '[stop]' },
    });
    const p = calls[0]!.params as RuntimeStopParams;
    expect(p.mode).toBe('soft');
    expect(p.soft_directive).toEqual({ type: 'user', content: '[stop]' });
  });

  it('runtimeStatus omits empty params (matches HostClient default arg)', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeStatus();
    expect(calls[0]!.params).toEqual({});
  });

  it('runtimeStatus narrows by conversationId+agentId when supplied', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeStatus({ conversationId: 'c1', agentId: 'a1' });
    expect(calls[0]!.params).toEqual({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
  });

  it('runtimeStopAll + runtimeCloseActivityLog are no-arg passthroughs', async () => {
    const { client, calls } = makeFakeClient();
    const bridge = new RuntimeBridge(
      client,
      settings({ proxy_url: null, proxy_runtimes: null }),
    );
    await bridge.runtimeStopAll();
    await bridge.runtimeCloseActivityLog();
    expect(calls.map(c => c.intent)).toEqual([
      'runtime_stop_all',
      'runtime_close_activity_log',
    ]);
  });
});
