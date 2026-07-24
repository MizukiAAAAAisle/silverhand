/**
 * D5.a-2 — daemon-side local outbound frame server.
 *
 * The embedded deployment runs the backend in the same process tree as
 * the daemon. Before D5.a the backend reached the daemon through
 * `HostClient` over the local control socket, speaking the local IPC
 * `{id, intent, params}` protocol — a SECOND expression of the same
 * server↔daemon semantics, the R4 drift D5.a closes.
 *
 * This server is the daemon end of the unified path. It listens on a
 * SEPARATE Unix socket (`daemon-outbound.sock`, never multiplexed with
 * the control socket — see design §4.1) and speaks the EXACT outbound
 * frame envelope the standalone WSS client speaks:
 *
 *   - inbound: `OutboundServerToDaemonCommandFrame` (NDJSON);
 *   - outbound responses: `OutboundDaemonToServerCommandResponseFrame`;
 *   - outbound events: `OutboundDaemonToServerEventFrame`.
 *
 * It reuses the SAME dispatcher (`IntentDispatcher` via the injected
 * `dispatchCommand`) and the SAME mapping helpers
 * (`toOutboundCommandResponse` / `toOutboundEventFrame`) as the WSS
 * client, so the wire envelope and per-command error scoping cannot
 * drift between transports.
 *
 * What it deliberately does NOT do:
 *   - own DB state or route-level ACL (the backend still owns placement
 *     and ownership checks — design §4.2);
 *   - authenticate with a bearer token (same-uid local socket + mode
 *     0o600 is the perimeter — design §4.4);
 *   - initiate an app-level heartbeat. #task:1588 slice 2: the BACKEND
 *     adapter initiates pings on this transport and this server answers
 *     with pongs, so `available` means "recently responsive" on both
 *     transports; the daemon side still never pings.
 *
 * Security posture mirrors the WSS server and the embedded adapter: an
 * inbound frame that is not a valid `server_to_daemon` command (or
 * heartbeat) is a PROTOCOL VIOLATION — the connection is dropped. The
 * backend cannot smuggle a malformed command into the dispatcher.
 */
import { Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  OutboundServerToDaemonCommandFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundFrameSchema,
  encodeOutboundFrame,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundServerToDaemonCommandFrame,
} from '../outbound-protocol.js';
import { MAX_FRAME_BYTES, splitNdjson, type EventFrame } from '../protocol.js';
import type { OutboundDaemonToServerEventFrame } from '../outbound-protocol.js';
import type { DaemonLogger } from './logger.js';
import {
  toOutboundCommandResponse,
  toOutboundEventFrame,
  type OutboundCommandDispatcher,
  type OwnerCleanup,
} from './outbound-frame-mapping.js';
import {
  DEFAULT_OUTBOUND_WRITE_BUFFER,
  OutboundWriteBuffer,
  eventMetadata,
  unixSocketFrameWriter,
  type OutboundWriteBufferOptions,
} from './outbound-write-buffer.js';
import {
  resolveDesktopAppPaths,
  defaultAppRoot,
} from '@silverhand/shared/app-data-layout';
import { resolveDeliveryOwner } from './supervisor-contract.js';

/**
 * Default local outbound socket path: `~/.silverhand/run/daemon-outbound.sock`
 * (design §4.1). Kept separate from the control socket so local-control
 * IPC and the formal outbound envelope are physically isolated.
 */
export function deriveLocalOutboundFrameSocketPath(home = homedir()): string {
  // #task:1598/#task:1603 — delegate to the shared app-data path
  // authority; env-AWARE since the v2 cutover (contract §8). The `home`
  // seam keeps the historical test signature.
  return resolveDesktopAppPaths(defaultAppRoot(process.env, () => home), 'legacy-v1')
    .run.outboundSocket;
}

