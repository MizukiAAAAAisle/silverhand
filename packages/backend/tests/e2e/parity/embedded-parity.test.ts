/**
 * D5.a-4 — EMBEDDED parity e2e.
 *
 * Boots a REAL daemon in-process (`runDaemon` with `localOutboundSocketPath`,
 * which binds the production `LocalOutboundFrameServer` + real
 * `IntentDispatcher` + real `materializeAgent` + a real `Supervisor`) and a
 * REAL embedded backend (`startBackend({ mode: 'embedded' })`) whose
 * `EmbeddedUnixOutboundFrameAdapter` dials the daemon over a local Unix
 * socket. It then runs the SHARED {@link registerParityPhases} contract —
 * the exact same phases the standalone file runs — so embedded and
 * standalone cannot drift into two bespoke success paths (Cindy
 * `8a5PMGwqiBIO8ccg` #1) and the create flow goes route → adapter → real
 * daemon handler → DB flip, never a fake success (#4).
 *
 * On top of the shared phases this file adds the EMBEDDED-ONLY assertion
 * (Cindy #2): the actual frames the backend put on the local Unix socket
 * are captured by an in-the-middle recording proxy and validated against
 * the outbound envelope schema, with a negative proof that the legacy
 * `HostClient` IPC shape (`{ id, intent, params }` / `{ id, result }`)
 * does NOT satisfy that schema — i.e. embedded really speaks the outbound
 * envelope, not the retired local IPC protocol.
 *
 * The deeper connection-id arm "an old connection's disconnect/replay must
 * not wipe the new connection's state" is exercised in
 * `standalone-parity.test.ts` (multi-daemon reconnect is natural there) and
 * by the per-adapter `outbound-frame-adapter-contract.ts` mismatch pin
 * which BOTH adapters pass; embedded's command-level guard is covered by
 * the shared Phase C.
 */
import { SqliteAuthSessionsRepo } from '../../../src/repos/auth-sessions-repo.js';
import {
  resolveBackendDataPaths,
} from '@silverhand/shared/app-data-layout';
import { createServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net';
import { execPath } from 'node:process';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HostClient,
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  splitNdjson,
} from '@silverhand/host';
import {
  runDaemon,
  Supervisor,
  writeHostConfigAtomic,
  type SupervisorOptions,
} from '@silverhand/host/daemon';
import type { RuntimeKind, ServerConfig } from '@silverhand/shared';
import {
  startTestBackend,
  type TestRunningBackend,
} from '../../utils/test-backend.js';
import { HostRepo } from '../../../src/repos/host-repo.js';
import { AuthSessionService } from '../../../src/auth/session.js';
import {
  makeParitySessionInitDriver,
  registerParityPhases,
  waitFor,
  type ParityRig,
} from './outbound-parity-contract.js';

/**
 * Transparent recording proxy on a Unix socket. The backend dials this
 * socket; the proxy forwards bytes verbatim to the real daemon socket and
 * records every frame in BOTH directions (server→daemon commands and
 * daemon→server responses/events) as NDJSON for schema assertions. It
 * alters nothing on the wire — the daemon still really handles each frame.
 */
class RecordingUnixProxy {
  private server: NetServer;
  private readonly sockets: Socket[] = [];
  readonly serverToDaemon: Record<string, unknown>[] = [];
  readonly daemonToServer: Record<string, unknown>[] = [];

