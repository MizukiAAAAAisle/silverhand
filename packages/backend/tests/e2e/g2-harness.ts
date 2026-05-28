/**
 * D4.b-1 — Stage D4 / G2 e2e harness.
 *
 * **Why this exists**: G2 acceptance (§5.2 of `docs/remote-backend-d4-design.md`)
 * requires that the standalone backend ↔ daemon outbound WS path
 * works end-to-end against the real wire — no `Hono.fetch()`
 * shortcuts, no hand-built outbound frames, no direct
 * `HostWsServerController.sendCommand` calls bypassing the
 * dispatcher. This harness composes the same building blocks
 * `startBackend({ mode: 'standalone' })` and a production daemon
 * would, on top of a real TCP listener and a real `ws`
 * WebSocketServer / WebSocket pair.
 *
 * **Cindy boundary lock (`-RKQgKfHmMGhFk2F` / `_5NUY2CzOF9N80pM`)**:
 *
 *   1. Real HTTP listener (port 0, real Node `http.Server`).
 *   2. Real WS upgrade (`installHostWebSocketServer` from
 *      production, mounted by `startBackend`).
 *   3. Real `HostClient` (i.e. real `OutboundDaemonClient` from
 *      `@silverhand/host/daemon`).
 *   4. Real backend dispatcher / fanout
 *      (`OutboundRuntimeEventFanout`, installed by `startBackend`
 *      when `mode: 'standalone'`). The harness wraps the sink in
 *      a recording observer via the `testHooks.wrapHostWsEventSink`
 *      seam — the wrapper **always** delegates to the real fanout
 *      so the production projection path runs untouched. The
 *      observer is non-mutating: it only records frames for
 *      assertion.
 *   5. The only fake is the runtime driver (later commits — B1
 *      does not exercise any agent runtime, only attach).
 *
 * **What is intentionally NOT here**: agent spawn / runtime
 * intents / inbox drain / stop / reconnect recovery. Those land in
 * B2 / B3 / B4 / B5 with this harness as their substrate. Keeping
 * B1 narrowly scoped to harness + attach is per the agreed
 * cadence — Cindy reviews this checkpoint before B2 is started.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: this harness is exclusively the
 * server↔daemon outbound WS formal semantics path. The desktop
 * main ↔ backend IPC supervisor channel is not exercised here at
 * all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutboundDaemonToServerEventFrame } from '@silverhand/host';
import {
  OutboundDaemonClient,
  createDaemonHelloResult,
  writeHostConfigAtomic,
  createDaemonLogControl,
  type OutboundDaemonClientOptions,
  type DaemonLogger,
} from '@silverhand/host/daemon';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  type DaemonHostConfig,
  type ServerConfig,
} from '@silverhand/shared';
import {
  startBackend,
  type RunningBackend,
  type HostWsEventSink,
  type HostWsServerController,
} from '../../src/index.js';
import type { BackendLogger } from '../../src/context.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { HostTokenService } from '../../src/auth/host-token.js';

const silentBackendLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const silentDaemonLogger: DaemonLogger = {
  filePath: '/dev/null',
  logControl: createDaemonLogControl('warn'),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: async () => {},
};

/**
 * One captured frame as the harness observed it on the backend
 * side. `frame` is the schema-parsed object handed to
 * `HostWsEventSink.onEvent` — the same normalized object the
 * production fanout consumes. We do not record raw bytes
 * (transport bytes are explicitly OUT of scope per parity claim).
 */
export interface CapturedHostWsEvent {
  hostId: string;
  connectionId: string;
  frame: OutboundDaemonToServerEventFrame;
  /** Monotonic clock at the moment the wrapper saw the event. */
  observedAt: number;
}

/** Disconnect records captured by the wrapper, in order. */
export interface CapturedHostWsDisconnect {
  hostId: string;
  connectionId: string;
  observedAt: number;
}