export interface LocalOutboundFrameServerOptions {
  socketPath: string;
  /**
   * Routes an inbound command frame into the daemon's intent dispatcher.
   * MUST be the same forwarder the standalone outbound WSS client uses
   * (`run.ts` wires both to `dispatcher.dispatch`), so embedded and
   * standalone share one dispatch path.
   */
  dispatchCommand: OutboundCommandDispatcher;
  logger: DaemonLogger;
  /**
   * Owner-scoped deferred-queue cleanup (#task:1417 Stage 3, §11.4.1).
   * Invoked with this connection's minted owner token on socket close so
   * the daemon discards ONLY this connection's queued deferred deliveries
   * (the backend rolls the matching in-flight rows back to pending;
   * reconnect replay re-drives them, duplicate-free because nothing was
   * written). One owner per accepted socket — see {@link socketOwners}.
   */
  cleanupDeferredForOwner: OwnerCleanup;
  /**
   * D5.a-3 P1-1 — connection-scoped handshake. When set, the server
   * writes ONE `ready` event to each NEW connection immediately on
   * accept, mapped through {@link toOutboundEventFrame} (which strips
   * the daemon-local `socket_path` and stamps the outbound protocol
   * version). This mirrors the standalone WSS client, which sends
   * `readyEvent()` on `ws.open` — the embedded backend's adapter
   * needs the same `ready` to latch the daemon key and fire its
   * fanout hydrate. Unlike {@link broadcast}, the handshake targets
   * ONLY the accepting socket (a late joiner must not replay another
   * connection's handshake), and `ready` is non-droppable: if it
   * overflows the fresh buffer the connection is torn down rather
   * than left un-hydrated.
   */
  readyEvent?: () => Extract<EventFrame, { event: 'ready' }>;
  /**
   * Per-connection bounded write-buffer caps. Defaults to the same
   * 1024-frame / 4 MiB policy the standalone WSS path uses
   * ({@link DEFAULT_OUTBOUND_WRITE_BUFFER}); tests trim it to force the
   * drop / overflow-close paths without MiB of fixture bytes.
   */
  writeBuffer?: Partial<OutboundWriteBufferOptions>;
}

export class LocalOutboundFrameServer {
  private readonly socketPath: string;
  private readonly dispatchCommand: OutboundCommandDispatcher;
  private readonly cleanupDeferredForOwner: OwnerCleanup;
  private readonly logger: DaemonLogger;
  private readonly readyEvent?: () => Extract<EventFrame, { event: 'ready' }>;
  private readonly server: Server;
  private readonly liveSockets = new Set<Socket>();
  /**
   * One bounded write buffer per live connection. The standalone WSS
   * client has exactly one connection and one buffer; the local server
   * can hold several, so each socket gets its own pending-byte/frame
   * accounting, forgotten on close.
   */
  private readonly writeBuffers = new WeakMap<Socket, OutboundWriteBuffer>();
  /**
   * One delivery-owner token per accepted connection (#task:1417 Stage 3,
   * §11.4.1). Minted on accept, threaded into every dispatched command's
   * {@link DeliveryOwnerContext}, and handed to
   * {@link cleanupDeferredForOwner} on close so the daemon discards only
   * this connection's queued deferred deliveries. Non-wire and
   * dispatcher-injected — a peer cannot spoof another connection's owner.
   */
  private readonly socketOwners = new WeakMap<Socket, string>();
  private ownerSeq = 0;
  private readonly writeBufferOptions: OutboundWriteBufferOptions;

  constructor(opts: LocalOutboundFrameServerOptions) {
    this.socketPath = opts.socketPath;
    this.dispatchCommand = opts.dispatchCommand;
    this.cleanupDeferredForOwner = opts.cleanupDeferredForOwner;
    this.logger = opts.logger;
    this.readyEvent = opts.readyEvent;
    this.writeBufferOptions = {
      ...DEFAULT_OUTBOUND_WRITE_BUFFER,
      ...(opts.writeBuffer ?? {}),
    };
    this.server = new Server(socket => this.handleConnection(socket));
  }

  /** Bind the socket. Resolves once listening; tightens mode to 0o600. */
  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        this.logger.warn(
          { socketPath: this.socketPath, err: (err as Error).message },
          'local outbound: failed to remove stale socket file; listen may fail',
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
    try {
      chmodSync(this.socketPath, 0o600);
    } catch (err) {
      this.logger.warn(
        { socketPath: this.socketPath, err: (err as Error).message },
        'local outbound: failed to chmod socket; peers may have wider access than intended',
      );
    }
    this.logger.info(
      { socketPath: this.socketPath },
      'local outbound frame socket listening',
    );
  }

  async stop(): Promise<void> {
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
    this.logger.info(
      { socketPath: this.socketPath },
      'local outbound frame socket closed',
    );
  }

  liveConnectionCount(): number {
    return this.liveSockets.size;
  }

  /**
   * Broadcast a daemon event to every live backend connection, mapped to
   * the outbound event envelope. Wired into `run.ts`'s broadcaster beside
   * `DaemonServer.broadcast` + `outboundSupervisor.sendEvent`, so a single
   * daemon event reaches the control socket, the standalone WSS, AND the
   * embedded backend with the identical outbound envelope.
   *
   * Each connection writes through its own bounded {@link OutboundWriteBuffer}
   * — the SAME backpressure policy the standalone WSS path applies:
   * `runtime_output` is dropped at the cap (connection stays open); any
   * other event overflowing the cap closes that connection rather than
   * letting the daemon grow an unbounded write queue against a slow/stuck
   * backend (P1-2 transport parity).
   */
  broadcast(event: EventFrame): void {
    if (this.liveSockets.size === 0) return;
    const frame = toOutboundEventFrame(event);
    const metadata = eventMetadata(event);
    for (const socket of this.liveSockets) {
      if (socket.destroyed) continue;
      this.sendEventToSocket(socket, frame, metadata);
    }
  }

