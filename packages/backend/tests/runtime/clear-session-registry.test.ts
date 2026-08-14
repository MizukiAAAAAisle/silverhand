import { describe, expect, it } from 'vitest';
import { ClearSessionWaiterRegistry } from '../../src/runtime/clear-session-registry.js';

describe('ClearSessionWaiterRegistry exact custody', () => {
  it('ignores successor generation and wrong daemon before accepting the exact exit', async () => {
    const registry = new ClearSessionWaiterRegistry(1_000);
    const scope = { kind: 'agent' as const, agentId: 'agent-1' };
    const operation = {
      scope,
      generation: 7,
      daemonInstanceId: 'daemon-a',
    };
    registry.begin(operation);

    let settled = false;
    const waiting = registry.awaitExit(operation).then(() => {
      settled = true;
    });
    registry.notifyExit(scope, {
      generation: 8,
      daemonInstanceId: 'daemon-a',
    });
    registry.notifyExit(scope, {
      generation: 7,
      daemonInstanceId: 'daemon-b',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.notifyExit(scope, {
      generation: 7,
      daemonInstanceId: 'daemon-a',
    });
    await waiting;
    expect(settled).toBe(true);
    registry.end(operation);
    expect(registry.inProgress(scope)).toBe(false);
  });
});