export interface G2Harness {
  /** Booted standalone backend. */
  backend: RunningBackend;
  /** Live host id minted via `HostRepo.claimOrCreateLocal`. */
  hostId: string;
  /** Owning user (always `'local'` — uses the openTestDb fixture). */
  userId: string;
  /** Long-lived host token bound to `hostId`. */
  hostToken: string;
  /** `server_url` written to the daemon's config (matches
   *  `backend.url`). */
  serverUrl: string;
  /** Path of the daemon's `daemon-config.json` (per
   *  `defaultDaemonHostConfigPath`). */
  daemonConfigPath: string;
  /** Boots a real `OutboundDaemonClient` against the harness'
   *  config. Returns a stop handle. Tests may call this multiple
   *  times in sequence (later commits' reconnect tests). */
  bootDaemon: () => Promise<{
    client: OutboundDaemonClient;
    stop: (reason?: string) => void;
  }>;
  /** All events the recording wrapper has observed, in order. */
  events: CapturedHostWsEvent[];
  /** All disconnects the wrapper has observed, in order. */
  disconnects: CapturedHostWsDisconnect[];
  /** Tear everything down — close daemon, close backend, rm temp dir. */
  shutdown: () => Promise<void>;
}

export interface G2HarnessOptions {
  /** Override the test user id. Defaults to `'local'` (the
   *  `openTestDb` fixture user). */
  userId?: string;
  /** Override the bind hostname. Defaults to `'127.0.0.1'`. */
  hostname?: string;
  /** Toggle backend logging — useful when debugging a failing
   *  test. Default: silent. */
  verbose?: boolean;
}

/**
 * Boot a standalone backend with the wrapping event-sink observer
 * installed, claim a local host + issue its token, and write the
 * daemon-config.json the production `OutboundDaemonClient` expects.
 * Does NOT start the daemon — call `bootDaemon()` from your test
 * for that, so tests can assert pre-attach state if needed.
 */
