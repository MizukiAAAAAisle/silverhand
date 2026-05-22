/**
 * Spawn-env parity tests — pin the byte-equivalence between the
 * **original CM spawn-env oracle** (`buildAgentSpawnEnv`, lifted out of
 * the now-removed `conversation-manager.ts` and preserved as the single
 * source of truth) and the daemon-path env composition the
 * `RuntimeBridge` caller builds via `buildBridgeBaseEnv` + bridge's
 * proxy layer + daemon-side `driver.applyEnv` re-application.
 *
 * Naming note: post-cleanup there is no longer a "legacy" runtime path
 * to compare against — the in-process ConversationManager runtime was
 * removed in #task:512 cleanup Commit B and the
 * `SILVERHAND_RUNTIME_HOST` env switch in Commit C. We keep these
 * tests because the oracle (`buildAgentSpawnEnv`) is still the
 * authoritative spec for what bytes a spawned CLI should see, and the
 * daemon-side reconstruction (bridge wireEnv merged with daemon
 * `process.env`, then `driver.applyEnv`) is what actually ships those
 * bytes. If the two diverge, the spawned CLI silently sees something
 * different from the spec — which is the worst possible silent
 * regression and exactly what the original Commit-5 hard line (Cindy
 * `gePj5qOffE7rDlGw` + earlier `KMJFmcS4hf_tJ5hj`) protects against.
 *
 * Test strategy:
 *
 *   1. Build a fixed `SpawnEnvInput` (driver, runtime, cwd, settings).
 *   2. Compute `oracleEnv = buildAgentSpawnEnv(input)` — the spec.
 *   3. Compute `wireEnv` the bridge would ship:
 *      `bridgeWireEnv = applyProxyEnv(buildBridgeBaseEnv(input), runtime, settings)`.
 *   4. Simulate daemon-side spawn:
 *      `daemonComputedEnv = driver.applyEnv({ ...daemonProcessEnv, ...bridgeWireEnv })`.
 *   5. Assert `daemonComputedEnv` deep-equals `oracleEnv` (with the
 *      single-host invariant `daemonProcessEnv === baseProcessEnv`).
 *
 * The daemon's spawn step does exactly
 * `driver.applyEnv({ ...process.env, ...(wire.env ?? {}) })`
 * (`real-supervisor/index.ts:396`); we mirror that here.
 */
import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import type { Driver } from '../../src/drivers/index.js';
import type { ProxySettingsSource } from '../../src/runtime/bridge.js';
import {
  applyProxyEnv,
  parseProxyRuntimes,
} from '../../src/runtime/proxy-env.js';
import {
  buildAgentSpawnEnv,
  buildBridgeBaseEnv,
} from '../../src/runtime/spawn-env.js';

// Minimal Driver fakes — only `applyEnv` matters for parity.
function makeDriver(applyEnv: Driver['applyEnv']): Driver {
  return {
    kind: 'claude',
    binary: 'claude',
    applyEnv,
    buildArgs: () => [],
    parseLine: () => [],
    encodeStdinMessage: () => '',
    encodeInterruptControl: () => '',
    oneShot: false,
    kickoffMode: 'self_init',
    busyDeliveryMode: 'defer',
  } as unknown as Driver;
}

function settings(map: Record<string, string | null>): ProxySettingsSource {
  return {
    get(key) {
      return map[key] ?? null;
    },
  };
}

/**
 * Simulate the daemon's spawn-side env composition (one line in
 * `real-supervisor/index.ts:396`):
 *
 *   const env = driver.applyEnv({ ...process.env, ...(wire.env ?? {}) });
 *
 * Returns what the child would actually receive in its environment.
 */
function simulateDaemonSpawnEnv(
  daemonProcessEnv: NodeJS.ProcessEnv,
  driver: Driver,
  wireEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return driver.applyEnv({ ...daemonProcessEnv, ...wireEnv });
}

const BASE_PROCESS_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/test',
  LANG: 'en_US.UTF-8',
};

const FIXED_INPUT = {
  runtime: 'codex',
  conversationId: 'conv-abc',
  agentId: 'agent-xyz',
  serverUrl: 'http://127.0.0.1:8765',
  token: 'tok_test_123',
  binDir: '/tmp/silverhand-spawn/conv-abc/agent-xyz/spawn-1/bin',
};

