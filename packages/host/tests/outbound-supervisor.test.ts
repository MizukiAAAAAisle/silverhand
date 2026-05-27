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

describe('OutboundSupervisor — detach() (D3.b Commit 3)', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('detach with no active client returns action=noop without spawning anything', () => {
    // Pre-attach state — desktop never logged in but still cleans up
    // on quit. The hint is harmless; the supervisor reports no work.
    f = makeFixture();
    const res = f.supervisor.detach();
    expect(res).toEqual({ detached: true, action: 'noop' });
    expect(f.spawned).toEqual([]);
    expect(f.supervisor.currentConfigPath()).toBeNull();
  });

  it('detach with an active client returns action=detached and stops the client with a grep-friendly reason', () => {
    // The 'host_outbound_detach' stop reason is the load-bearing
    // signal — it lets log readers and outbound-client diagnostics
    // distinguish a deliberate quit-time hint from a crash /
    // heartbeat-driven close. Future readers may grep on it.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    expect(f.spawned).toHaveLength(1);
    const client = f.spawned[0]!;

    const res = f.supervisor.detach();
    expect(res).toEqual({ detached: true, action: 'detached' });
    expect(client.stopCalls).toEqual([{ reason: 'host_outbound_detach' }]);
    expect(f.supervisor.currentConfigPath()).toBeNull();
  });

  it('detach is NOT terminal — a later attach succeeds and spawns a fresh client', () => {
    // Strict distinction from stop(): detach clears the active client
    // but leaves the supervisor usable. Models the log-out →
    // log-in-as-different-user flow in one daemon process; also
    // covers any future UI affordance that detaches without quitting
    // the daemon.
    f = makeFixture();
    const pathA = f.writeValidConfig('a.json');
    const pathB = f.writeValidConfig('b.json');
    f.supervisor.attach({ config_path: pathA });
    expect(f.spawned).toHaveLength(1);
    f.supervisor.detach();
    expect(f.supervisor.currentConfigPath()).toBeNull();

    // Re-attach must succeed AND must use a fresh client (not revive
    // the stopped one). Action is 'started' because there is no
    // current client at this point — same as a first-time attach.
    const res = f.supervisor.attach({ config_path: pathB });
    expect(res).toEqual({ attached: true, config_path: pathB, action: 'started' });
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[1]!.startCalls).toBe(1);
  });

  it('detach is idempotent — calling it twice in a row returns noop the second time', () => {
    // A defensive case: if the desktop main process somehow sends
    // the hint twice (retry / race), the second call must be a
    // harmless noop with no further client side-effects.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    const first = f.supervisor.detach();
    expect(first.action).toBe('detached');
    const second = f.supervisor.detach();
    expect(second).toEqual({ detached: true, action: 'noop' });
    // Client received exactly one stop.
    expect(f.spawned[0]!.stopCalls).toEqual([
      { reason: 'host_outbound_detach' },
    ]);
  });

  it('detach AFTER stop() returns noop (terminal stop already cleared the client)', () => {
    // stop() is the terminal teardown path; detach() called after it
    // must NOT throw, must NOT revive the supervisor, and must NOT
    // re-stop a non-existent client. Returns noop because the
    // post-condition ("no active client") is satisfied.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    f.supervisor.stop('daemon_quit');
    const res = f.supervisor.detach();
    expect(res).toEqual({ detached: true, action: 'noop' });
    // The stop call from stop() is the only stop the client received.
    expect(f.spawned[0]!.stopCalls).toEqual([{ reason: 'daemon_quit' }]);
  });
});

