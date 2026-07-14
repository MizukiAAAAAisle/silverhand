import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  DaemonHostConfigSchema,
  HOST_WS_CLOSE_REASON_DISCONNECTED,
  HOST_WS_CLOSE_REASON_REVOKED,
  apiPaths,
  classifyServerUrl,
  type DaemonHostConfig,
} from '@silverhand/shared';
import {
  OutboundFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  OutboundHeartbeatFrameSchema,
  encodeOutboundFrame,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundFrame,
  type OutboundHeartbeatFrame,
  type OutboundServerToDaemonCommandFrame,
  type RotateTokenParams,
  type RotateTokenResult,
} from '../outbound-protocol.js';
import type { EventFrame } from '../protocol.js';
import {
  toOutboundCommandResponse,
  toOutboundEventFrame,
  type OutboundCommandDispatcher,
  type OutboundDispatcherResponse,
  type OwnerCleanup,
} from './outbound-frame-mapping.js';
import {
  DEFAULT_OUTBOUND_WRITE_BUFFER,
  OutboundWriteBuffer,
  eventMetadata,
  webSocketFrameWriter,
  type OutboundEventMetadata,
  type OutboundWriteBufferOptions,
  type SendResult,
} from './outbound-write-buffer.js';
import type { DaemonLogger } from './logger.js';
import { resolveDeliveryOwner } from './supervisor-contract.js';

export interface OutboundDaemonClientOptions {
  /** Atomic daemon-config path used by app-managed desktop installs. */
  configPath?: string;
  /** In-memory config used by `silverhand-daemon connect`. The copied command
   *  carries the connect token every time, so the daemon must not persist a
   *  hidden local credential just to open the websocket. */
  config?: DaemonHostConfig;
  logger: DaemonLogger;
  readyEvent: () => Extract<EventFrame, { event: 'ready' }>;
  configPollMs?: number;
  backoff?: Partial<ReconnectBackoffOptions>;
  heartbeat?: Partial<HeartbeatOptions>;
  buffer?: Partial<OutboundWriteBufferOptions>;
  dispatchCommand?: OutboundCommandDispatcher;
  /**
   * Owner-scoped deferred-queue cleanup (#task:1417 Stage 3, §11.4.1).
   * Invoked with a WS-generation owner token when that connection closes
   * so the daemon discards only that connection's queued deferred
   * deliveries; the backend rolls the matching in-flight rows back to
   * pending and a reconnect replay re-drives them, duplicate-free.
   */
  cleanupDeferredForOwner?: OwnerCleanup;
  writeHostConfig?: HostConfigWriter;
  random?: () => number;
  now?: () => number;
}

/**
 * Re-exported from {@link ./outbound-frame-mapping.js} so existing
 * importers (`run.ts`, `outbound-supervisor.ts`) keep their import path.
 * The canonical definitions of {@link OutboundCommandDispatcher},
 * {@link OutboundDispatcherResponse}, and the command/event mapping
 * helpers now live in `outbound-frame-mapping.ts` and are shared by both
 * daemon outbound transports (standalone WSS + embedded local Unix), so
 * the wire envelope cannot drift between them.
 */
export type {
  OutboundCommandDispatcher,
  OutboundDispatcherResponse,
} from './outbound-frame-mapping.js';
export type HostConfigWriter = (path: string, config: DaemonHostConfig) => void;

export interface ReconnectBackoffOptions {
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterRatio: number;
}

export interface HeartbeatOptions {
  pingIntervalMs: number;
  pongTimeoutMs: number;
}

export type { OutboundWriteBufferOptions } from './outbound-write-buffer.js';

interface ActiveConfig {
  raw: DaemonHostConfig;
  key: string;
  wsUrl: string;
}

const DEFAULT_CONFIG_POLL_MS = 1_000;
const DEFAULT_BACKOFF: ReconnectBackoffOptions = {
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  jitterRatio: 0.25,
};
const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 5_000,
};

