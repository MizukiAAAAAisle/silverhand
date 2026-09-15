import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spawnDaemonChild } from '../src/spawn.js';
import { HostClient } from '../src/client/index.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

it('Desktop-owned daemon SIGTERM drains both scopes, including SIGTERM-resistant children', async () => {
  const base = resolve(import.meta.dirname, '../../../.cache');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'quit-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const handle = await spawnDaemonChild({
    launcher: {
      command: process.execPath,
      args: ['--import', 'tsx', resolve(import.meta.dirname, '_fixtures/shutdown-daemon.ts')],
      env: { SILVERHAND_DIR: root },
    },
    socketPath: join(root, 'd.sock'),
    pidFilePath: join(root, 'd.pid'),
    logDir: join(root, 'logs'),
    maxRestarts: 0,
    readyTimeoutMs: 10_000,
  });
  cleanup.push(() => handle.kill());
  const client = new HostClient({ socketPath: handle.socketPath });
  cleanup.push(() => client.close());
  await client.connect();
  const ready = new Set<string>();
  client.subscribe((event) => {
    if (event.event === 'runtime_output' && JSON.stringify(event).includes('READY')) {
      ready.add(event.agent_id);
    }
  });
  const pids: number[] = [];
  cleanup.push(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
  });
  for (const [agentId, scope] of [
    ['agent-one', 'agent'],
    ['agent-two', 'conversation'],
  ] as const) {
    const options =
      scope === 'agent'
        ? testStartOptions({ agentId, sessionScope: 'agent' })
        : testStartOptions({ agentId, conversationId: 'conversation-two' });
    const result = await client.runtimeStart({
      agent_id: agentId,
      conversation_id: 'conversation-two',
      runtime_generation: 1,
      options,
    });
    expect(result.started).toBe(true);
    if (result.started) pids.push(result.pid);
  }
  await expect.poll(() => ready.size).toBe(2);
  await client.close();
  await handle.kill();
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  expect(existsSync(join(root, 'd.pid'))).toBe(false);
}, 25_000);