describe('Spawn env parity — driver.applyEnv is identity (claude-style)', () => {
  // claude's real `applyEnv` sets a couple of constants; for the
  // parity test we use an identity driver to isolate the env-build
  // logic from driver-specific behaviour.
  const driver = makeDriver(env => ({ ...env }));

  it('CM oracle env equals daemon-spawn env when proxy is OFF', () => {
    const proxy = settings({ proxy_url: null, proxy_runtimes: null });
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    const wireBase = buildBridgeBaseEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
    });
    const wireEnv = applyProxyEnv(wireBase, FIXED_INPUT.runtime, {
      proxyUrl: proxy.get('proxy_url'),
      allowlist: parseProxyRuntimes(proxy.get('proxy_runtimes')),
    });
    // Daemon spawn-side: ...daemonProcessEnv, ...wireEnv, then
    // driver.applyEnv. Single-host invariant: daemonProcessEnv ===
    // BASE_PROCESS_ENV.
    const daemon = simulateDaemonSpawnEnv(BASE_PROCESS_ENV, driver, wireEnv);
    expect(daemon).toEqual(oracle);
  });

  it('CM oracle env equals daemon-spawn env when proxy is ON for the runtime', () => {
    const proxy = settings({
      proxy_url: 'http://127.0.0.1:7897',
      proxy_runtimes: 'codex',
    });
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    const wireBase = buildBridgeBaseEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
    });
    const wireEnv = applyProxyEnv(wireBase, FIXED_INPUT.runtime, {
      proxyUrl: proxy.get('proxy_url'),
      allowlist: parseProxyRuntimes(proxy.get('proxy_runtimes')),
    });
    const daemon = simulateDaemonSpawnEnv(BASE_PROCESS_ENV, driver, wireEnv);
    expect(daemon).toEqual(oracle);
    // Sanity: proxy keys are actually present on both sides.
    expect(oracle.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(daemon.HTTP_PROXY).toBe('http://127.0.0.1:7897');
  });

  it('CM oracle env equals daemon-spawn env when proxy is ON but runtime not allowlisted', () => {
    const proxy = settings({
      proxy_url: 'http://127.0.0.1:7897',
      proxy_runtimes: 'codex', // claude is NOT in allowlist
    });
    const claudeInput = { ...FIXED_INPUT, runtime: 'claude' };
    const oracle = buildAgentSpawnEnv({
      ...claudeInput,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    const wireBase = buildBridgeBaseEnv({
      ...claudeInput,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
    });
    const wireEnv = applyProxyEnv(wireBase, claudeInput.runtime, {
      proxyUrl: proxy.get('proxy_url'),
      allowlist: parseProxyRuntimes(proxy.get('proxy_runtimes')),
    });
    const daemon = simulateDaemonSpawnEnv(BASE_PROCESS_ENV, driver, wireEnv);
    expect(daemon).toEqual(oracle);
    expect(oracle.HTTP_PROXY).toBeUndefined();
    expect(daemon.HTTP_PROXY).toBeUndefined();
  });

  it('PATH order is preserved — bin shim comes first, then existing PATH', () => {
    const proxy = settings({ proxy_url: null, proxy_runtimes: null });
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    expect(oracle.PATH).toBe(
      `${FIXED_INPUT.binDir}${delimiter}/usr/local/bin:/usr/bin:/bin`,
    );
  });

  it('SILVERHAND_* env vars are all populated', () => {
    const proxy = settings({ proxy_url: null, proxy_runtimes: null });
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    expect(oracle[SILVERHAND_CONVERSATION_ID_ENV]).toBe(
      FIXED_INPUT.conversationId,
    );
    expect(oracle[SILVERHAND_AGENT_ID_ENV]).toBe(FIXED_INPUT.agentId);
    expect(oracle[SILVERHAND_SERVER_URL_ENV]).toBe(FIXED_INPUT.serverUrl);
    expect(oracle[SILVERHAND_AUTH_TOKEN_ENV]).toBe(FIXED_INPUT.token);
  });
});

describe('Spawn env parity — driver.applyEnv adds NO_COLOR (codex-style)', () => {
  // codex's `applyEnv` (host/src/drivers/codex.ts:97) injects
  // NO_COLOR=1. Make sure parity holds when driver does mutate.
  const driver = makeDriver(env => ({ ...env, NO_COLOR: '1' }));

  it('NO_COLOR lands on both sides', () => {
    const proxy = settings({
      proxy_url: 'http://127.0.0.1:7897',
      proxy_runtimes: 'codex',
    });
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
      proxySettings: proxy,
    });
    const wireBase = buildBridgeBaseEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: BASE_PROCESS_ENV,
    });
    const wireEnv = applyProxyEnv(wireBase, FIXED_INPUT.runtime, {
      proxyUrl: proxy.get('proxy_url'),
      allowlist: parseProxyRuntimes(proxy.get('proxy_runtimes')),
    });
    const daemon = simulateDaemonSpawnEnv(BASE_PROCESS_ENV, driver, wireEnv);
    expect(oracle.NO_COLOR).toBe('1');
    expect(daemon.NO_COLOR).toBe('1');
    expect(daemon).toEqual(oracle);
  });
});

describe('Spawn env parity — driver.applyEnv deletes a key (delete-style)', () => {
  // Cindy `Ds1gzWSacsYUN-37`: the cursor driver actually sets
  // `FORCE_COLOR='0'` + `NO_COLOR='1'`, it does NOT delete. The
  // delete-style transform is still worth covering on its own —
  // any future driver that strips an inherited env key must stay
  // byte-equivalent across the oracle and the daemon-computed
  // reconstruction — so we keep the case but drop the misleading
  // driver-name attribution.
  const driver = makeDriver(env => {
    const out = { ...env };
    delete out.FORCE_COLOR;
    return out;
  });

  it('FORCE_COLOR present in base env is stripped on both sides', () => {
    const proxy = settings({ proxy_url: null, proxy_runtimes: null });
    const baseEnv = { ...BASE_PROCESS_ENV, FORCE_COLOR: '1' };
    const oracle = buildAgentSpawnEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: baseEnv,
      proxySettings: proxy,
    });
    const wireBase = buildBridgeBaseEnv({
      ...FIXED_INPUT,
      driver,
      baseProcessEnv: baseEnv,
    });
    const wireEnv = applyProxyEnv(wireBase, FIXED_INPUT.runtime, {
      proxyUrl: proxy.get('proxy_url'),
      allowlist: parseProxyRuntimes(proxy.get('proxy_runtimes')),
    });
    const daemon = simulateDaemonSpawnEnv(baseEnv, driver, wireEnv);
    expect(oracle.FORCE_COLOR).toBeUndefined();
    expect(daemon.FORCE_COLOR).toBeUndefined();
    expect(daemon).toEqual(oracle);
  });
});