export class OutboundDaemonClient {
  private readonly configPollMs: number;
  private readonly backoff: ReconnectBackoffOptions;
  private readonly heartbeat: HeartbeatOptions;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly writeHostConfig: HostConfigWriter;
  private readonly writeBuffer: OutboundWriteBuffer;
  private configTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private desiredConfig: ActiveConfig | null = null;
  private terminalCloseConfigKey: string | null = null;
  private reconnectAttempt = 0;
  private started = false;
  private stopping = false;
  /**
   * Delivery-owner token for the CURRENT WS generation (#task:1417 Stage
   * 3, §11.4.1). Minted fresh on each `ws.open`, threaded into every
   * dispatched command's ctx, and passed to
   * {@link OutboundDaemonClientOptions.cleanupDeferredForOwner} on that
   * generation's close. A reconnect gets a NEW owner, so deferred entries
   * never straddle connection generations.
   */
  private currentOwner: string | null = null;
  private ownerSeq = 0;

  constructor(private readonly opts: OutboundDaemonClientOptions) {
    this.configPollMs = opts.configPollMs ?? DEFAULT_CONFIG_POLL_MS;
    this.backoff = { ...DEFAULT_BACKOFF, ...(opts.backoff ?? {}) };
    this.heartbeat = { ...DEFAULT_HEARTBEAT, ...(opts.heartbeat ?? {}) };
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.writeHostConfig = opts.writeHostConfig ?? writeHostConfigAtomic;
    this.writeBuffer = new OutboundWriteBuffer({
      ...DEFAULT_OUTBOUND_WRITE_BUFFER,
      ...(opts.buffer ?? {}),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.pollConfig();
    if (!this.opts.config && this.configPollMs > 0) {
      this.configTimer = setInterval(() => this.pollConfig(), this.configPollMs);
      this.configTimer.unref?.();
    }
  }

  stop(reason = 'daemon_shutdown'): void {
    this.stopping = true;
    this.clearConfigTimer();
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    const ws = this.ws;
    this.ws = null;
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(1000, reason);
    }
  }

  sendEvent(event: EventFrame): SendResult {
    const frame = toOutboundEventFrame(event);
    const metadata = eventMetadata(event);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.handleUnavailableSend(metadata);
      return metadata.kind === 'runtime_output' ? 'dropped' : 'failed';
    }

    const result = this.writeBuffer.send({
      writer: webSocketFrameWriter(ws),
      frame,
      metadata,
      logger: this.opts.logger,
    });
    if (result === 'overflow') {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'buffer_overflow_close',
          event_kind: metadata.kind,
          conversation_id: metadata.conversation_id,
          agent_id: metadata.agent_id,
          ts: metadata.ts,
          pending_frames: this.writeBuffer.pendingFrames,
          pending_bytes: this.writeBuffer.pendingBytes,
        },
        'daemon outbound ws buffer overflow on non-droppable event; closing connection',
      );
      ws.close(1013, 'outbound_buffer_overflow');
    }
    return result;
  }

  state(): {
    connected: boolean;
    desiredConfigLoaded: boolean;
    reconnectAttempt: number;
    pendingFrames: number;
    pendingBytes: number;
  } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      desiredConfigLoaded: this.desiredConfig !== null,
      reconnectAttempt: this.reconnectAttempt,
      pendingFrames: this.writeBuffer.pendingFrames,
      pendingBytes: this.writeBuffer.pendingBytes,
    };
  }

  private pollConfig(): void {
    if (this.stopping) return;
    const next = this.readConfig();
    if (!next.ok) {
      if (this.desiredConfig !== null || this.ws !== null) {
        this.opts.logger.warn(
          {
            kind: 'outbound_ws',
            action: 'config_unavailable',
            config_path: this.configLabel(),
            reason: next.reason,
          },
          'daemon outbound config unavailable; disconnecting',
        );
      }
      this.desiredConfig = null;
      this.closeForConfigChange('config_unavailable');
      return;
    }

    let wsUrl: string;
    try {
      wsUrl = hostConnectWebSocketUrl(next.config.server_url, {
        allowInsecureRemote: next.config.allow_insecure_remote === true,
      });
    } catch (err) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'config_invalid',
          config_path: this.configLabel(),
          reason: (err as Error).message,
        },
        'daemon outbound config rejected',
      );
      this.desiredConfig = null;
      this.closeForConfigChange('config_invalid');
      return;
    }

    const key = configKey(next.config);
    if (this.desiredConfig?.key === key) {
      if (this.terminalCloseConfigKey === key) {
        return;
      }
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.scheduleReconnect('config_poll');
      }
      return;
    }

    this.desiredConfig = { raw: next.config, key, wsUrl };
    this.terminalCloseConfigKey = null;
    this.reconnectAttempt = 0;
    this.opts.logger.info(
      {
        kind: 'outbound_ws',
        action: 'config_loaded',
        host_id: next.config.host_id,
        server_origin: new URL(next.config.server_url).origin,
      },
      'daemon outbound config loaded',
    );
    this.closeForConfigChange('config_changed');
    this.connectNow();
  }

  private connectNow(): void {
    if (this.stopping) return;
    const config = this.desiredConfig;
    if (!config) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.clearReconnectTimer();
    // Mint this WS generation's delivery-owner token (#task:1417 Stage 3,
    // §11.4.1). Captured by the open/close closures below so a deferred
    // delivery is attributed to this generation and cleaned up when it
    // closes.
    const owner = `outbound:${++this.ownerSeq}`;
    const ws = new WebSocket(config.wsUrl, {
      headers: {
        Authorization: `Bearer ${config.raw.host_token}`,
      },
    });
    this.ws = ws;
    this.opts.logger.info(
      {
        kind: 'outbound_ws',
        action: 'connect_attempt',
        host_id: config.raw.host_id,
        server_origin: new URL(config.raw.server_url).origin,
      },
      'daemon outbound ws connecting',
    );

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.currentOwner = owner;
      this.writeBuffer.reset();
      this.opts.logger.info(
        {
          kind: 'outbound_ws',
          action: 'connected',
          host_id: config.raw.host_id,
        },
        'daemon outbound ws connected',
      );
      this.sendEvent(this.opts.readyEvent());
      this.startHeartbeat();
    });

    ws.on('message', data => this.handleMessage(data));
    ws.on('error', err => {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'socket_error',
          err: (err as Error).message,
          host_id: config.raw.host_id,
        },
        'daemon outbound ws error',
      );
    });
    ws.on('close', (code, reason) => {
      this.clearHeartbeatTimers();
      this.writeBuffer.reset();
      // Owner-scoped deferred cleanup (#task:1417 Stage 3, §11.4.1): this
      // WS generation is gone — discard only its queued deferred
      // deliveries. The backend rolls the matching in-flight rows back to
      // pending; a reconnect replay re-drives them, duplicate-free. Each
      // generation cleans its own owner regardless of whether it was still
      // current.
      if (this.currentOwner === owner) this.currentOwner = null;
      this.opts.cleanupDeferredForOwner?.(owner);
      const reasonText = reason.toString();
      const wasCurrent = this.ws === ws;
      if (wasCurrent) {
        this.ws = null;
      }
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'closed',
          code,
          reason: reasonText,
          close_class: closeClass(code),
          host_id: config.raw.host_id,
        },
        'daemon outbound ws closed',
      );
      if (this.stopping) return;
      if (!wasCurrent) return;
      if (isTerminalServerCloseReason(reasonText)) {
        this.terminalCloseConfigKey = config.key;
        this.clearReconnectTimer();
        this.opts.logger.info(
          {
            kind: 'outbound_ws',
            action: 'reconnect_suppressed',
            reason: reasonText,
            host_id: config.raw.host_id,
          },
          'daemon outbound ws reconnect suppressed after terminal close',
        );
        return;
      }
      this.scheduleReconnect(`close_${closeClass(code)}`);
    });
  }

  private handleMessage(data: RawData): void {
    const parsed = parseJsonFrame(data);
    if (!parsed) {
      this.closeProtocolError('invalid_json');
      return;
    }

    const heartbeat = OutboundHeartbeatFrameSchema.safeParse(parsed);
    if (heartbeat.success) {
      this.handleHeartbeat(heartbeat.data);
      return;
    }

    const command = OutboundServerToDaemonCommandFrameSchema.safeParse(parsed);
    if (command.success) {
      void this.handleCommand(command.data);
      return;
    }

    const any = OutboundFrameSchema.safeParse(parsed);
    if (!any.success) {
      this.closeProtocolError('invalid_frame');
      return;
    }
    this.closeProtocolError('wrong_direction');
  }

  private async handleCommand(
    command: OutboundServerToDaemonCommandFrame,
  ): Promise<void> {
    const dispatcher = this.opts.dispatchCommand ?? defaultCommandDispatcher;
    const startedAt = this.now();
    const successLevel = command.kind === 'host_status' ? 'debug' : 'info';
    this.opts.logger[successLevel](
      {
        kind: 'outbound_ws',
        action: 'command_received',
        command_kind: command.kind,
        request_id: command.id,
      },
      'daemon outbound command received',
    );
    let response: OutboundDaemonToServerCommandResponseFrame;
    try {
      if (command.kind === 'rotate_token') {
        response = {
          direction: 'daemon_to_server',
          type: 'command_response',
          id: command.id,
          kind: command.kind,
          result: this.handleRotateToken(command.params),
        } as OutboundDaemonToServerCommandResponseFrame;
      } else {
        // Thread this generation's owner into the delivery context so a
        // `deferred` disposition is attributed to this WS and cleaned up
        // if it drops (#task:1417 Stage 3, §11.4.1). Owner is set on WS
        // open before any command is handled; a missing owner is a
        // broken-connection invariant, so `resolveDeliveryOwner` throws
        // rather than guess a sentinel that close cleanup could never
        // reclaim — the catch below maps it to internal_error and the
        // dispatcher is never called under a bad owner.
        const owner = resolveDeliveryOwner(
          this.currentOwner ?? undefined,
          'outbound_ws',
        );
        const dispatched = await dispatcher(command, { owner });
        const mapped = toOutboundCommandResponse(command, dispatched);
        response = mapped.frame;
        if (mapped.drift) {
          this.opts.logger.warn(
            {
              kind: 'outbound_ws',
              action: 'command_response_shape_drift',
              command_kind: command.kind,
              request_id: command.id,
              response_summary: mapped.drift.summary,
              issues: mapped.drift.issues,
            },
            'daemon outbound command response shape drift; returning internal_error',
          );
        }
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
      encoded = encodeOutboundFrame(response);
    } catch (err) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'command_response_encode_failed',
          command_kind: command.kind,
          request_id: command.id,
          err: (err as Error).message,
        },
        'daemon outbound command response encode failed; closing connection',
      );
      this.ws?.close(1011, 'command_response_encode_failed');
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'command_response_disconnected',
          command_kind: command.kind,
          request_id: command.id,
        },
        'daemon outbound command response dropped because socket is disconnected',
      );
      return;
    }
    ws.send(encoded, err => {
      this.opts.logger[err ? 'warn' : successLevel](
        {
          kind: 'outbound_ws',
          action: err ? 'command_response_send_failed' : 'command_response_sent',
          command_kind: command.kind,
          request_id: command.id,
          duration_ms: this.now() - startedAt,
          err: err?.message,
        },
        err
          ? 'daemon outbound command response send failed'
          : 'daemon outbound command response sent',
      );
    });
  }

  private handleRotateToken(params: RotateTokenParams): RotateTokenResult {
    const current = this.desiredConfig;
    if (!current || current.raw.host_id !== params.host_id) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'rotate_token_host_mismatch',
          expected_host_id: current?.raw.host_id,
          command_host_id: params.host_id,
        },
        'daemon outbound rotate_token rejected: host mismatch',
      );
      return { rotated: false, reason: 'host_mismatch' };
    }

    const parsed = DaemonHostConfigSchema.safeParse({
      ...current.raw,
      host_token: params.host_token,
    });
    if (!parsed.success) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'rotate_token_invalid_config',
          issues: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        },
        'daemon outbound rotate_token rejected: generated config invalid',
      );
      return { rotated: false, reason: 'invalid_config' };
    }

    try {
      if (!this.opts.configPath) {
        throw new Error('static connect command config cannot be rewritten');
      }
      this.writeHostConfig(this.opts.configPath, parsed.data);
    } catch (err) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'rotate_token_write_failed',
          err: (err as Error).message,
        },
        'daemon outbound rotate_token failed to refresh config',
      );
      return {
        rotated: false,
        reason: 'write_failed',
        message: (err as Error).message,
      };
    }

    const next = {
      raw: parsed.data,
      key: configKey(parsed.data),
      wsUrl: current.wsUrl,
    };
    this.desiredConfig = next;
    this.opts.logger.info(
      {
        kind: 'outbound_ws',
        action: 'rotate_token_refreshed',
        host_id: parsed.data.host_id,
        grace_until: params.grace_until,
      },
      'daemon outbound host token refreshed in config and memory',
    );
    return {
      rotated: true,
      host_id: parsed.data.host_id,
      config_refreshed_at: this.now(),
    };
  }

  private readConfig():
    | { ok: true; config: DaemonHostConfig }
    | { ok: false; reason: ReadHostConfigFailureReason } {
    if (this.opts.config) return { ok: true, config: this.opts.config };
    if (!this.opts.configPath) return { ok: false, reason: 'missing' };
    return readHostConfig(this.opts.configPath);
  }

  private configLabel(): string {
    return this.opts.configPath ? redactConfigPath(this.opts.configPath) : '<memory>';
  }

  private handleHeartbeat(frame: OutboundHeartbeatFrame): void {
    if (frame.direction !== 'server_to_daemon') {
      this.closeProtocolError('wrong_direction_heartbeat');
      return;
    }
    if (frame.kind === 'ping') {
      this.sendControlFrame({
        direction: 'daemon_to_server',
        type: 'heartbeat',
        kind: 'pong',
        ts: this.now(),
        echo_ts: frame.ts,
      });
      return;
    }
    this.clearPongTimer();
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    if (this.heartbeat.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const ts = this.now();
      if (
        !this.sendControlFrame({
          direction: 'daemon_to_server',
          type: 'heartbeat',
          kind: 'ping',
          ts,
        })
      ) {
        return;
      }
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.opts.logger.warn(
          {
            kind: 'outbound_ws',
            action: 'heartbeat_timeout',
            timeout_ms: this.heartbeat.pongTimeoutMs,
          },
          'daemon outbound heartbeat timeout; closing connection',
        );
        this.ws?.close(1008, 'heartbeat_timeout');
      }, this.heartbeat.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.heartbeat.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private sendControlFrame(frame: OutboundFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encodeOutboundFrame(frame));
      return true;
    } catch (err) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'control_send_failed',
          err: (err as Error).message,
        },
        'daemon outbound control frame send failed; closing connection',
      );
      ws.close(1011, 'control_send_failed');
      return false;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || !this.desiredConfig || this.reconnectTimer) return;
    const delayMs = reconnectDelayMs(
      this.reconnectAttempt++,
      this.backoff,
      this.random,
    );
    this.opts.logger.info(
      {
        kind: 'outbound_ws',
        action: 'reconnect_scheduled',
        reason,
        delay_ms: delayMs,
        attempt: this.reconnectAttempt,
      },
      'daemon outbound ws reconnect scheduled',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private closeProtocolError(reason: string): void {
    this.ws?.close(1002, reason);
  }

  private closeForConfigChange(reason: string): void {
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    const ws = this.ws;
    this.ws = null;
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(1000, reason);
    }
  }

  private handleUnavailableSend(metadata: OutboundEventMetadata): void {
    const level = metadata.kind === 'runtime_output' ? 'debug' : 'warn';
    this.opts.logger[level](
      {
        kind: 'outbound_ws',
        action: metadata.kind === 'runtime_output' ? 'drop_disconnected' : 'event_disconnected',
        event_kind: metadata.kind,
        conversation_id: metadata.conversation_id,
        agent_id: metadata.agent_id,
        ts: metadata.ts,
      },
      'daemon outbound event emitted while disconnected',
    );
  }

  private clearConfigTimer(): void {
    if (!this.configTimer) return;
    clearInterval(this.configTimer);
    this.configTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}

