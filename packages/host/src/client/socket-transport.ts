/**
 * Real Unix-socket transport. Wraps `node:net` so the HostClient never
 * imports node:net directly — that keeps the client testable against
 * the in-memory fake transport (`./in-memory-transport.ts`).
 *
 * Connection model:
 *
 *  - One transport == one in-flight Unix socket.
 *  - `connect()` opens a fresh socket; on success, resolves and
 *    starts forwarding decoded frames to `frame` subscribers.
 *  - `disconnect` fires once when the socket closes / errors. After
 *    that, the transport is "spent"; the client wraps it in a
 *    reconnect loop that re-creates the transport.
 *
 * Buffering:
 *
 *  - Each socket carries its own NDJSON splitter buffer. We do not
 *    re-use a buffer across reconnects; a new transport gets a fresh
 *    buffer to guarantee no half-line from the old socket bleeds
 *    into the new one.
 *
 * Errors that fire `disconnect`:
 *  - `end` (peer closed normally)
 *  - `close` (socket fully closed, after any error)
 *  - `error` (typed; we surface .code in the reason)
 *
 * `error` fires before `close`. We dedupe by remembering whether we
 * already emitted `disconnect` for this connection.
 */
import { Socket } from 'node:net';
import {
  LooseAnyFrameSchema,
  splitNdjson,
  type LooseResponseFrame,
  type EventFrame,
} from '../protocol.js';
import type { DecodedFrame, Transport, TransportEvents } from './transport.js';

export interface SocketTransportOptions {
  socketPath: string;
}

type Handler<K extends keyof TransportEvents> = TransportEvents[K];

export class SocketTransport implements Transport {
  private readonly socketPath: string;
  private socket: Socket | null = null;
  private connected = false;
  private disconnectFired = false;
  private buffer = '';
  private readonly handlers: {
    frame: Set<Handler<'frame'>>;
    disconnect: Set<Handler<'disconnect'>>;
    overflow: Set<Handler<'overflow'>>;
  } = {
    frame: new Set(),
    disconnect: new Set(),
    overflow: new Set(),
  };

  constructor(opts: SocketTransportOptions) {
    this.socketPath = opts.socketPath;
  }

  connect(): Promise<void> {
    if (this.socket) {
      throw new Error('transport already connected or in flight; create a new one');
    }
    const socket = new Socket();
    this.socket = socket;
    socket.setEncoding('utf8');
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        socket.off('connect', onConnect);
        this.fireDisconnect(`connect_failed:${(err as NodeJS.ErrnoException).code ?? err.message}`);
        reject(err);
      };
      const onConnect = (): void => {
        socket.off('error', onError);
        this.connected = true;
        this.attachStreamHandlers(socket);
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.connect(this.socketPath);
    });
  }

  write(encodedLine: string): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      // IMPORTANT: We intentionally discard `Socket.write()`'s boolean
      // return value. Node returns `false` from write() when the
      // internal buffer crosses `highWaterMark` — that's a
      // *backpressure* signal, NOT a failure. The bytes are still
      // queued and will reach the daemon in order; the daemon will
      // process the request and reply normally.
      //
      // The previous version propagated that `false` up to
      // `HostClient.call()`, which then deleted the pending entry and
      // rejected with `disconnected`. The daemon still answered, but
      // the client treated the (now legitimately late) response as a
      // duplicate to drop — so the caller saw a phantom failure on a
      // request that actually succeeded. PR-2's larger payloads
      // (`runtime_wake`, `runtime_start.startup_delivery`) would tip
      // into this corner constantly.
      //
      // True failure modes are still surfaced:
      //   - not connected            → handled by the early-return above
      //   - synchronous write throws → caught below
      //   - socket error/close       → fires `disconnect` separately
      //
      // When we actually need backpressure handling (PR-2+), the
      // right primitive is a `drain` listener on the transport that
      // pauses outgoing intent dispatch — not silently failing
      // individual writes.
      this.socket.write(encodedLine);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    try {
      socket.destroy();
    } catch {
      /* already destroyed */
    }
    this.fireDisconnect('local_close');
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    // Strongly-typed at the call site; the per-key sets each only ever
    // hold their own handler type. The cast is needed because TS can't
    // narrow the discriminant through the indexed property.
    (this.handlers[event] as Set<unknown>).add(handler);
    return () => {
      (this.handlers[event] as Set<unknown>).delete(handler);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private attachStreamHandlers(socket: Socket): void {
    socket.on('data', chunk => {
      // `setEncoding('utf8')` makes chunks arrive as strings, but
      // node's type defs still type `data` as `Buffer` — coerce
      // defensively in case anything ever upstream-toggles encoding.
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { frames, leftover, overflow } = splitNdjson(this.buffer, text);
      this.buffer = leftover;
      if (overflow) {
        for (const h of this.handlers.overflow) h();
        socket.destroy();
        return;
      }
      for (const line of frames) {
        this.deliverFrame(line);
      }
    });
    socket.once('end', () => this.fireDisconnect('peer_end'));
    socket.once('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      this.fireDisconnect(`socket_error:${code ?? err.message}`);
    });
    socket.once('close', () => this.fireDisconnect('socket_close'));
  }

  private deliverFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON from the daemon shouldn't happen unless we have
      // a protocol bug; drop silently here, the daemon side already
      // logs its outgoing frames.
      return;
    }
    const validated = LooseAnyFrameSchema.safeParse(parsed);
    if (!validated.success) return;
    if ('intent' in validated.data) {
      // Daemon should never send request frames; ignore.
      return;
    }
    const decoded: DecodedFrame = validated.data as LooseResponseFrame | EventFrame;
    for (const h of this.handlers.frame) h(decoded);
  }

  private fireDisconnect(reason: string): void {
    if (this.disconnectFired) return;
    this.disconnectFired = true;
    this.connected = false;
    for (const h of this.handlers.disconnect) h(reason);
  }
}