describe('OutboundSupervisor — reload() (D3.c Commit 2)', () => {
  let f: SupervisorFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  // ── Hard-reject not_attached (Cindy review point 1) ──────────────

  it('reload BEFORE attach returns reason=not_attached and does NOT spawn any client', () => {
    // Load-bearing: reload MUST NOT silently fall through to attach.
    // If a user clicks Save in Settings before login somehow lands,
    // reload tells the caller explicitly so they can route to attach
    // (or surface the bug); it does NOT auto-bootstrap.
    f = makeFixture();
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(false);
    if (res.reloaded) throw new Error('unreachable');
    expect(res.reason).toBe('not_attached');
    expect(f.spawned).toHaveLength(0);
  });

  it('reload AFTER stop() returns reason=not_attached (supervisor terminal — caller must NOT reuse it)', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    f.supervisor.stop('daemon_quit');
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(false);
    if (res.reloaded) throw new Error('unreachable');
    expect(res.reason).toBe('not_attached');
    // Only the stop call from stop() — reload didn't touch the client.
    expect(f.spawned[0]!.stopCalls).toEqual([{ reason: 'daemon_quit' }]);
  });

  // ── Validate-first-then-swap: failures leave old client untouched
  //    (Cindy review point 2: 失败不动旧 client) ───────────────────────

  it('config_unreadable (file deleted between attach and reload) → leaves old client running and returns reason=config_unreadable', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    // Simulate the file vanishing after attach (the daemon's
    // currently-attached configPath now points at nothing).
    rmSync(path);
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(false);
    if (res.reloaded) throw new Error('unreachable');
    expect(res.reason).toBe('config_unreadable');
    // CRITICAL: the old client was NOT stopped — a bad reload must
    // not take down a working outbound. spawned.length stays 1.
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.stopCalls).toEqual([]);
  });

  it('parse_failed (config now contains invalid JSON / wrong shape) → leaves old client running and returns reason=parse_failed', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    // Overwrite the SAME path with garbage. Reload re-reads current
    // path; cannot swap to a different path by design.
    writeFileSync(path, '{not even json', 'utf8');
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(false);
    if (res.reloaded) throw new Error('unreachable');
    expect(res.reason).toBe('parse_failed');
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.stopCalls).toEqual([]);
  });

  it('invalid_server_url (non-loopback host snuck into the file) → leaves old client running and returns reason=invalid_server_url', () => {
    // Defense-in-depth: Settings UI rejects non-loopback (Commit 4),
    // main re-validates (Commit 3), AND daemon checks here. Tests
    // pin the daemon-side gate — a hand-edited config carrying a
    // non-loopback host gets rejected without taking down the old
    // client, even if the upper layers somehow allow it through.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    writeFileSync(
      path,
      JSON.stringify({
        server_url: 'http://example.com:8765',
        host_id: 'host-1',
        host_token: 'token-2',
      }),
      'utf8',
    );
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(false);
    if (res.reloaded) throw new Error('unreachable');
    expect(res.reason).toBe('invalid_server_url');
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.stopCalls).toEqual([]);
  });

  // ── Success arms: unchanged / reloaded ───────────────────────────

  it('reload with byte-identical config returns action=unchanged and does NOT swap the client (no WS bounce on no-op Save)', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    // Don't touch the file — same bytes on re-read.
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(true);
    if (!res.reloaded) throw new Error('unreachable');
    expect(res.action).toBe('unchanged');
    expect(res.config_path).toBe(path);
    expect(res.host_id).toBe('host-1');
    // Critically: the old client is still the only spawned client and
    // has NOT been stopped. A no-op Save must not bounce the WS.
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.stopCalls).toEqual([]);
  });

  it('reload with new bytes swaps the client (validate-first-then-swap order: stop old then start new) and returns action=reloaded', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    // Rewrite with a different host_token so fingerprint differs.
    writeFileSync(
      path,
      JSON.stringify({
        server_url: 'http://127.0.0.1:8765',
        host_id: 'host-1',
        host_token: 'token-2-rotated',
      }),
      'utf8',
    );
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(true);
    if (!res.reloaded) throw new Error('unreachable');
    expect(res.action).toBe('reloaded');
    expect(res.config_path).toBe(path);
    expect(res.host_id).toBe('host-1');
    // Two clients spawned in order; the first was stopped with a
    // grep-friendly reason BEFORE the second was started.
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[0]!.stopCalls).toEqual([{ reason: 'config_reload' }]);
    expect(f.spawned[1]!.startCalls).toBe(1);
  });

  // ── Fingerprint behavior pinning (Cindy review point 3:
  //    config fingerprint 单源共用) ──────────────────────────────────

  it('changes to server_url alone are enough to flip unchanged → reloaded (fingerprint covers the URL byte)', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    writeFileSync(
      path,
      JSON.stringify({
        server_url: 'http://127.0.0.1:8766',
        host_id: 'host-1',
        host_token: 'token-1',
      }),
      'utf8',
    );
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(true);
    if (!res.reloaded) throw new Error('unreachable');
    expect(res.action).toBe('reloaded');
  });

  it('changes to host_id alone flip unchanged → reloaded (fingerprint covers the host_id byte)', () => {
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    writeFileSync(
      path,
      JSON.stringify({
        server_url: 'http://127.0.0.1:8765',
        host_id: 'host-2',
        host_token: 'token-1',
      }),
      'utf8',
    );
    const res = f.supervisor.reload();
    expect(res.reloaded).toBe(true);
    if (!res.reloaded) throw new Error('unreachable');
    expect(res.action).toBe('reloaded');
    expect(res.host_id).toBe('host-2');
  });

  it('reload after a successful reload re-establishes the new fingerprint baseline (second identical reload returns unchanged)', () => {
    // Pins that reload updates the supervisor's in-memory fingerprint
    // so a subsequent unchanged reload reports unchanged (not reloaded
    // again). Failure mode this guards against: forgetting to update
    // the fingerprint after swap → every reload becomes a WS bounce.
    f = makeFixture();
    const path = f.writeValidConfig();
    f.supervisor.attach({ config_path: path });
    writeFileSync(
      path,
      JSON.stringify({
        server_url: 'http://127.0.0.1:8765',
        host_id: 'host-1',
        host_token: 'token-rotated',
      }),
      'utf8',
    );
    expect(f.supervisor.reload().reloaded).toBe(true);
    // Don't touch the file — same bytes on the SECOND reload.
    const second = f.supervisor.reload();
    expect(second.reloaded).toBe(true);
    if (!second.reloaded) throw new Error('unreachable');
    expect(second.action).toBe('unchanged');
    // Only two clients ever spawned — the second reload did NOT
    // create a third.
    expect(f.spawned).toHaveLength(2);
  });
});