export async function bootG2Harness(
  opts: G2HarnessOptions = {},
): Promise<G2Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'silverhand-g2-'));
  const dbPath = join(tempDir, 'silverhand.db');
  const silverhandDir = join(tempDir, '.silverhand');
  const verbose = opts.verbose ?? false;
  const userId = opts.userId ?? 'local';

  const events: CapturedHostWsEvent[] = [];
  const disconnects: CapturedHostWsDisconnect[] = [];

  // Bootstrap the standalone server config the same way production
  // does: mode=remote, an url placeholder (rewritten post-listen).
  const serverConfig: ServerConfig = {
    mode: 'remote',
    url: 'http://127.0.0.1:0',
    auth_token: 'unused-in-standalone-test',
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };

  const backend = await startBackend({
    mode: 'standalone',
    dbPath,
    silverhandDir,
    serverConfig,
    listen: { hostname: opts.hostname ?? '127.0.0.1', port: 0 },
    logger: verbose ? consoleBackendLogger() : silentBackendLogger,
    testHooks: {
      // Cindy P1 #task:660: the wrapper FAILS loud if `startBackend`
      // hands the wrap factory `undefined` (i.e. standalone mode did
      // not install `OutboundRuntimeEventFanout`). Without that
      // strict check a regression that drops the fanout install
      // would still see B1's ready-frame tests stay green because
      // the recording observer would happily capture frames in
      // isolation.
      wrapHostWsEventSink: wrapWithStrictRecording(events, disconnects),
    },
  });

  // The fixture user 'local' is registered by `openTestDb` in unit
  // tests, but here we boot a real backend that performs its own
  // migrations against a fresh disk DB. Insert the user row
  // directly via the same shape `openTestDb` uses, so route ACL +
  // host ownership wiring see a known principal.
  const now = Date.now();
  backend.context.db
    .prepare(
      `INSERT OR IGNORE INTO users (id, name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, `${userId}-test`, `${userId} Test User`, now, now);

  // Claim a local host for the user. `claimOrCreateLocal` is the
  // production path (Stage B.4 `host_claim_or_create`); using it
  // here keeps the harness on the same code path the desktop would
  // exercise on first launch.
  const hostRepo = new HostRepo(backend.context.db);
  const { host } = hostRepo.claimOrCreateLocal({
    userId,
    installationId: `inst-${userId}-${now}`,
    preferredName: 'g2-harness-host',
    now,
  });
  const tokens = new HostTokenService(backend.context.db);
  const issued = tokens.issueHostToken({ hostId: host.id });
  const hostToken = issued.hostToken;

  const daemonConfigPath = join(
    silverhandDir,
    DAEMON_HOST_CONFIG_FILENAME,
  );
  const config: DaemonHostConfig = {
    server_url: backend.url,
    host_id: host.id,
    host_token: hostToken,
  };
  // Use the production atomic writer so we exercise the same
  // disk-layout invariants the desktop hits.
  writeHostConfigAtomic(daemonConfigPath, config);

  const harness: G2Harness = {
    backend,
    hostId: host.id,
    userId,
    hostToken,
    serverUrl: backend.url,
    daemonConfigPath,
    events,
    disconnects,
    bootDaemon: async () => bootHarnessDaemon(daemonConfigPath),
    shutdown: async () => {
      await backend.close().catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };

  // The 'daemon-config' path may live under a parent directory not
  // yet created — `writeHostConfigAtomic` mkdirs the parent on its
  // own, so by this point the daemon can open the file for reading.
  return harness;
}

/** Spawn a real `OutboundDaemonClient`. The client polls
 *  `daemon-config.json` and reconnects on its own.
 *
 *  Returns the client + a `stop()` for tests to call in their
 *  cleanup. Tests may also call `client.stop(...)` directly. */
async function bootHarnessDaemon(configPath: string): Promise<{
  client: OutboundDaemonClient;
  stop: (reason?: string) => void;
}> {
  const helloResult = createDaemonHelloResult(
    `__g2_harness__-${process.pid}-${Date.now()}`,
  );
  const clientOpts: OutboundDaemonClientOptions = {
    configPath,
    logger: silentDaemonLogger,
    // Production daemon's ready event sets `socket_path` for the
    // IPC handshake fallback; the outbound projection strips that
    // field on the wire (see
    // `outboundEventFanout.outboundEventToEventFrame`). The harness
    // uses the production constructor directly so the frame we
    // observe on the server is exactly what a real daemon would
    // emit.
    readyEvent: () => ({
      event: 'ready',
      ...helloResult,
      socket_path: '__g2_harness_no_ipc__',
      daemon_pid: process.pid,
      started_at: Date.now(),
    }),
    // Very fast config-poll for tests; production default is much
    // larger to avoid spinning on disk.
    configPollMs: 50,
    // Tight backoff so re-attach tests (later commits) stay
    // deterministic without `setTimeout` waiting.
    backoff: {
      minDelayMs: 25,
      maxDelayMs: 100,
      factor: 2,
      jitterRatio: 0,
    },
    heartbeat: {
      pingIntervalMs: 10_000,
      pongTimeoutMs: 5_000,
    },
  };
  const client = new OutboundDaemonClient(clientOpts);
  client.start();
  return {
    client,
    stop: (reason = 'g2_harness_shutdown') => client.stop(reason),
  };
}

/**
 * Wrap the real fanout sink in a recording observer.
 *
 * The wrapper is **strictly delegating**:
 *
 *   - `onEvent` calls `real.onEvent(...)` **first**; only if the
 *     real fanout returns without throwing does the wrapper push
 *     the frame into `events[]`. A real-fanout throw therefore
 *     never leaves a captured frame behind — `waitForReadyFrame`
 *     fails / times out and the test fails for the right reason
 *     (Cindy P1 #task:660: "fake real sink throw → event must
 *     not enter events[]").
 *   - `onDisconnect` mirrors the same ordering (delegate first,
 *     then record) so disconnect semantics stay consistent.
 *   - `real === undefined` is **not** a legitimate input for B1 /
 *     B2 / G2. The whole point of the harness is that the
 *     standalone backend installs `OutboundRuntimeEventFanout`.
 *     If a future standalone-mode regression drops the fanout
 *     install, the wrap factory `wrapHostWsEventSink` must fail
 *     loud rather than let the harness keep recording in
 *     isolation (which would mask the missing-fanout bug).
 *
 * The observer is exposed through `harness.events` only — no
 * subscription / unsubscribe API. Tests inspect the array
 * directly and rely on the harness teardown to drop the wrapper.
 */
export function makeRecordingSink(
  real: HostWsEventSink,
  events: CapturedHostWsEvent[],
  disconnects: CapturedHostWsDisconnect[],
): HostWsEventSink {
  return {
    onEvent: (hostId, frame, connectionId) => {
      // Delegate first. If the real fanout throws, the rethrow
      // propagates out of `HostWsConnection.onMessage` exactly as
      // it would in production, AND the wrapper does NOT record
      // the frame — so a test that asserts on `events[]` will
      // observe the failure rather than be fooled by an
      // observer-only success path.
      real.onEvent(hostId, frame, connectionId);
      events.push({
        hostId,
        connectionId,
        frame,
        observedAt: Date.now(),
      });
    },
    onDisconnect: (hostId, connectionId) => {
      real.onDisconnect?.(hostId, connectionId);
      disconnects.push({
        hostId,
        connectionId,
        observedAt: Date.now(),
      });
    },
  };
}

/**
 * The wrap factory passed to `startBackend`'s `testHooks`. Cindy
 * P1 #task:660: if `startBackend` does not install a real fanout
 * (i.e. passes `undefined` into the wrap), fail the harness boot
 * loudly instead of returning a recording-in-isolation sink — a
 * silent fallback would let B1 stay green even after a regression
 * dropped the production fanout install.
 */
function wrapWithStrictRecording(
  events: CapturedHostWsEvent[],
  disconnects: CapturedHostWsDisconnect[],
): (real: HostWsEventSink | undefined) => HostWsEventSink {
  return real => {
    if (!real) {
      throw new Error(
        'g2-harness: wrapHostWsEventSink received undefined fanout — ' +
          'standalone backend must install OutboundRuntimeEventFanout ' +
          'for G2 harness assertions to be meaningful',
      );
    }
    return makeRecordingSink(real, events, disconnects);
  };
}

/**
 * Bounded poll helper — wait until `predicate()` returns truthy
 * or the deadline elapses. Throws with a descriptive message on
 * timeout so test failures point at the unmet condition rather
 * than the bare `Promise<never>`.
 *
 * Used in place of wall-clock `setTimeout(...)` `await` patterns.
 * Cindy's boundary #4: "deterministic, no wall-clock backoff
 * betting".
 */
export async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const intervalMs = opts.intervalMs ?? 10;
  const label = opts.label ?? 'predicate';
  const deadline = Date.now() + timeoutMs;
  // First-pass synchronous check so a satisfied predicate returns
  // immediately without a microtask round trip.
  const first = predicate();
  if (first) return first as T;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const result = predicate();
    if (result) return result as T;
  }
  throw new Error(
    `waitFor: timed out after ${timeoutMs}ms waiting for ${label}`,
  );
}

/** Wait until the controller reports an attachment for `hostId`. */
export async function waitForAttachment(
  controller: HostWsServerController,
  hostId: string,
  timeoutMs = 2_000,
): Promise<NonNullable<ReturnType<HostWsServerController['getAttachment']>>> {
  return waitFor(
    () => controller.getAttachment(hostId) ?? null,
    { timeoutMs, label: `attachment for host ${hostId}` },
  );
}

function consoleBackendLogger(): BackendLogger {
  /* istanbul ignore next — debug aid, opt-in via `{ verbose: true }`. */
  return {
    info: (obj, msg) => console.info('[backend]', msg, obj),
    warn: (obj, msg) => console.warn('[backend]', msg, obj),
    error: (obj, msg) => console.error('[backend]', msg, obj),
  };
}
