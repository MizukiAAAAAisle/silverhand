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
 *   - run an app-level heartbeat (local liveness is socket close events
 *     only — design §4.4). Inbound heartbeat frames are tolerated and
 *     ignored so a future heartbeat-enabled client does not trip the
 *     protocol-violation path.
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
import type { DaemonLogger } from './logger.js';
import {
  toOutboundCommandResponse,
  toOutboundEventFrame,
  type OutboundCommandDispatcher,
} from './outbound-frame-mapping.js';
import {
  DEFAULT_OUTBOUND_WRITE_BUFFER,
  OutboundWriteBuffer,
  eventMetadata,
  unixSocketFrameWriter,
  type OutboundWriteBufferOptions,
} from './outbound-write-buffer.js';

/**
 * Default local outbound socket path: `~/.silverhand/run/daemon-outbound.sock`
 * (design §4.1). Kept separate from the control socket so local-control
 * IPC and the formal outbound envelope are physically isolated.
 */
export function deriveLocalOutboundFrameSocketPath(home = homedir()): string {
  return join(home, '.silverhand', 'run', 'daemon-outbound.sock');
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
  private readonly logger: DaemonLogger;
  private readonly server: Server;
  private readonly liveSockets = new Set<Socket>();
  /**
   * One bounded write buffer per live connection. The standalone WSS
   * client has exactly one connection and one buffer; the local server
   * can hold several, so each socket gets its own pending-byte/frame
   * accounting, forgotten on close.
   */
  private readonly writeBuffers = new WeakMap<Socket, OutboundWriteBuffer>();
  private readonly writeBufferOptions: OutboundWriteBufferOptions;

  constructor(opts: LocalOutboundFrameServerOptions) {
    this.socketPath = opts.socketPath;
    this.dispatchCommand = opts.dispatchCommand;
    this.logger = opts.logger;
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
      const buffer = this.writeBuffers.get(socket);
      if (!buffer) continue;
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
  }

  private handleConnection(socket: Socket): void {
    this.liveSockets.add(socket);
    this.writeBuffers.set(
      socket,
      new OutboundWriteBuffer(this.writeBufferOptions, 'local_outbound'),
    );
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

    // Tolerate (and ignore) heartbeat frames so a future heartbeat-enabled
    // client does not trip the protocol-violation path. The local
    // transport itself runs no app-level heartbeat (design §4.4).
    if (OutboundHeartbeatFrameSchema.safeParse(parsed).success) {
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
    this.logger.info(
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
      const dispatched = await this.dispatchCommand(command);
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