async function defaultCommandDispatcher(
  command: OutboundServerToDaemonCommandFrame,
): Promise<OutboundDispatcherResponse> {
  return {
    id: command.id,
    error: {
      code: 'internal_error',
      message: 'daemon outbound command dispatcher is not wired',
    },
  };
}

/**
 * Possible failure reasons from {@link readHostConfig}. Stable so
 * callers can map them onto their own typed errors (supervisor
 * reload → `HostOutboundReloadFailureReason`; attach uses its own
 * stat path that fires before reaching here).
 *
 * Safety boundary (Cindy `#task:633` D3.c Commit 2 P1): `not_a_file`
 * is the load-bearing reason — without the upfront stat check, a
 * FIFO substituted for the config path would block `readFileSync`
 * indefinitely and hang the daemon IPC dispatcher; a directory would
 * throw EISDIR and surface as `invalid_json`, mis-categorizing an
 * I/O failure as a JSON failure. The stat-first contract lives here
 * (rather than at each caller) so every reader of `daemon-config.json`
 * — supervisor reload, internal poll loop, future health checks —
 * gets the same fail-closed treatment.
 */
export type ReadHostConfigFailureReason =
  /** statSync threw ENOENT. */
  | 'missing'
  /** statSync threw a non-ENOENT errno (EACCES, EIO, etc.). */
  | 'io_error'
  /** Path resolved to a directory / FIFO / socket / char/block
   *  device — `statSync().isFile()` returned false. statSync follows
   *  symlinks, so symlink-to-file is fine and symlink-to-FIFO is
   *  rejected here. */
  | 'not_a_file'
  /** `readFileSync` succeeded but the bytes failed JSON.parse. */
  | 'invalid_json'
  /** JSON parsed but failed `DaemonHostConfigSchema` validation. */
  | 'invalid_shape';