  constructor(
    private readonly listenPath: string,
    private readonly upstreamPath: string,
  ) {
    this.server = createServer(downstream => {
      const upstream = netConnect(this.upstreamPath);
      this.sockets.push(downstream, upstream);
      let downBuf = '';
      let upBuf = '';
      downstream.on('data', (chunk: Buffer) => {
        const { frames, leftover } = splitNdjson(downBuf, chunk.toString('utf8'));
        downBuf = leftover;
        for (const line of frames) {
          try {
            this.serverToDaemon.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* non-JSON: ignore for recording, still forwarded below */
          }
        }
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        const { frames, leftover } = splitNdjson(upBuf, chunk.toString('utf8'));
        upBuf = leftover;
        for (const line of frames) {
          try {
            this.daemonToServer.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* non-JSON: ignore for recording, still forwarded below */
          }
        }
        downstream.write(chunk);
      });
      const teardown = (): void => {
        if (!downstream.destroyed) downstream.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      downstream.on('close', teardown);
      upstream.on('close', teardown);
      downstream.on('error', teardown);
      upstream.on('error', teardown);
    });
  }

  async listen(): Promise<void> {
    if (existsSync(this.listenPath)) unlinkSync(this.listenPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) if (!s.destroyed) s.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    try {
      if (existsSync(this.listenPath)) unlinkSync(this.listenPath);
    } catch {
      /* best-effort */
    }
  }
}

interface EmbeddedRigInternals extends ParityRig {
  proxy: RecordingUnixProxy;
}

async function bootEmbeddedRig(): Promise<EmbeddedRigInternals> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'silverhand-d5a4-emb-'));
  const agentsRootDir = mkdtempSync(join(tmpdir(), 'silverhand-d5a4-emb-agents-'));
  const daemonDir = join(tmpDir, 'daemon');
  const logDir = join(daemonDir, 'logs');
  const runtimePidRootDir = join(daemonDir, 'runtime-pids');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(runtimePidRootDir, { recursive: true });

  // Unix sockets live in a SHORT-named dedicated dir with SHORT filenames.
  // macOS `sun_path` caps the socket path at ~104 bytes, so putting sockets
  // under the long descriptive `mkdtemp(...silverhand-d5a4-emb-...)/daemon/`
  // tree with long names (`daemon-outbound-proxy.sock`) overflows and
  // `listen` throws EINVAL (Cindy `oGSnQOO7BfaguDQI` P1-1). Regular files
  // (db, logs, pidfiles, home) have no such limit and stay at tmpDir.
  const sockDir = mkdtempSync(join(tmpdir(), 'shd5a'));
  const controlSock = join(sockDir, 'd.sock');
  const daemonOutboundSock = join(sockDir, 'o.sock');
  const proxySock = join(sockDir, 'p.sock');
  const controlPlaneServerUrlPath = join(daemonDir, 'control-plane-server-url');
  writeFileSync(controlPlaneServerUrlPath, 'http://127.0.0.1:8765\n');
  const expectedSessionId = `d5a4-emb-session-${Date.now()}`;

  // Node-spawn the .cjs fixture (mirrors g2-harness defaultSpawnFn).
  // A benign 'error' listener is attached to every spawned child: a
  // late delivery/restart can ask the supervisor to spawn a runtime
  // *after* `afterAll` has `rmSync`'d the runtime cwd, which makes Node
  // emit an async `spawn ... ENOENT` on the child. The supervisor only
  // listens for 'exit'/'close', so that error would otherwise surface as
  // an unhandled exception that fails the run even though every test
  // passed. We own the returned child here, so swallowing its error is
  // the correct place to absorb the teardown race.
  const spawnFn: NonNullable<SupervisorOptions['spawnFn']> = (
    bin,
    args,
    options,
  ): ChildProcess => {
    const child = nodeSpawn(execPath, [bin, ...args.slice(1)], options as SpawnOptions);
    child.on('error', () => {
      /* swallow teardown-race spawn ENOENT (cwd rm'd during shutdown) */
    });
    return child;
  };

  // 1) Real daemon: binds the local outbound frame server (production
  //    LocalOutboundFrameServer + IntentDispatcher + real materializeAgent)
  //    and a real Supervisor wired to the parity session_init driver.
  const daemon = await runDaemon({
    socketPath: controlSock,
    pidFilePath: join(daemonDir, 'daemon.pid'),
    logDir,
    localOutboundSocketPath: daemonOutboundSock,
    installSignals: false,
    writeStdoutHandshake: false,
    daemonIdentityPath: null,
    runtimePidRootDir,
    controlPlaneServerUrlPath,
    // #task:1596 / relocation-v1 §7-4 — the DURABLE agent tree is sandboxed by
    // this EXPLICIT agents root, the same coordinate the rig asserts L1 dirs
    // under (#task:1813: required option, no home-derived fallback).
    agentHomeRootDir: agentsRootDir,
    supervisorFactory: ({
      emit,
      logger,
      daemonInstanceId,
      runtimePidRootDir: pidRoot,
      runtimeStartResolveDeps,
      controlPlaneServerUrl,
      agentHomeMutationCoordinator,
    }) =>
      new Supervisor({
        emit,
        logger,
        driverFor: (_kind: RuntimeKind) => makeParitySessionInitDriver(expectedSessionId),
        resolveRuntime: async (_kind, fallback) => ({
          binary: fallback,
          version: null,
        }),
        spawnFn,
        daemonInstanceId,
        runtimePidRootDir: pidRoot,
        runtimeStartResolveDeps,
        controlPlaneServerUrl,
        agentHomeMutationCoordinator,
        initLivenessSilenceMs: 10_000,
        initPreProtocolCapMs: 10_000,
        initPostProtocolMs: 10_000,
        // Disable init-retry respawns: the parity fixture always inits
        // immediately, so retry is never needed, and leaving it on let a
        // teardown-time init-timeout schedule an internal respawn that
        // raced `rmSync` of the runtime cwd → stray `spawn node ENOENT`
        // surfacing as an unhandled error after the suite passed.
        initMaxRetries: 0,
        sigtermToSigkillMs: 200,
        sigkillTimeoutMs: 1_000,
      }),
  });

  // 2) Recording proxy in front of the daemon's outbound socket.
  const proxy = new RecordingUnixProxy(proxySock, daemonOutboundSock);
  await proxy.listen();

  // 2b) Attach the daemon to its claimed host identity, mirroring what
  //     desktop main does in production (`host_outbound_attach` with the
  //     app-managed daemon-config). Since #task:1595 the daemon's prompt
  //     Computer authority is the LIVE authenticated binding and a
  //     runtime_start on an unattached daemon fails closed
  //     (`registry_unavailable`), so an embedded fixture without this step
  //     no longer spawns. The server_url is never dialed successfully here
  //     (nothing listens) — attach accepts the validated config and sets the
  //     binding regardless, exactly like the pre-login desktop window.
  const hostConfigPath = join(tmpDir, 'daemon-config.json');
  writeHostConfigAtomic(hostConfigPath, {
    server_url: 'http://127.0.0.1:58128',
    host_id: 'parity-embedded-host',
    host_token: 'parity-host-token',
  });
  {
    const attachClient = new HostClient({ socketPath: controlSock });
    await attachClient.connect();
    try {
      const attached = await attachClient.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      if (!attached.attached) {
        throw new Error('parity fixture: host_outbound_attach failed');
      }
    } finally {
      await attachClient.close();
    }
  }

  // 3) Real embedded backend dialing the PROXY socket (so we capture the
  //    real frames it puts on the wire). The embedded adapter connects from
  //    the listen callback after the URL finalizes (D5.a-3 P1-1).
  const serverConfig: ServerConfig = {
    mode: 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: 'e'.repeat(32),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
  const backend: TestRunningBackend = await startTestBackend({
    mode: 'embedded',
    dbPath: join(tmpDir, 'silverhand.db'),
    ...resolveBackendDataPaths(tmpDir),
    serverConfig,
    silverhandCliLauncher: { command: 'true', args: [] },
    logger: { info() {}, warn() {}, error() {} },
    outboundSocketPath: proxySock,
  });

  const db = backend.context.db;

  // A user to own seeded agents + issue a session bearer for POST /api/agents.
  const now = Date.now();
  const userId = 'user-d5a4-emb';
  db.prepare(
    `INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, 'd5a4-emb-user', 'D5a4 Embedded User', now, now);
  // Bind the local host (the one `startBackend` created via `ensureLocal`,
  // which the embedded adapter uses) to this user — the materialize route's
  // L0 gate requires an ACTIVE local host for the caller. `claimOrCreateLocal`
  // claims that same unbound row, so the bound id == the adapter's host id.
  const hostId = new HostRepo(db).claimOrCreateLocal({
    userId,
    installationId: 'd5a4-emb-install',
  }).host.id;
  const { userToken: bearer } = new AuthSessionService(new SqliteAuthSessionsRepo(db)).issueSession({ userId });

  // Wait until the embedded adapter has a live connection to the daemon.
  const adapter = () => {
    const a = backend.context.outboundFrameAdapter?.();
    if (!a) throw new Error('embedded backend has no outboundFrameAdapter');
    return a;
  };
  await waitFor(
    () => (adapter().connectionIdForHost(hostId) ? true : null),
    { timeoutMs: 10_000, label: 'embedded adapter connected to daemon' },
  );

  return {
    name: 'embedded',
    backend,
    baseUrl: backend.url,
    bearer,
    hostId,
    userId,
    silverhandDir: tmpDir,
    expectedSessionId,
    agentsRootDir,
    adapter,
    proxy,
    shutdown: async () => {
      // Stop the DAEMON first: it owns the supervisor that spawns runtime
      // children. Tearing down the backend first can let a runtime exit →
      // supervisor respawn race the process teardown (stray spawn ENOENT).
      // Stopping the daemon up front quiesces the supervisor before anything
      // else goes away.
      await daemon.stop('d5a4_embedded_shutdown').catch(() => undefined);
      await backend.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      for (const dir of [tmpDir, agentsRootDir, sockDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

describe('D5.a-4 embedded parity (real startBackend embedded + real in-process daemon over Unix)', () => {
  let rig: EmbeddedRigInternals | null = null;

  beforeAll(async () => {
    rig = await bootEmbeddedRig();
  }, 60_000);

  afterAll(async () => {
    await rig?.shutdown().catch(() => undefined);
    rig = null;
  });

  registerParityPhases(() => {
    if (!rig) throw new Error('embedded rig not booted');
    return rig;
  });

  it('Phase D2 (embedded-only) — captured local Unix frames are the outbound envelope, NOT legacy HostClient IPC', () => {
    if (!rig) throw new Error('embedded rig not booted');
    // By now Phases A/B/C have dispatched runtime_start / runtime_status /
    // agent_materialize over the local socket, so the proxy has recorded
    // real server→daemon command frames.
    const recorded = rig.proxy.serverToDaemon.filter(f => f.type === 'command');
    expect(recorded.length, 'proxy should have captured ≥1 server→daemon command').toBeGreaterThan(0);

    // POSITIVE: every recorded command frame satisfies the outbound
    // command envelope schema (direction/type/id/kind/params, strict).
    for (const frame of recorded) {
      const parsed = OutboundServerToDaemonCommandFrameSchema.safeParse(frame);
      expect(parsed.success, `recorded frame failed outbound schema: ${JSON.stringify(frame)}`).toBe(
        true,
      );
      expect((frame as { direction: string }).direction).toBe('server_to_daemon');
    }
    // We expect to have seen at least one materialize + one runtime command,
    // plus the surviving D4.e-1 registry intent (Phase D dispatched it over
    // the SAME local Unix socket): the envelope proof must cover the new
    // command kinds, not just the D5.a set.
    const kinds = new Set(recorded.map(f => String(f.kind)));
    expect(kinds.has('agent_materialize')).toBe(true);
    expect(kinds.has('agent_workspace_index')).toBe(true);
    expect(kinds.has('agent_l2_seed')).toBe(true);
    expect(kinds.has('agent_files_purge')).toBe(true);

    // NEGATIVE: the retired local `HostClient` IPC shapes must NOT satisfy
    // the outbound envelope schema — proves embedded speaks the unified
    // envelope, not the legacy `{ id, intent, params }` / `{ id, result }`
    // request/response protocol.
    const legacyIpcRequest = { id: 'x1', intent: 'agent_materialize', params: {} };
    const legacyIpcResponse = { id: 'x1', result: { materialized: true } };
    expect(OutboundServerToDaemonCommandFrameSchema.safeParse(legacyIpcRequest).success).toBe(false);
    expect(OutboundServerToDaemonCommandFrameSchema.safeParse(legacyIpcResponse).success).toBe(false);

    // P2 (Cindy oGSnQOO7BfaguDQI) — the reverse direction is the outbound
    // envelope too: every captured daemon→server frame parses as a
    // command_response, an event, or a heartbeat (the three legal inbound
    // shapes the embedded adapter itself admits), and the legacy IPC
    // response shape does NOT satisfy the response schema. This makes the
    // envelope proof bidirectional, not just server→daemon.
    expect(rig.proxy.daemonToServer.length).toBeGreaterThan(0);
    for (const frame of rig.proxy.daemonToServer) {
      const ok =
        OutboundDaemonToServerCommandResponseFrameSchema.safeParse(frame).success ||
        OutboundDaemonToServerEventFrameSchema.safeParse(frame).success ||
        OutboundHeartbeatFrameSchema.safeParse(frame).success;
      expect(ok, `daemon→server frame matched no outbound schema: ${JSON.stringify(frame)}`).toBe(
        true,
      );
      expect((frame as { direction: string }).direction).toBe('daemon_to_server');
    }
    // We saw at least one real command_response (Phase B's agent_materialize
    // ack rode back over the envelope).
    const responses = rig.proxy.daemonToServer.filter(
      f => OutboundDaemonToServerCommandResponseFrameSchema.safeParse(f).success,
    );
    expect(responses.length).toBeGreaterThan(0);
    // The legacy IPC `{ id, result }` response shape is NOT a valid
    // command_response envelope (missing direction/type/kind).
    expect(
      OutboundDaemonToServerCommandResponseFrameSchema.safeParse(legacyIpcResponse).success,
    ).toBe(false);
  });
});
