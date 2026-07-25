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
import { resolveDeliveryOwner } from './supervisor-contract.js';
import type { DeliveryOwnerContext } from './supervisor-contract.js';
import {
  OutputBackpressure,
  type OutputBackpressureOptions,
} from './output-backpressure.js';
import { logBackpressure, logEvent } from './daemon-logging.js';

export interface DaemonServerOptions {
  socketPath: string;
  dispatcher: IntentDispatcher;
  logger: DaemonLogger;
  /** Override OutputBackpressure thresholds — production uses defaults
   *  (4 MiB / 2 MiB); tests trim the cap to a few KiB to drive drop
   *  paths without 4 MiB of fixture bytes. */
  backpressure?: OutputBackpressureOptions;
}

export class DaemonServer {
  private readonly socketPath: string;
  private readonly dispatcher: IntentDispatcher;
  private readonly logger: DaemonLogger;
  private readonly server: Server;
  private readonly liveSockets = new Set<Socket>();
  /**
   * One delivery-owner token per accepted control connection (#task:1417
   * Stage 3, §11.4.1). Minted on accept, threaded into every dispatched
   * command's {@link DeliveryOwnerContext}, and handed to the dispatcher's
   * owner-scoped deferred cleanup on close. Non-wire / dispatcher-injected
   * so a peer cannot spoof another connection's owner.
   */
  private readonly socketOwners = new WeakMap<Socket, string>();
  private ownerSeq = 0;
  private readonly backpressure: OutputBackpressure;

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath;
    this.dispatcher = opts.dispatcher;
    this.logger = opts.logger;
    this.backpressure = new OutputBackpressure({
      ...opts.backpressure,
      logDrop: opts.backpressure?.logDrop ?? (entry => {
        // §3.4 logging contract — structured fields only via the
        // typed `logBackpressure` helper. Per-chunk drops are noisy
        // under sustained pressure; we only log the FIRST drop in a
        // window (`dropped_count === 1`) plus the recovery summary.
        if (entry.kind === 'drop' && entry.dropped_count !== 1) return;
        logBackpressure(this.logger, {
          conversationId: entry.conversation_id,
          agent_id: entry.agent_id,
          action: 'dropped',
          buffer_bytes: entry.buffer_bytes,
          dropped_count: entry.dropped_count,
          bytes_dropped: entry.bytes_dropped,
        });
      }),
      // Cindy `POiN_oGtyDjr3Sni` note — runtime_output_dropped used to
      // bypass logEvent because OutputBackpressure wrote it directly
      // to the socket from emitSummary. Wire the summary through the
      // structured event log so every emitted event (even per-socket
      // ones) shows up alongside broadcast events.
      onSummaryEvent: opts.backpressure?.onSummaryEvent ?? (event => {
        logEvent(this.logger, {
          event: event.event,
          conversationId: 'conversation_id' in event ? event.conversation_id : undefined,
          agent_id: 'agent_id' in event ? event.agent_id : undefined,
          dropped_count:
            'dropped_count' in event ? event.dropped_count : undefined,
          bytes_dropped:
            'bytes_dropped' in event ? event.bytes_dropped : undefined,
        });
      }),
    });
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
    // Route through broadcast so the §3.4 event log line is emitted
    // (Cindy `POiN_oGtyDjr3Sni` note: previously this used a direct
    // socket.write loop and bypassed logEvent).
    this.broadcast(event);
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
    // Mint this connection's delivery-owner token (#task:1417 Stage 3,
    // §11.4.1); threaded into every dispatch ctx and used to scope
    // deferred-queue cleanup on close.
    this.socketOwners.set(socket, `control:${++this.ownerSeq}`);
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
      this.backpressure.forgetSocket(socket);
      // Owner-scoped deferred cleanup (#task:1417 Stage 3, §11.4.1): drop
      // only this connection's queued deliveries; the backend rolls the
      // matching in-flight rows back to pending so a reconnect replay
      // re-drives them, duplicate-free.
      const owner = this.socketOwners.get(socket);
      if (owner) {
        this.socketOwners.delete(socket);
        this.dispatcher.cleanupDeferredForOwner(owner);
      }
    });
    // Emit a `ready`-shaped event per connection so a fresh client
    // can confirm protocol version without a round trip. The spawn
    // helper relies on the stdout handshake instead (set up in
    // `daemon/entry.ts`); this is a belt-and-suspenders for direct
    // socket consumers (tests, future remote-host probes).
    socket.write(
      encodeFrame({
        event: 'ready',
        ...this.dispatcher.getHelloResult(),
        socket_path: this.socketPath,
        daemon_pid: process.pid,
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
      //
      // §3.4 contract (Cindy `9rxtrdT2NXfX2zEs`): the raw `line` MUST
      // NOT be logged — a malformed payload-bearing frame would leak
      // user/stdin bytes into the JSONL since this path never reaches
      // zod. Log structured fields only: byte size + parser error
      // class. The parser error message comes from
      // JSON.parse / V8 ("Unexpected token X at position N") and does
      // NOT echo the offending byte sequence.
      this.logger.warn(
        {
          kind: 'connection',
          action: 'frame_parse_failed',
          line_bytes: Buffer.byteLength(line, 'utf8'),
          parse_error: (err as Error).message,
        },
        'failed to parse frame as JSON; closing connection',
      );
      socket.destroy();
      return;
    }
    const validated = AnyFrameSchema.safeParse(parsed);
    if (!validated.success || !('intent' in validated.data)) {
      // Similar redaction concern: zod issue messages can sometimes
      // include offending values (e.g. union mismatches). Log only the
      // issue paths + types so we still get debug signal without
      // leaking field contents. `paths` are dot-joined field names
      // ('params.delivery_ids'), structurally safe.
      this.logger.warn(
        {
          kind: 'connection',
          action: 'frame_invalid',
          err: validated.success ? 'expected_request_frame' : 'schema_mismatch',
          issue_count: validated.success
            ? 0
            : validated.error.errors.length,
          issue_paths: validated.success
            ? undefined
            : validated.error.errors.map(e => e.path.join('.')),
        },
        'invalid frame; ignoring',
      );
      return;
    }
    const request = validated.data;
    // Thread this connection's owner into the delivery context so a
    // `deferred` disposition is attributed to the right connection and
    // cleaned up if it drops (#task:1417 Stage 3, §11.4.1). Owner is minted
    // at accept before any command is read; a missing owner is a broken-
    // connection invariant, not a normal case. `owner` is a load-bearing
    // custody key, not logging metadata — dispatching under a guessed
    // sentinel would enqueue a `deferred` entry this socket's close cleanup
    // can never reclaim, orphaning the DB row in-flight forever. Fail loud:
    // drop the connection rather than guess an owner.
    let owner: string;
    try {
      owner = resolveDeliveryOwner(this.socketOwners.get(socket), 'control');
    } catch (err) {
      this.logger.error(
        {
          kind: 'connection',
          action: 'owner_missing',
          id: request.id,
          err: (err as Error).message,
        },
        'control command with no minted delivery owner; closing connection',
      );
      socket.destroy();
      return;
    }
    // Control socket is the one ingress that can PROVE a response
    // transport handoff (#task:1614): it writes the response frame with a
    // completion callback below. Declared on the ctx so a handler whose
    // custody settlement depends on that proof (agent_stale_receive) can
    // proceed; all other intents ignore both fields.
    const ctx: DeliveryOwnerContext = { owner, supportsResponseHandoff: true };
    const response: ResponseFrame = await this.dispatcher.dispatch(
      request.id,
      request.intent,
      request.params,
      ctx,
    );
    const handoff = ctx.responseHandoff;
    if (handoff && 'error' in response) {
      // The peer receives an error frame — the content the handler
      // reserved was NOT delivered. Settle failed BEFORE writing so the
      // failure ordering cannot race the peer's retry.
      try {
        socket.write(encodeFrame(response));
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, id: request.id },
          'failed to write response; peer likely closed',
        );
      }
      handoff(false);
      return;
    }
    if (handoff) {
      // Proof point: the write callback fires once the frame is flushed
      // to the kernel (or errors). Exactly one invocation either way.
      // `err == null` IS the proof — Node invokes the callback with an
      // error (ERR_STREAM_DESTROYED and friends) when the socket dies
      // BEFORE the flush, so a null error means the bytes were handed
      // to the kernel. The peer closing immediately AFTER reading the
      // frame must NOT be read back as a pre-proof failure: a
      // `socket.destroyed` term here would restore + redeliver bodies
      // the peer already has (review round-3 note).
      try {
        socket.write(encodeFrame(response), err => {
          handoff(err == null);
        });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, id: request.id },
          'failed to write response; peer likely closed',
        );
        handoff(false);
      }
      return;
    }
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

  /**
   * Send an unsolicited event to every live connection. Routed through
   * `OutputBackpressure.emit()` so `runtime_output` frames participate
   * in the per-(conv, agent) 4 MiB cap (§2.2.2) while every other event
   * (control / lifecycle / drain readiness / startup delivery acks /
   * dropped-summary) writes straight through. Wire this as the
   * supervisor's `emit` callback in `runDaemon`.
   */
  broadcast(event: EventFrame): void {
    // §3.4 logging contract: log a structured `kind: 'event'` line
    // per emitted event, with allow-listed scalar fields only. Body
    // / chunk content NEVER appears.
    logEvent(this.logger, {
      event: event.event,
      conversationId: 'conversation_id' in event ? event.conversation_id : undefined,
      agent_id: 'agent_id' in event ? event.agent_id : undefined,
      delivery_ids: 'delivery_ids' in event ? event.delivery_ids : undefined,
      dropped_count:
        'dropped_count' in event ? event.dropped_count : undefined,
      bytes_dropped:
        'bytes_dropped' in event ? event.bytes_dropped : undefined,
    });
    for (const socket of this.liveSockets) {
      this.backpressure.emit(socket, event);
    }
  }
}