  /**
   * Write one already-mapped outbound event frame to a single socket
   * through its bounded {@link OutboundWriteBuffer}. Shared by
   * {@link broadcast} (fan-out to every live connection) and the
   * connection-scoped `ready` handshake. On a non-droppable overflow
   * the socket is destroyed rather than letting the daemon grow an
   * unbounded write queue against a slow/stuck backend (P1-2 parity).
   */
  private sendEventToSocket(
    socket: Socket,
    frame: OutboundDaemonToServerEventFrame,
    metadata: ReturnType<typeof eventMetadata>,
  ): void {
    const buffer = this.writeBuffers.get(socket);
    if (!buffer) return;
    const result = buffer.send({
      writer: unixSocketFrameWriter(socket),
      frame,
      metadata,
      logger: this.logger,
    });
    if (result === 'overflow') {
      this.logger.warn(
        {
          kind: 'local_outbound',
          action: 'buffer_overflow_close',
          event_kind: metadata.kind,
          conversation_id: metadata.conversation_id,
          agent_id: metadata.agent_id,
          ts: metadata.ts,
          pending_frames: buffer.pendingFrames,
          pending_bytes: buffer.pendingBytes,
        },
        'local outbound buffer overflow on non-droppable event; closing connection',
      );
      socket.destroy();
    }
  }

