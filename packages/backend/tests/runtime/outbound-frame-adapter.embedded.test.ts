import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitNdjson } from '@silverhand/host';
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
