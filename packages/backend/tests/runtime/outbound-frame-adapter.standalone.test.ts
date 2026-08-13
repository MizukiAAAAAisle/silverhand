import { createSqliteHostPersistence } from '../../src/repos/host-uow.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { encodeOutboundFrame, OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import { HostTokenService } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HOST_WS_PATH,
  installHostWebSocketServer,
  type HostWsServerController,
} from '../../src/ws/host-ws-server.js';
import { StandaloneOutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { buildTestApp } from '../utils/app.js';
import {
  runOutboundFrameAdapterContract,
  type FakeDaemonCommand,
  type FakeDaemonConnection,
  type OutboundFrameAdapterFixture,
} from './outbound-frame-adapter-contract.js';

/**
 * D5.a-1 — run the shared {@link runOutboundFrameAdapterContract} against
 * the standalone adapter over a REAL outbound WS transport: a live
 * `HostWsServerController` plus a raw-WebSocket fake daemon. No faked
 * adapter and no stubbed dispatch — the same harness D5.a-2 will run
 * against the embedded local-Unix adapter.
 */
runOutboundFrameAdapterContract('standalone (outbound WSS)', async () => {
  const t = buildTestApp();
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  // pingIntervalMs: 0 — disable server→daemon heartbeats so the fake
  // daemon's frame stream contains only command frames.
  const controller: HostWsServerController = installHostWebSocketServer(httpServer, t.ctx, {
    hostTokenVerifier: new HostTokenService(createSqliteHostPersistence(t.ctx.db)), hosts: new HostRepo(t.ctx.db), pingIntervalMs: 0 },
  );
  await new Promise<void>(resolve =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const port = (httpServer.address() as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}${HOST_WS_PATH}`;

  const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local');
  if (!host) throw new Error('test app did not provision a local host');
  const issued = new HostTokenService(createSqliteHostPersistence(t.ctx.db)).issueHostToken({
    hostId: host.id,
  });

  const sockets: WebSocket[] = [];

  const fixture: OutboundFrameAdapterFixture = {
    adapter: new StandaloneOutboundFrameAdapter(() => controller),
    hostId: host.id,
    unconnectedHostId: 'phantom-host-never-connected',
    connectDaemon: async (): Promise<FakeDaemonConnection> => {
      const ws = await connectHost(wsUrl, issued.hostToken);
      sockets.push(ws);
      // #task:1966 — a bare authenticated socket is a transport slot, not an
      // attachment: the adapter only sees a live generation once a COMPATIBLE
      // `ready` has landed. The contract harness needs a reachable daemon, so
      // this helper hands it a fully admitted one.
      ws.send(readyFrame('daemon-host', []));
      await waitFor(() => controller.connectionIdForHost(host.id) !== null);
      const connectionId = controller.connectionIdForHost(host.id)!;
      return new StandaloneFakeDaemon(ws, connectionId);
    },
    cleanup: async () => {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
      await controller.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      t.cleanup();
    },
  };

  return fixture;
});

class StandaloneFakeDaemon implements FakeDaemonConnection {
  readonly connectionId: string;
  private readonly queue: FakeDaemonCommand[] = [];
  private waiter: ((cmd: FakeDaemonCommand) => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    connectionId: string,
  ) {
    this.connectionId = connectionId;
    this.ws.on('message', (data: RawData) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type !== 'command') return; // ignore heartbeat / control
      const cmd: FakeDaemonCommand = {
        id: String(frame.id),
        kind: String(frame.kind),
        params: frame.params,
      };
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(cmd);
      } else {
        this.queue.push(cmd);
      }
    });
  }

  nextCommand(): Promise<FakeDaemonCommand> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<FakeDaemonCommand>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('no command frame received within 100ms'));
      }, 100);
      timer.unref?.();
      this.waiter = cmd => {
        clearTimeout(timer);
        resolve(cmd);
      };
    });
  }

  respondResult(id: string, kind: string, result: unknown): void {
    this.ws.send(
      encodeOutboundFrame({
        direction: 'daemon_to_server',
        type: 'command_response',
        id,
        kind,
        result,
      } as never),
    );
  }

  respondError(
    id: string,
    kind: string,
    error: { code: string; message: string },
  ): void {
    this.ws.send(
      encodeOutboundFrame({
        direction: 'daemon_to_server',
        type: 'command_response',
        id,
        kind,
        error,
      } as never),
    );
  }

  async disconnect(): Promise<void> {
    const closed = waitForClose(this.ws);
    this.ws.close(1001, 'test_disconnect');
    await closed;
  }
}

function readyFrame(hostname: string, capabilities: string[]): string | Buffer {
  return encodeOutboundFrame({
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
    daemon_version: 'test',
    daemon_id: 'local',
    instance_id: 'inst-1',
    host_descriptor: { name: hostname, kind: 'local' },
    capabilities,
    daemon_pid: 4242,
    started_at: 1_717_000_000,
  } as never) as string | Buffer;
}

async function connectHost(
  url: string,
  token: string,
): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpected);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onUnexpected = (_req: unknown, res: { statusCode?: number }) => {
      cleanup();
      reject(new Error(`unexpected response ${res.statusCode ?? 'unknown'}`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpected);
  });
  return ws;
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => ws.once('close', () => resolve()));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

// #task:1486 P2-2 — the standalone (outbound-WS) adapter changed ONLY its
// implementation; the generation-local capability contract was proven for the
// embedded local-Unix adapter but NOT over the real WS transport. This is the
// core "no protocol bump, still safe" acceptance: a reconnected daemon must
// never inherit a prior generation's advertised `runtime.codex.reasoning.v1`,
// so a stale binary can never authorize an Ultra send it no longer supports.
describe('StandaloneOutboundFrameAdapter capability recording (#task:1486 P2-2)', () => {
  it('records ready capabilities and a reconnected daemon starts without the stale grant', async () => {
    const t = buildTestApp();
    const httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const controller: HostWsServerController = installHostWebSocketServer(httpServer, t.ctx, {
    hostTokenVerifier: new HostTokenService(createSqliteHostPersistence(t.ctx.db)), hosts: new HostRepo(t.ctx.db), pingIntervalMs: 0 },
    );
    await new Promise<void>(resolve =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    const port = (httpServer.address() as AddressInfo).port;
    const wsUrl = `ws://127.0.0.1:${port}${HOST_WS_PATH}`;

    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local');
    if (!host) throw new Error('test app did not provision a local host');
    const issued = new HostTokenService(createSqliteHostPersistence(t.ctx.db)).issueHostToken({
      hostId: host.id,
    });
    const adapter = new StandaloneOutboundFrameAdapter(() => controller);

    const sockets: WebSocket[] = [];
    try {
      // First generation attaches and advertises the reasoning capability.
      const ws1 = await connectHost(wsUrl, issued.hostToken);
      sockets.push(ws1);

      // Before `ready`: an authenticated transport slot, but no attachment at all
      // (#task:1966) — so there is no capability set for the adapter to read.
      expect(adapter.getAttachment(host.id)).toBeNull();

      ws1.send(readyFrame('daemon-host-1', ['runtime.codex.reasoning.v1']));
      await waitFor(
        () =>
          adapter
            .getAttachment(host.id)
            ?.capabilities.includes('runtime.codex.reasoning.v1') ?? false,
      );
      const gen1 = controller.connectionIdForHost(host.id);
      expect(gen1).not.toBeNull();

      // Drop the connection: standalone deletes the attachment for THIS
      // generation, so nothing survives to be inherited.
      const closed = waitForClose(ws1);
      ws1.close(1001, 'test_disconnect');
      await closed;
      await waitFor(() => controller.connectionIdForHost(host.id) !== gen1);

      // Reconnect as a NEW generation. Post-#task:1966 the stale grant cannot be
      // inherited for a stronger reason than before: until the new daemon
      // re-declares, there is no attachment to inherit it INTO.
      const ws2 = await connectHost(wsUrl, issued.hostToken);
      sockets.push(ws2);
      expect(adapter.getAttachment(host.id)).toBeNull();

      // The new generation re-declares its OWN, narrower set — still no Ultra.
      ws2.send(readyFrame('daemon-host-2', ['runtime.claude']));
      await waitFor(
        () =>
          adapter.getAttachment(host.id)?.capabilities.includes('runtime.claude') ??
          false,
      );
      const gen2 = controller.connectionIdForHost(host.id);
      expect(gen2).not.toBeNull();
      expect(gen2).not.toBe(gen1);
      expect(
        adapter
          .getAttachment(host.id)
          ?.capabilities.includes('runtime.codex.reasoning.v1'),
      ).toBe(false);
    } finally {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
      await controller.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      t.cleanup();
    }
  });
});