export function readHostConfig(
  path: string,
):
  | { ok: true; config: DaemonHostConfig }
  | { ok: false; reason: ReadHostConfigFailureReason } {
  // Stat first, fail-closed on non-regular files. This is the FIFO /
  // directory guard the supervisor reload path needs (Cindy
  // `#task:633` P1). statSync follows symlinks, so the target's mode
  // is what decides — symlink-to-file is accepted; symlink-to-FIFO,
  // -directory, etc. are rejected.
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'io_error' };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not_a_file' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Permission flipped between stat and read, partial-write race,
    // etc. — surface as the I/O class rather than letting it bubble
    // and look like a parse failure.
    return { ok: false, reason: 'io_error' };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = DaemonHostConfigSchema.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };
  return { ok: true, config: parsed.data };
}

export function writeHostConfigAtomic(path: string, config: DaemonHostConfig): void {
  const parsed = DaemonHostConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}

/**
 * Single source of truth for the daemon-host-config fingerprint used
 * by both the outbound client's internal config-poll loop AND by the
 * `OutboundSupervisor`'s reload path (Cindy `#task:631` D3.c Commit 2
 * review item 3: "config fingerprint 单源共用"). Two callers MUST
 * compute "same config?" the same way or reload's `unchanged` arm
 * drifts away from what the client treats as no-op-worthy.
 *
 * Bytes covered: `server_url`, `host_id`, `host_token`, local
 * insecure-remote policy, and (D4.a
 * Commit 5b, daemon fingerprint nuance) `profile_version` — the local-config consistency
 * anchor that links daemon-config to the server connection profile
 * generation. Without it, a profile commit that changes only
 * timestamps would write a config that fingerprints identically to
 * the previous generation, so the daemon would treat it as no-op
 * and desktop's `partial_apply_pending` reconciliation (5c) would
 * never converge. `undefined` (D3.x configs that never had a profile,
 * embedded-mode boot before any profile commit) is encoded as the
 * literal `<none>` so it occupies its own fingerprint bucket — the
 * absence of a value is itself a meaningful state we don't want to
 * collide with `0`.
 *
 * Adding new fields to `DaemonHostConfigSchema` that should also gate
 * the reload's `unchanged` decision means updating this fingerprint —
 * the typecheck on `DaemonHostConfig` won't catch the omission, but
 * a deliberate test in `outbound-supervisor.test.ts` pins the byte
 * set so a new field forces a fixture decision.
 */
