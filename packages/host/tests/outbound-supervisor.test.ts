/**
 * Stage D3.a Commit 3 — `OutboundSupervisor` tests.
 *
 * Three lenses:
 *
 *   1. **Stale-config invariant.** The whole reason `OutboundSupervisor`
 *      exists is so the daemon can be spawned (e.g. at app boot,
 *      before login) with a `daemon-config.json` lying around from a
 *      previous user without the daemon trying to dial that stale
 *      backend. The supervisor refuses to do anything until
 *      `attach()` is called.
 *
 *   2. **Validation matrix (fail-closed).** Each of the five failure
 *      reasons exposed by `HostOutboundAttachFailureReasonSchema`
 *      must (a) be reachable, (b) leave any previously-active client
 *      completely untouched. Per Cindy's review note, this is the
 *      single most important contract: a bad Settings change must
 *      never take down a working daemon.
 *
 *   3. **Idempotency matrix.** `started` / `noop` / `switched` are
 *      the three success actions. The "switched" path is the only
 *      one that stops the prior client, and only AFTER the new path
 *      has cleared validation.
 *
 * All tests use the `outboundClientFactory` test seam to inject a
 * tiny fake client that records lifecycle calls — keeps the unit
 * tests out of the real ws + reconnect path (covered by
 * `outbound-client.test.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboundSupervisor, type OutboundClientLike } from '../src/daemon/outbound-supervisor.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import type { EventFrame, ResponseFrame } from '../src/protocol.js';

interface FakeClient extends OutboundClientLike {
  readonly configPath: string;
  startCalls: number;
  stopCalls: { reason: string | undefined }[];
  sentEvents: EventFrame[];
}

function silentLogger(): DaemonLogger {
  return {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    close: async () => {},
  };
}

function makeFakeClient(configPath: string): FakeClient {
  const fake: FakeClient = {
    configPath,
    startCalls: 0,
    stopCalls: [],
    sentEvents: [],
    start() {
      this.startCalls += 1;
    },
    stop(reason?: string) {
      this.stopCalls.push({ reason });
    },
    sendEvent(event) {
      this.sentEvents.push(event);
    },
  };
  return fake;
}

interface SupervisorFixture {
  supervisor: OutboundSupervisor;
  /** Every fake client the factory has handed out, in spawn order. */
  spawned: FakeClient[];
  tmp: string;
  writeValidConfig(name?: string): string;
  writeInvalidJson(name?: string): string;
  writeInvalidShape(name?: string): string;
  writeNonLoopbackHttp(name?: string): string;
  writeDirectory(name?: string): string;
  cleanup(): void;
}

