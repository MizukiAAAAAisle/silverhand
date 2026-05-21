/**
 * Sub-commit 2a behavior tests for `DaemonAgentRuntimeHost`.
 *
 * **2a is scaffolding only — daemon mode is NOT a usable runtime path
 * yet.** These tests pin the scaffolding contract Cindy
 * `0G5uJBydO_4qt_2r` required:
 *
 *   - every lifecycle / delivery / run-state method throws when called
 *   - the throw message names the env var, names the offending method,
 *     and contains the literal rollback recipe
 *     `SILVERHAND_RUNTIME_HOST=legacy`
 *   - the message does NOT pretend the operation succeeded (no silent
 *     no-op, no `markDelivered` time shift), and explicitly tells the
 *     operator that legacy is the canonical supported path
 *
 * 2b will replace each method body with the real bridge delegation;
 * these tests will then be replaced by parity tests against the
 * `deliverMessage` / `start` / `stop` sub-plan.
 */
import { describe, expect, it } from 'vitest';
import type { HostClient } from '@silverhand/host';
import { DaemonAgentRuntimeHost } from '../../src/runtime/daemon-agent-runtime-host.js';
import { RuntimeBridge } from '../../src/runtime/bridge.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { RuntimeEventHandler } from '../../src/runtime/event-handler.js';

function makeFakeClient(): HostClient {
  // Methods are unreachable in 2a — every test below throws before
  // touching the client. We supply rejecting stubs so any accidental
  // delegation surfaces loudly as an unexpected resolution.
  const reject = () =>
    Promise.reject(
      new Error('2a host client stub should be unreachable'),
    );
  return {
    ping: reject,
    subscribe: () => () => {},
    onReconnect: () => () => {},
    runtimeStart: reject,
    runtimeStop: reject,
    runtimeWake: reject,
    runtimeStatus: reject,
    runtimeClearSession: reject,
    runtimeStopAll: reject,
    runtimeCloseActivityLog: reject,
    runtimeOutputPause: reject,
    runtimeOutputResume: reject,
    close: () => Promise.resolve(),
    connect: () => Promise.resolve(),
  } as unknown as HostClient;
}

function makeHost(): DaemonAgentRuntimeHost {
  const client = makeFakeClient();
  const bridge = new RuntimeBridge(client, { get: () => null });
  const cache = new RunStateCache();
  const eventHandler = new RuntimeEventHandler({
    client,
    bridge,
    cache,
    events: { publish: () => {} },
    inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
  });
  return new DaemonAgentRuntimeHost({ client, bridge, cache, eventHandler });
}

const ROLLBACK_RECIPE = 'SILVERHAND_RUNTIME_HOST=legacy';

function assertScaffoldingError(err: unknown, method: string): void {
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message).toContain('SILVERHAND_RUNTIME_HOST=daemon');
  expect(message).toContain(`${method}()`);
  expect(message).toContain('not yet implemented');
  expect(message).toContain(ROLLBACK_RECIPE);
  // The canonical fallback should be named so the operator knows
  // legacy mode is the supported path, not just a workaround.
  expect(message).toMatch(/ConversationManager/);
}

describe('DaemonAgentRuntimeHost — sub-commit 2a scaffolding', () => {
  it('start() throws with rollback recipe', async () => {
    const host = makeHost();
    let err: unknown;
    await host.start('conv-1', 'agent-1').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'start');
  });

  it('stop() throws with rollback recipe', async () => {
    const host = makeHost();
    let err: unknown;
    await host.stop('conv-1', 'agent-1', 'hard').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'stop');
  });

  it('clearSession() throws with rollback recipe', async () => {
    const host = makeHost();
    let err: unknown;
    await host.clearSession('conv-1', 'agent-1', 'user-1').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'clearSession');
  });

  it('stopAll() throws with rollback recipe', async () => {
    const host = makeHost();
    let err: unknown;
    await host.stopAll().catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'stopAll');
  });

  it('closeActivityLog() throws with rollback recipe', async () => {
    const host = makeHost();
    let err: unknown;
    await host.closeActivityLog().catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'closeActivityLog');
  });

  it('deliverMessage() throws — does NOT silently mark delivered', async () => {
    // Cindy `0G5uJBydO_4qt_2r`: "不能假装 delivered、也不能改变 markDelivered
    // 时点." The throw is the contract: no inbox row state is mutated.
    const host = makeHost();
    let err: unknown;
    await host.deliverMessage('conv-1', 'agent-1', 'msg-1').catch(e => {
      err = e;
    });
    assertScaffoldingError(err, 'deliverMessage');
  });

  it('reconcileOnBoot() throws synchronously', () => {
    const host = makeHost();
    expect(() => host.reconcileOnBoot()).toThrow(
      /reconcileOnBoot\(\) is not yet implemented/,
    );
    expect(() => host.reconcileOnBoot()).toThrow(/SILVERHAND_RUNTIME_HOST=legacy/);
  });

  it('getAgentRunStates() throws synchronously', () => {
    const host = makeHost();
    expect(() => host.getAgentRunStates('conv-1')).toThrow(
      /getAgentRunStates\(\) is not yet implemented/,
    );
  });

  it('resolveRun() throws synchronously', () => {
    const host = makeHost();
    expect(() => host.resolveRun('conv-1', 'agent-1', 'replied')).toThrow(
      /resolveRun\(\) is not yet implemented/,
    );
  });

  it('resolveConversationRuns() throws synchronously', () => {
    const host = makeHost();
    expect(() => host.resolveConversationRuns('conv-1')).toThrow(
      /resolveConversationRuns\(\) is not yet implemented/,
    );
  });

  it('constructor accepts but does not consume the deps (2a)', () => {
    // The deps are wired in 2b; in 2a we only assert the constructor
    // shape compiles and stores them without calling anything.
    const client = makeFakeClient();
    const bridge = new RuntimeBridge(client, { get: () => null });
    const cache = new RunStateCache();
    const eventHandler = new RuntimeEventHandler({
      client,
      bridge,
      cache,
      events: { publish: () => {} },
      inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    });
    expect(
      () =>
        new DaemonAgentRuntimeHost({ client, bridge, cache, eventHandler }),
    ).not.toThrow();
  });
});
