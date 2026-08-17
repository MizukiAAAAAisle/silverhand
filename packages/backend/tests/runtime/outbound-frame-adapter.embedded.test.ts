import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitNdjson } from '@silverhand/host';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import { EmbeddedUnixOutboundFrameAdapter } from '../../src/runtime/embedded-unix-outbound-frame-adapter.js';
import {
  runOutboundFrameAdapterContract,
  type FakeDaemonCommand,
  type FakeDaemonConnection,
  type OutboundFrameAdapterFixture,
} from './outbound-frame-adapter-contract.js';

/**
 * D5.a-2 — run the SHARED {@link runOutboundFrameAdapterContract} against
 * the embedded adapter over a REAL local Unix socket. The "daemon side"
 * is a raw, test-controlled Unix-socket peer (mirroring the standalone
 * raw-WS fake daemon): it can write arbitrary — including adversarial /
 * schema-invalid — frames so the contract exercises the ADAPTER's own
 * response parsing, not a cooperative server.
 *
 * The real `LocalOutboundFrameServer` is verified separately by its own
 * host-side test; D5.a-4 joins the real adapter and real server end to
 * end. Passing this file means the embedded adapter satisfies the exact
 * same envelope contract the standalone adapter does.
 */
let socketSeq = 0;

runOutboundFrameAdapterContract(
  'embedded (local Unix outbound socket)',
  async () => {
    const socketPath = join(
      tmpdir(),
      `sh-d5a-${process.pid}-${++socketSeq}.sock`,
    );
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const accepted: Socket[] = [];
    let pendingAccept: ((s: Socket) => void) | null = null;
    const acceptQueue: Socket[] = [];
    const server: NetServer = createServer(sock => {
      accepted.push(sock);
      if (pendingAccept) {
        const resolve = pendingAccept;
        pendingAccept = null;
        resolve(sock);
      } else {
        acceptQueue.push(sock);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const hostId = 'local';
    const adapter = new EmbeddedUnixOutboundFrameAdapter({
      socketPath,
      hostId,
    });

    const fixture: OutboundFrameAdapterFixture = {
      adapter,
      hostId,
      unconnectedHostId: 'phantom-host-never-connected',
      connectDaemon: async (): Promise<FakeDaemonConnection> => {
        const waitAccept = new Promise<Socket>(resolve => {
          const queued = acceptQueue.shift();
          if (queued) resolve(queued);
          else pendingAccept = resolve;
        });
        await adapter.connect();
        const sock = await waitAccept;
        const connectionId = adapter.connectionIdForHost(hostId);
        if (!connectionId) {
          throw new Error('adapter did not mint a connectionId on connect');
        }
        return new EmbeddedFakeDaemon(sock, connectionId);
      },
      cleanup: async () => {
        await adapter.close();
        for (const s of accepted) {
          if (!s.destroyed) s.destroy();
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath);
        } catch {
          /* best-effort */
        }
      },
    };
    return fixture;
  },
);

describe('EmbeddedUnixOutboundFrameAdapter reconnect', () => {
  it('redials the daemon outbound socket after an unexpected disconnect', async () => {
    const socketPath = join(
      tmpdir(),
      `sh-d5a-reconnect-${process.pid}-${++socketSeq}.sock`,
    );
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const accepted: Socket[] = [];
    let pendingAccept: ((s: Socket) => void) | null = null;
    const acceptQueue: Socket[] = [];
    const server: NetServer = createServer(sock => {
      accepted.push(sock);
      if (pendingAccept) {
        const resolve = pendingAccept;
        pendingAccept = null;
        resolve(sock);
      } else {
        acceptQueue.push(sock);
      }
    });

    const nextAccepted = (): Promise<Socket> => {
      const queued = acceptQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolve => {
        pendingAccept = resolve;
      });
    };

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const hostId = 'local';
    const warnings: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    const adapter = new EmbeddedUnixOutboundFrameAdapter({
      socketPath,
      hostId,
      logger: {
        info: () => undefined,
        warn: (meta, msg) => warnings.push({ meta, msg }),
        error: () => undefined,
      },
    });

    try {
      const firstAccept = nextAccepted();
      await adapter.connect();
      const firstSocket = await firstAccept;
      const firstConnectionId = adapter.connectionIdForHost(hostId);
      expect(firstConnectionId).toMatch(/^embedded-unix-local-conn-/);

      firstSocket.destroy();

      const secondSocket = await nextAccepted();
      await waitFor(
        () =>
          adapter.connectionIdForHost(hostId) !== null &&
          adapter.connectionIdForHost(hostId) !== firstConnectionId,
      );
      const secondConnectionId = adapter.connectionIdForHost(hostId);
      expect(secondConnectionId).toMatch(/^embedded-unix-local-conn-/);
      expect(secondConnectionId).not.toBe(firstConnectionId);
      expect(
        warnings.some(entry =>
          entry.msg.includes('socket disconnected; scheduling reconnect'),
        ),
      ).toBe(true);

      const daemon = new EmbeddedFakeDaemon(secondSocket, secondConnectionId!);
      const pending = adapter.sendCommand(
        hostId,
        'runtime_status',
        { conversation_id: 'c1', agent_id: 'a1' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      daemon.respondResult(cmd.id, 'runtime_status', {
        runtimes: [
          {
            runtime_scope: {
              kind: 'conversation',
              conversation_id: 'c1',
              agent_id: 'a1',
            },
            conversation_id: 'c1',
            agent_id: 'a1',
            runtime_generation: 1,
            pid: null,
            phase: 'idle',
            run_state: null,
            started_at: null,
          },
        ],
      });

      await expect(pending).resolves.toMatchObject({
        runtimes: [{ agent_id: 'a1' }],
      });
    } finally {
      await adapter.close();
      for (const s of accepted) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }
  });
});

// #task:1486 — the live connection's advertised capabilities are recorded from
// the daemon's `ready` frame and MUST be generation-local: a replaced daemon
// (reconnect) starts with an empty set until IT re-declares, so a stale
// capability can never authorize a send to a daemon that no longer supports it.
describe('EmbeddedUnixOutboundFrameAdapter capability recording', () => {
  function readyFrame(capabilities: string[]): string {
    return (
      JSON.stringify({
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'ready',
        protocol_version: OUTBOUND_PROTOCOL_VERSION,
        daemon_version: 'test',
        daemon_id: 'local',
        instance_id: 'inst-1',
        host_descriptor: { name: 'local', kind: 'local' },
        capabilities,
        daemon_pid: 4242,
        started_at: 1717000000,
      }) + '\n'
    );
  }

  it('records ready capabilities and clears them on disconnect / reconnect', async () => {
    const socketPath = join(
      tmpdir(),
      `sh-d5a-cap-${process.pid}-${++socketSeq}.sock`,
    );
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const accepted: Socket[] = [];
    let pendingAccept: ((s: Socket) => void) | null = null;
    const acceptQueue: Socket[] = [];
    const server: NetServer = createServer(sock => {
      accepted.push(sock);
      if (pendingAccept) {
        const resolve = pendingAccept;
        pendingAccept = null;
        resolve(sock);
      } else {
        acceptQueue.push(sock);
      }
    });
    const nextAccepted = (): Promise<Socket> => {
      const queued = acceptQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolve => {
        pendingAccept = resolve;
      });
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const hostId = 'local';
    const adapter = new EmbeddedUnixOutboundFrameAdapter({
      socketPath,
      hostId,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      const firstAccept = nextAccepted();
      await adapter.connect();
      const firstSocket = await firstAccept;

      // Before ready: attached but no capabilities advertised yet.
      expect(adapter.getAttachment(hostId)?.capabilities).toEqual([]);

      firstSocket.write(readyFrame(['runtime.codex.reasoning.v1']));
      await waitFor(
        () =>
          adapter
            .getAttachment(hostId)
            ?.capabilities.includes('runtime.codex.reasoning.v1') ?? false,
      );

      // Drop the connection: the replaced generation must NOT inherit the cap.
      firstSocket.destroy();
      const secondSocket = await nextAccepted();
      await waitFor(() => {
        const att = adapter.getAttachment(hostId);
        return att !== null && !att.capabilities.includes('runtime.codex.reasoning.v1');
      });
      expect(adapter.getAttachment(hostId)?.capabilities).toEqual([]);
      // The new generation re-declares its own — narrower — set.
      secondSocket.write(readyFrame(['runtime.claude']));
      await waitFor(
        () =>
          adapter.getAttachment(hostId)?.capabilities.includes('runtime.claude') ??
          false,
      );
      expect(
        adapter.getAttachment(hostId)?.capabilities.includes('runtime.codex.reasoning.v1'),
      ).toBe(false);
    } finally {
      await adapter.close();
      for (const s of accepted) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }
  });
});

// #task:2043 (B) — availability invalidation must fire on the embedded
// transport too (the desktop local agent's host — sea's most common shape).
// Availability reads `connectionIdForHost` on THIS adapter, so the invalidation
// seam must fire on exactly the edges where that value flips: a `connect()`
// that mints a connection id (attach), and every `onSocketClosed` that clears
// it (detach — covering socket drop, error, heartbeat timeout, and reconnect).
describe('EmbeddedUnixOutboundFrameAdapter availability seam (#task:2043 B)', () => {
  it('fires onHostAttachmentChanged on connect, disconnect, and reconnect', async () => {
    const socketPath = join(
      tmpdir(),
      `sh-d5a-avail-${process.pid}-${++socketSeq}.sock`,
    );
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const accepted: Socket[] = [];
    let pendingAccept: ((s: Socket) => void) | null = null;
    const acceptQueue: Socket[] = [];
    const server: NetServer = createServer(sock => {
      accepted.push(sock);
      if (pendingAccept) {
        const resolve = pendingAccept;
        pendingAccept = null;
        resolve(sock);
      } else {
        acceptQueue.push(sock);
      }
    });
    const nextAccepted = (): Promise<Socket> => {
      const queued = acceptQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolve => {
        pendingAccept = resolve;
      });
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const hostId = 'local';
    const attachmentEvents: string[] = [];
    const adapter = new EmbeddedUnixOutboundFrameAdapter({
      socketPath,
      hostId,
      onHostAttachmentChanged: id => attachmentEvents.push(id),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      // Nothing before the first dial: an adapter that never attached
      // announces no reachability change.
      expect(attachmentEvents).toEqual([]);

      const firstAccept = nextAccepted();
      await adapter.connect();
      await firstAccept;
      // Attach edge: exactly one fire, carrying the host id.
      await waitFor(() => attachmentEvents.length === 1);
      expect(attachmentEvents).toEqual([hostId]);

      // Drop the socket → detach edge fires; the auto-reconnect re-enters
      // `connect()` → attach edge fires again. Three fires total proves the
      // detach edge is real (without it a drop+reconnect would only yield 2).
      accepted[0]?.destroy();
      await nextAccepted();
      await waitFor(() => attachmentEvents.length === 3);
      expect(attachmentEvents).toEqual([hostId, hostId, hostId]);
      expect(adapter.connectionIdForHost(hostId)).toMatch(
        /^embedded-unix-local-conn-/,
      );
    } finally {
      await adapter.close();
      for (const s of accepted) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }
  });
});

class EmbeddedFakeDaemon implements FakeDaemonConnection {
  readonly connectionId: string;
  private buffer = '';
  private readonly queue: FakeDaemonCommand[] = [];
  private waiter: ((cmd: FakeDaemonCommand) => void) | null = null;

  constructor(
    private readonly socket: Socket,
    connectionId: string,
  ) {
    this.connectionId = connectionId;
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { frames, leftover } = splitNdjson(this.buffer, text);
      this.buffer = leftover;
      for (const line of frames) {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame.type !== 'command') continue;
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
    this.writeFrame({
      direction: 'daemon_to_server',
      type: 'command_response',
      id,
      kind,
      result,
    });
  }

  respondError(
    id: string,
    kind: string,
    error: { code: string; message: string },
  ): void {
    // Raw write — deliberately NOT validated, so adversarial / foreign
    // codes reach the adapter under test.
    this.writeFrame({
      direction: 'daemon_to_server',
      type: 'command_response',
      id,
      kind,
      error,
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>(resolve => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.end();
      const timer = setTimeout(() => this.socket.destroy(), 100);
      timer.unref?.();
    });
  }

  private writeFrame(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}