export function daemonHostConfigFingerprint(config: DaemonHostConfig): string {
  const profileVersionToken =
    config.profile_version === undefined
      ? '<none>'
      : String(config.profile_version);
  const allowInsecureRemoteToken =
    config.allow_insecure_remote === true ? '1' : '0';
  return (
    `${config.server_url}\0${config.host_id}\0${config.host_token}` +
    `\0allow_insecure_remote=${allowInsecureRemoteToken}` +
    `\0pv=${profileVersionToken}`
  );
}

export function defaultDaemonHostConfigPath(silverhandDir: string): string {
  return join(silverhandDir, DAEMON_HOST_CONFIG_FILENAME);
}

export function hostConnectWebSocketUrl(
  serverUrl: string,
  options?: { allowInsecureRemote?: boolean },
): string {
  // D3.c Commit 1 P1 (Cindy `#task:631`): delegate the V1 server-URL
  // acceptance check to `classifyServerUrl` so renderer / main /
  // daemon all gate on the same allowlist. Without this delegation,
  // a hand-edited `daemon-config.json` carrying an obfuscated IPv4
  // (`http://0x7f000001:18080`, `http://2130706433:18080`, etc.) or
  // expanded IPv6 (`http://[0:0:0:0:0:0:0:1]:18080`) would slip past
  // the daemon because `new URL(...).hostname` would normalize those
  // forms back to the canonical allowlist literals — even though
  // Settings UI + main process correctly rejected the identical
  // string. Strict allowlist must be enforced against the RAW
  // authority host on every hop.
  //
  // Remote attach policy: non-loopback HTTPS is accepted and converted
  // to `wss://.../api/hosts/connect`; non-loopback HTTP is accepted
  // only when daemon-config carries the local client/package opt-in.
  // Keep the legacy error name for the default rejection so older
  // daemon logs / runbooks still line up with the failure mode
  // operators know.
  const classification = classifyServerUrl(serverUrl, {
    allowInsecureRemote: options?.allowInsecureRemote === true,
  });
  if (!classification.ok) {
    if (classification.reason === 'insecure_remote_http_disallowed') {
      // Non-loopback http is still rejected at the daemon WS layer.
      // Preserve the legacy error name for ops continuity.
      throw new Error('tls_required_for_non_loopback_host_ws');
    }
    if (classification.reason === 'obfuscated_loopback_disallowed') {
      // D4.a Commit 1 review — disguised loopback rejection. Map to
      // the same legacy error name so existing ops alerting on
      // `tls_required_for_non_loopback_host_ws` still fires.
      throw new Error('tls_required_for_non_loopback_host_ws');
    }
    if (classification.reason === 'unsupported_scheme') {
      throw new Error(`unsupported_server_url_protocol:${serverUrl}`);
    }
    throw new Error(`invalid_server_url:${classification.reason}`);
  }
  // Re-derive the WS URL from the parsed URL (path appended) so we
  // share the URL parser's normalization with the rest of the file
  // (origin / port / etc.). The URL policy gate already passed.
  const url = new URL(apiPaths.hostConnect, classification.url);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
    return url.toString();
  }
  // Classifier only succeeds for http: / https:, so this branch is
  // the only remaining possibility.
  url.protocol = 'wss:';
  return url.toString();
}