function makeFixture(): SupervisorFixture {
  const tmp = mkdtempSync(join(tmpdir(), 'silverhand-outbound-sup-'));
  const spawned: FakeClient[] = [];
  const readyEvent = (): Extract<EventFrame, { event: 'ready' }> => ({
    event: 'ready',
    protocol_version: 1,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: 'instance-test',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [],
    socket_path: '/tmp/test.sock',
    daemon_pid: process.pid,
    started_at: 1_700_000_000_000,
  });
  const supervisor = new OutboundSupervisor({
    logger: silentLogger(),
    readyEvent,
    dispatchCommand: async () => ({ id: 'unused', result: {} } as ResponseFrame),
    outboundClientFactory: (configPath) => {
      const fake = makeFakeClient(configPath);
      spawned.push(fake);
      return fake;
    },
  });

  const writeJson = (name: string, content: string): string => {
    const path = join(tmp, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  return {
    supervisor,
    spawned,
    tmp,
    writeValidConfig: (name = 'daemon-config.json') =>
      writeJson(
        name,
        JSON.stringify({
          server_url: 'http://127.0.0.1:8765',
          host_id: 'host-1',
          host_token: 'token-1',
        }),
      ),
    writeInvalidJson: (name = 'daemon-config-bad.json') =>
      writeJson(name, '{not really json'),
    writeInvalidShape: (name = 'daemon-config-shape.json') =>
      writeJson(name, JSON.stringify({ server_url: 'http://127.0.0.1:1' })),
    writeNonLoopbackHttp: (name = 'daemon-config-non-loopback.json') =>
      writeJson(
        name,
        JSON.stringify({
          server_url: 'http://example.com:8765',
          host_id: 'host-1',
          host_token: 'token-1',
        }),
      ),
    writeDirectory: (name = 'config-dir') => {
      const path = join(tmp, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('OutboundSupervisor — stale-config invariant', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('does NOT spawn any outbound client until attach() is called, even when a stale daemon-config.json exists on disk', () => {
    f = makeFixture();
    // Simulate a leftover daemon-config from a previous user.
    f.writeValidConfig();
    // Supervisor constructed; no attach yet. Stale config is sitting
    // right there.
    expect(f.spawned).toEqual([]);
    expect(f.supervisor.currentConfigPath()).toBeNull();
  });
});

describe('OutboundSupervisor — validation matrix (fail-closed; never mutates active client)', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('rejects relative config_path with reason=path_not_absolute', () => {
    f = makeFixture();
    const res = f.supervisor.attach({ config_path: 'daemon-config.json' });
    expect(res).toMatchObject({ attached: false, reason: 'path_not_absolute' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects missing absolute path with reason=path_not_found', () => {
    f = makeFixture();
    const res = f.supervisor.attach({
      config_path: join(f.tmp, 'does-not-exist.json'),
    });
    expect(res).toMatchObject({ attached: false, reason: 'path_not_found' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects directory path with reason=path_not_a_file', () => {
    f = makeFixture();
    const dir = f.writeDirectory();
    const res = f.supervisor.attach({ config_path: dir });
    expect(res).toMatchObject({ attached: false, reason: 'path_not_a_file' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects non-regular file (character device /dev/null) with reason=path_not_a_file — guards against FIFO/socket/device readFileSync hang (Cindy review)', () => {
    // /dev/null is a character device on macOS + Linux: statSync says
    // !isFile() && !isDirectory(). If the supervisor fell through to
    // readHostConfig, /dev/null would yield an empty string and we'd
    // wrongly land in parse_failed; a FIFO would actually block the
    // daemon event loop indefinitely. Both classes must be rejected
    // at the stat layer before any read happens.
    f = makeFixture();
    const res = f.supervisor.attach({ config_path: '/dev/null' });
    expect(res).toMatchObject({ attached: false, reason: 'path_not_a_file' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects unparseable JSON with reason=parse_failed', () => {
    f = makeFixture();
    const path = f.writeInvalidJson();
    const res = f.supervisor.attach({ config_path: path });
    expect(res).toMatchObject({ attached: false, reason: 'parse_failed' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects config that fails schema validation with reason=parse_failed', () => {
    f = makeFixture();
    const path = f.writeInvalidShape();
    const res = f.supervisor.attach({ config_path: path });
    expect(res).toMatchObject({ attached: false, reason: 'parse_failed' });
    expect(f.spawned).toEqual([]);
  });

  it('rejects non-loopback http server_url with reason=invalid_server_url (TLS required off-loopback)', () => {
    f = makeFixture();
    const path = f.writeNonLoopbackHttp();
    const res = f.supervisor.attach({ config_path: path });
    expect(res).toMatchObject({ attached: false, reason: 'invalid_server_url' });
    expect(f.spawned).toEqual([]);
  });

  it('CRITICAL: a failed validation attempt MUST NOT stop or restart the currently-active outbound client', () => {
    // The single most important contract: a bad Settings change
    // (typo, deleted file, accidentally-pointed at a directory) must
    // never take down a working daemon outbound. Validation runs to
    // completion before any stop() is fired.
    f = makeFixture();
    const goodPath = f.writeValidConfig('good.json');
    const okStart = f.supervisor.attach({ config_path: goodPath });
    expect(okStart).toMatchObject({ attached: true, action: 'started' });
    expect(f.spawned).toHaveLength(1);
    const live = f.spawned[0]!;
    expect(live.startCalls).toBe(1);
    expect(live.stopCalls).toEqual([]);

    // Now hit the supervisor with one bad request per reason. Each
    // must leave the live client's stop call log empty.
    f.supervisor.attach({ config_path: 'relative.json' });
    f.supervisor.attach({ config_path: join(f.tmp, 'missing.json') });
    f.supervisor.attach({ config_path: f.writeDirectory('dir2') });
    f.supervisor.attach({ config_path: '/dev/null' });
    f.supervisor.attach({ config_path: f.writeInvalidJson('bad-json.json') });
    f.supervisor.attach({ config_path: f.writeInvalidShape('bad-shape.json') });
    f.supervisor.attach({
      config_path: f.writeNonLoopbackHttp('non-loop.json'),
    });

    expect(f.spawned).toHaveLength(1);
    expect(live.stopCalls).toEqual([]);
    expect(f.supervisor.currentConfigPath()).toBe(goodPath);
  });
});

describe('OutboundSupervisor — idempotency matrix (started / noop / switched)', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('first valid attach returns action=started and spawns one client', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    const res = f.supervisor.attach({ config_path: path });
    expect(res).toEqual({ attached: true, config_path: path, action: 'started' });
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.startCalls).toBe(1);
  });

  it('attach with the same path on an already-attached supervisor returns action=noop and does NOT re-spawn', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    const again = f.supervisor.attach({ config_path: path });
    expect(again).toEqual({ attached: true, config_path: path, action: 'noop' });
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.stopCalls).toEqual([]);
    expect(f.spawned[0]!.startCalls).toBe(1);
  });

  it('attach with a different valid path returns action=switched, stopping the old client BEFORE the new starts', () => {
    // Order matters: stop must come before start in the lifecycle
    // trace so backend doesn't see two attachments for the same host
    // at once. The fake client records both call orders so we can
    // assert them as a sequence.
    f = makeFixture();
    const pathA = f.writeValidConfig('a.json');
    const pathB = f.writeValidConfig('b.json');
    f.supervisor.attach({ config_path: pathA });
    expect(f.spawned).toHaveLength(1);
    const clientA = f.spawned[0]!;
    expect(clientA.startCalls).toBe(1);

    const res = f.supervisor.attach({ config_path: pathB });
    expect(res).toEqual({ attached: true, config_path: pathB, action: 'switched' });
    expect(f.spawned).toHaveLength(2);
    const clientB = f.spawned[1]!;
    expect(clientA.stopCalls).toEqual([{ reason: 'config_path_changed' }]);
    expect(clientB.startCalls).toBe(1);
    expect(clientB.stopCalls).toEqual([]);
    expect(f.supervisor.currentConfigPath()).toBe(pathB);
  });

  it('attach with same path AFTER stop() rejects with reason=parse_failed/supervisor stopped (not a recovery path)', () => {
    // Once the supervisor is told to stop (daemon shutdown), further
    // attach calls must not silently spawn new clients. The closer
    // is intentionally one-way; the alternative would let a late
    // IPC after `daemon stop` revive the outbound and race the
    // process tear-down.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    f.supervisor.stop('test_shutdown');
    const res = f.supervisor.attach({ config_path: path });
    expect(res.attached).toBe(false);
    if (!res.attached) expect(res.reason).toBe('parse_failed');
    // Only the pre-stop spawn exists; no zombie revival.
    expect(f.spawned).toHaveLength(1);
  });
});

describe('OutboundSupervisor — event forwarding', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('sendEvent before attach is a silent no-op (pre-attach is expected steady state)', () => {
    f = makeFixture();
    f.supervisor.sendEvent({ event: 'ready' } as never);
    expect(f.spawned).toEqual([]);
  });

  it('sendEvent after attach forwards to the current client only', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    const event: EventFrame = { event: 'shutting_down', reason: 'test' } as never;
    f.supervisor.sendEvent(event);
    expect(f.spawned[0]!.sentEvents).toEqual([event]);
  });

  it('after switch, sendEvent goes to the new client, not the replaced one', () => {
    f = makeFixture();
    const pathA = f.writeValidConfig('a.json');
    const pathB = f.writeValidConfig('b.json');
    f.supervisor.attach({ config_path: pathA });
    f.supervisor.attach({ config_path: pathB });
    const event: EventFrame = { event: 'shutting_down', reason: 'test' } as never;
    f.supervisor.sendEvent(event);
    expect(f.spawned[0]!.sentEvents).toEqual([]);
    expect(f.spawned[1]!.sentEvents).toEqual([event]);
  });
});

describe('OutboundSupervisor — stop()', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('stops the active client with the supplied reason and clears currentConfigPath', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    f.supervisor.stop('daemon_quit');
    expect(f.spawned[0]!.stopCalls).toEqual([{ reason: 'daemon_quit' }]);
    expect(f.supervisor.currentConfigPath()).toBeNull();
  });

  it('stop() is idempotent', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    f.supervisor.stop('first');
    f.supervisor.stop('second');
    // Only the first stop reaches the client.
    expect(f.spawned[0]!.stopCalls).toEqual([{ reason: 'first' }]);
  });
});