  private handleConnection(socket: Socket): void {
    this.liveSockets.add(socket);
    // Mint this connection's delivery-owner token (#task:1417 Stage 3,
    // §11.4.1). Threaded into every dispatched command's ctx and used to
    // scope deferred-queue cleanup on close.
    const owner = `local:${++this.ownerSeq}`;
    this.socketOwners.set(socket, owner);
    this.writeBuffers.set(
      socket,
      new OutboundWriteBuffer(this.writeBufferOptions, 'local_outbound'),
    );
    // D5.a-3 P1-1 — connection-scoped handshake. Emit ONE `ready`
    // to just-accepted socket (never a broadcast) so the embedded
    // backend's adapter latches the daemon key and triggers its
    // fanout hydrate, exactly as the standalone WSS client does on
    // `ws.open`. `ready` is non-droppable: an overflow here tears the
    // fresh connection down rather than leaving it un-hydrated.
    if (this.readyEvent) {
      const ready = this.readyEvent();
      this.sendEventToSocket(
        socket,
        toOutboundEventFrame(ready),
        eventMetadata(ready),
      );
    }
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const { frames, leftover, overflow } = splitNdjson(buffer, text);
      buffer = leftover;
      if (overflow) {
        this.logger.warn(
          { socketPath: this.socketPath },
          `local outbound: inbound frame exceeded MAX_FRAME_BYTES=${MAX_FRAME_BYTES}; closing`,
        );
        socket.destroy();
        return;
      }
      for (const line of frames) {
        // P1-1 admission gate: a protocol violation in one line tears down
        // the connection synchronously and returns false. Stop processing
        // the rest of THIS chunk so a valid command queued behind an
        // invalid frame is never dispatched on an already-violated
        // connection. (`socket.destroyed` also guards the case where an
        // async command handler tore the socket down between lines.)
        if (!this.handleLine(socket, line) || socket.destroyed) break;
      }
    });
    socket.on('error', err => {
      this.logger.warn(
        { err: err.message, code: (err as NodeJS.ErrnoException).code },
        'local outbound: connection error',
      );
    });
    socket.on('close', () => {
      this.liveSockets.delete(socket);
      // Forget per-socket buffer state on close (the WeakMap entry would be
      // GC'd anyway once the socket is unreferenced; delete eagerly).
      this.writeBuffers.delete(socket);
      // Owner-scoped deferred cleanup (#task:1417 Stage 3, §11.4.1): the
      // daemon discards only THIS connection's queued deliveries; the
      // backend rolls the matching in-flight rows back to pending so a
      // reconnect replay re-drives them, duplicate-free.
      const owner = this.socketOwners.get(socket);
      if (owner) {
        this.socketOwners.delete(socket);
        this.cleanupDeferredForOwner(owner);
      }
    });
  }

  /**
   * Synchronous admission gate. Returns false (and tears the connection
   * down) on any protocol violation; true if the frame was accepted (a
   * command is dispatched asynchronously, a heartbeat is ignored). Keeping
   * this synchronous is what lets {@link handleConnection}'s per-line loop
   * stop dispatching after a violation — an async gate could not signal the
   * loop in time.
   */
  private handleLine(socket: Socket, line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Redaction contract (mirrors DaemonServer §3.4): never log the raw
      // line — it may carry payload bytes that never reached zod. Log
      // structured fields only.
      this.logger.warn(
        {
          kind: 'local_outbound',
          action: 'frame_parse_failed',
          line_bytes: Buffer.byteLength(line, 'utf8'),
          parse_error: (err as Error).message,
        },
        'local outbound: failed to parse frame as JSON; closing connection',
      );
      socket.destroy();
      return false;
    }

    const command = OutboundServerToDaemonCommandFrameSchema.safeParse(parsed);
    if (command.success) {
      void this.handleCommand(socket, command.data);
      return true;
    }

    // #task:1588 slice 2 — answer the backend adapter's heartbeat ping
    // with a pong (WSS parity: same contract as the daemon's outbound
    // WS client). A pong arriving here is tolerated and ignored — the
    // daemon side initiates no pings on the local transport.
    const heartbeat = OutboundHeartbeatFrameSchema.safeParse(parsed);
    if (heartbeat.success) {
      if (heartbeat.data.kind === 'ping' && !socket.destroyed) {
        try {
          socket.write(
            `${encodeOutboundFrame({
              direction: 'daemon_to_server',
              type: 'heartbeat',
              kind: 'pong',
              ts: Date.now(),
              echo_ts: heartbeat.data.ts,
            })}\n`,
          );
        } catch (err) {
          this.logger.warn(
            {
              kind: 'local_outbound',
              action: 'heartbeat_pong_failed',
              err: (err as Error).message,
            },
            'local outbound: heartbeat pong write failed',
          );
        }
      }
      return true;
    }

    // Anything else — including a daemon_to_server frame arriving on the
    // server's inbound path, or a command carrying params the per-command
    // schema rejects — is a protocol violation. Drop the connection;
    // never feed an unvalidated frame to the dispatcher.
    const anyFrame = OutboundFrameSchema.safeParse(parsed);
    this.logger.warn(
      {
        kind: 'local_outbound',
        action: 'frame_invalid',
        err: anyFrame.success ? 'wrong_direction_or_type' : 'schema_mismatch',
        issue_count: command.error.errors.length,
        issue_paths: command.error.errors.map(e => e.path.join('.')),
      },
      'local outbound: invalid inbound frame; closing connection',
    );
    socket.destroy();
    return false;
  }

  private async handleCommand(
    socket: Socket,
    command: OutboundServerToDaemonCommandFrame,
  ): Promise<void> {
    const successLevel = command.kind === 'host_status' ? 'debug' : 'info';
    this.logger[successLevel](
      {
        kind: 'local_outbound',
        action: 'command_received',
        command_kind: command.kind,
        request_id: command.id,
      },
      'local outbound command received',
    );
    let response: OutboundDaemonToServerCommandResponseFrame;
    try {
      // Thread this connection's owner into the delivery context so a
      // `deferred` disposition is attributed to the right connection and
      // cleaned up if it drops (#task:1417 Stage 3, §11.4.1). Owner is
      // minted at accept before any command is read; a missing owner is a
      // broken-connection invariant, so `resolveDeliveryOwner` throws
      // rather than guess a sentinel that close cleanup could never
      // reclaim — the catch below maps it to internal_error and
      // dispatchCommand is never called under a bad owner.
      const owner = resolveDeliveryOwner(
        this.socketOwners.get(socket),
        'local_outbound',
      );
      const dispatched = await this.dispatchCommand(command, { owner });
      const mapped = toOutboundCommandResponse(command, dispatched);
      response = mapped.frame;
      if (mapped.drift) {
        this.logger.warn(
          {
            kind: 'local_outbound',
            action: 'command_response_shape_drift',
            command_kind: command.kind,
            request_id: command.id,
            response_summary: mapped.drift.summary,
            issues: mapped.drift.issues,
          },
          'local outbound command response shape drift; returning internal_error',
        );
      }
    } catch (err) {
      response = {
        direction: 'daemon_to_server',
        type: 'command_response',
        id: command.id,
        kind: command.kind,
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        },
      } as OutboundDaemonToServerCommandResponseFrame;
    }

    let encoded: string;
    try {
      encoded = `${encodeOutboundFrame(response)}\n`;
    } catch (err) {
      this.logger.warn(
        {
          kind: 'local_outbound',
          action: 'command_response_encode_failed',
          command_kind: command.kind,
          request_id: command.id,
          err: (err as Error).message,
        },
        'local outbound command response encode failed; closing connection',
      );
      socket.destroy();
      return;
    }
    if (socket.destroyed) {
      this.logger.warn(
        {
          kind: 'local_outbound',
          action: 'command_response_disconnected',
          command_kind: command.kind,
          request_id: command.id,
        },
        'local outbound command response dropped because socket is disconnected',
      );
      return;
    }
    socket.write(encoded);
  }
}