function reconnectDelayMs(
  attempt: number,
  opts: ReconnectBackoffOptions,
  random: () => number,
): number {
  const unclamped = opts.minDelayMs * Math.pow(opts.factor, attempt);
  const base = Math.min(opts.maxDelayMs, unclamped);
  if (opts.jitterRatio <= 0) return Math.round(base);
  const spread = base * opts.jitterRatio;
  const jittered = base - spread + random() * spread * 2;
  return Math.max(0, Math.round(Math.min(opts.maxDelayMs, jittered)));
}

function configKey(config: DaemonHostConfig): string {
  // Single-source: delegate to the exported fingerprint helper so
  // the OutboundSupervisor's reload path (D3.c Commit 2) computes
  // "same config?" the same way the internal poll loop does.
  return daemonHostConfigFingerprint(config);
}

function parseJsonFrame(data: RawData): unknown | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function closeClass(code: number): 'normal' | 'going_away' | 'abnormal' | 'other' {
  if (code === 1000) return 'normal';
  if (code === 1001) return 'going_away';
  if (code === 1006) return 'abnormal';
  return 'other';
}

function isTerminalServerCloseReason(reason: string): boolean {
  return (
    reason === HOST_WS_CLOSE_REASON_REVOKED ||
    reason === HOST_WS_CLOSE_REASON_DISCONNECTED
  );
}

function redactConfigPath(path: string): string {
  return path.endsWith(`/${DAEMON_HOST_CONFIG_FILENAME}`)
    ? `.../${DAEMON_HOST_CONFIG_FILENAME}`
    : '.../daemon-config';
}
