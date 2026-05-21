/**
 * Unix-domain-socket server that exposes the daemon's intent surface
 * to in-process callers (electron main, dev:headless backend).
 *
 * Why Unix socket + not loopback TCP:
 *
 *  - macOS only target. Unix sockets here are first-class.
 *  - No port allocation / collision worry between dev runs.
 *  - Filesystem permissions give us a free authorization perimeter:
 *    the socket is created with `mode 0o600`, so only the user that
 *    spawned the daemon can connect. (Backend / Electron main run in
 *    the same uid, so they have access; another user on a shared
 *    machine cannot impersonate the parent.)
 *
 * Multi-connection model:
 *
 *  - The server accepts an unbounded number of concurrent connections.
 *    Each connection runs its own NDJSON splitter and intent loop.
 *    Backend opens one persistent connection; tests may open several.
 *  - There is no per-connection authentication beyond filesystem
 *    permissions in PR-1. PR-2 will add an optional bearer token when
 *    remote-host adapters land.
 *
 * Lifecycle:
 *
 *  - `start()` binds the socket and resolves once it's listening.
 *    `unlinkSync` is called first to clear a stale socket file from a
 *    crashed prior daemon (the file lingers if the prior process did
 *    not `close()` cleanly). This is safe because the pid file (handled
 *    by lifecycle.ts) guarantees only one daemon owns the path.
 *  - `stop()` marks the dispatcher as shutting down, broadcasts the
 *    `shutting_down` event to every live connection, then closes the
 *    server. In-flight intents finish; new ones see `shutting_down`.
 */
import { Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import {
  AnyFrameSchema,
  encodeFrame,
  splitNdjson,
  type EventFrame,
  type ResponseFrame,
} from '../protocol.js';
import type { IntentDispatcher } from './dispatcher.js';
import type { DaemonLogger } from './logger.js';
import { DAEMON_VERSION } from './version.js';

export interface DaemonServerOptions {
  socketPath: string;
  dispatcher: IntentDispatcher;
  logger: DaemonLogger;
}

export class DaemonServer {
  private readonly socketPath: string;
  private readonly dispatcher: IntentDispatcher;
  private readonly logger: DaemonLogger;
  private readonly server: Server;
  private readonly liveSockets = new Set<Socket>();

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath;
    this.dispatcher = opts.dispatcher;
    this.logger = opts.logger;
    this.server = new Server(socket => this.handleConnection(socket));
  }

  /** Bind the socket. Resolves once the server is listening. */
  async start(): Promise<void> {
    // Stale socket file from a crashed prior daemon would cause `listen`
    // to throw EADDRINUSE. Safe to unlink because the pid file (owned
    // by lifecycle.ts) is the single source of truth for "is a daemon
    // already running" — by the time we get here, that check has
    // already passed.
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        this.logger.warn(
          { socketPath: this.socketPath, err: (err as Error).message },
          'failed to remove stale socket file; listen may fail',
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    // Tighten the socket so peers under a different uid (or compromised
    // helper processes running as another user on a shared machine)
    // cannot connect. Best-effort; on filesystems that don't support
    // chmod for sockets (rare on macOS) we just log.
    try {
      chmodSync(this.socketPath, 0o600);
    } catch (err) {
      this.logger.warn(
        { socketPath: this.socketPath, err: (err as Error).message },
        'failed to chmod socket; peers may have wider access than intended',
      );
    }
    this.logger.info(
      { socketPath: this.socketPath },
      'daemon socket listening',
    );
  }

  /** Mark dispatcher as draining, broadcast event, close connections. */
  async stop(reason: string): Promise<void> {
    this.dispatcher.markShuttingDown();
    const event: EventFrame = { event: 'shutting_down', reason };
    const encoded = encodeFrame(event);
    for (const socket of this.liveSockets) {
      try {
        socket.write(encoded);
      } catch {
        /* peer already gone — ignore */
      }
    }
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      for (const socket of this.liveSockets) {
        socket.end();
      }
    });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* unlink failure on shutdown is not fatal */
      }
    }
    this.logger.info({ reason }, 'daemon socket closed');
  }

  private handleConnection(socket: Socket): void {
    this.liveSockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      // setEncoding('utf8') gives string chunks, but Node's type defs
      // still type `data` as Buffer; coerce defensively.
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { frames, leftover, overflow } = splitNdjson(buffer, text);
      buffer = leftover;
      if (overflow) {
        this.logger.warn({}, 'connection sent oversize frame; closing');
        socket.destroy();
        return;
      }
      for (const line of frames) {
        void this.handleLine(socket, line);
      }
    });
    socket.on('error', err => {
      this.logger.warn(
        { err: err.message, code: (err as NodeJS.ErrnoException).code },
        'connection error',
      );
    });
    socket.on('close', () => {
      this.liveSockets.delete(socket);
    });
    // Emit a `ready`-shaped event per connection so a fresh client
    // can confirm protocol version without a round trip. The spawn
    // helper relies on the stdout handshake instead (set up in
    // `daemon/entry.ts`); this is a belt-and-suspenders for direct
    // socket consumers (tests, future remote-host probes).
    socket.write(
      encodeFrame({
        event: 'ready',
        socket_path: this.socketPath,
        daemon_pid: process.pid,
        daemon_version: DAEMON_VERSION,
        started_at: this.dispatcher.getStartedAt(),
      }),
    );
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Malformed JSON: the peer is broken. We can't extract a request
      // id to reply against; close the connection to surface the bug.
      this.logger.warn(
        { err: (err as Error).message, line: line.slice(0, 120) },
        'failed to parse frame as JSON; closing connection',
      );
      socket.destroy();
      return;
    }
    const validated = AnyFrameSchema.safeParse(parsed);
    if (!validated.success || !('intent' in validated.data)) {
      this.logger.warn(
        {
          err: validated.success
            ? 'expected request frame'
            : validated.error.errors.map(e => e.message).join('; '),
        },
        'invalid frame; ignoring',
      );
      return;
    }
    const request = validated.data;
    const response: ResponseFrame = await this.dispatcher.dispatch(
      request.id,
      request.intent,
      request.params,
    );
    try {
      socket.write(encodeFrame(response));
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, id: request.id },
        'failed to write response; peer likely closed',
      );
    }
  }

  /** Test/debug helper: number of currently-open connections. */
  liveConnectionCount(): number {
    return this.liveSockets.size;
  }
}
