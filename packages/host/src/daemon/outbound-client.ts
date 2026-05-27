import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  DaemonHostConfigSchema,
  apiPaths,
  isLoopbackHost as sharedIsLoopbackHost,
  type DaemonHostConfig,
} from '@silverhand/shared';
import {
  OUTBOUND_PROTOCOL_VERSION,
  OutboundFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundDaemonToServerCommandResponseFrameSchema,
  encodeOutboundFrame,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundFrame,
  type OutboundHeartbeatFrame,
  type OutboundServerToDaemonCommandFrame,
  type RotateTokenParams,
  type RotateTokenResult,
} from '../outbound-protocol.js';
import type { EventFrame, ResponseFrame } from '../protocol.js';
import type { DaemonLogger } from './logger.js';

export interface OutboundDaemonClientOptions {
  configPath: string;
  logger: DaemonLogger;
  readyEvent: () => Extract<EventFrame, { event: 'ready' }>;
  configPollMs?: number;
  backoff?: Partial<ReconnectBackoffOptions>;
  heartbeat?: Partial<HeartbeatOptions>;
  buffer?: Partial<OutboundWriteBufferOptions>;
  dispatchCommand?: OutboundCommandDispatcher;
  writeHostConfig?: HostConfigWriter;
  random?: () => number;
  now?: () => number;
}

export type OutboundCommandDispatcher = (
  command: OutboundServerToDaemonCommandFrame,
) => Promise<ResponseFrame>;
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

export interface OutboundWriteBufferOptions {
  maxFrames: number;
  maxBytes: number;
}

interface ActiveConfig {
  raw: DaemonHostConfig;
  key: string;
  wsUrl: string;
}

interface OutboundEventMetadata {
  kind: string;
  conversation_id?: string;
  agent_id?: string;
  ts?: number;
}

type SendResult = 'sent' | 'dropped' | 'overflow' | 'failed';

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
const DEFAULT_BUFFER: OutboundWriteBufferOptions = {
  maxFrames: 1024,
  maxBytes: 4 * 1024 * 1024,
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
  private reconnectAttempt = 0;
  private started = false;
  private stopping = false;

  constructor(private readonly opts: OutboundDaemonClientOptions) {
    this.configPollMs = opts.configPollMs ?? DEFAULT_CONFIG_POLL_MS;
    this.backoff = { ...DEFAULT_BACKOFF, ...(opts.backoff ?? {}) };
    this.heartbeat = { ...DEFAULT_HEARTBEAT, ...(opts.heartbeat ?? {}) };
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.writeHostConfig = opts.writeHostConfig ?? writeHostConfigAtomic;
    this.writeBuffer = new OutboundWriteBuffer({
      ...DEFAULT_BUFFER,
      ...(opts.buffer ?? {}),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.pollConfig();
    if (this.configPollMs > 0) {
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
      ws,
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
    const next = readHostConfig(this.opts.configPath);
    if (!next.ok) {
      if (this.desiredConfig !== null || this.ws !== null) {
        this.opts.logger.warn(
          {
            kind: 'outbound_ws',
            action: 'config_unavailable',
            config_path: redactConfigPath(this.opts.configPath),
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
      wsUrl = hostConnectWebSocketUrl(next.config.server_url);
    } catch (err) {
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'config_invalid',
          config_path: redactConfigPath(this.opts.configPath),
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
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.scheduleReconnect('config_poll');
      }
      return;
    }

    this.desiredConfig = { raw: next.config, key, wsUrl };
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
      const wasCurrent = this.ws === ws;
      if (wasCurrent) {
        this.ws = null;
      }
      this.opts.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'closed',
          code,
          reason: reason.toString(),
          close_class: closeClass(code),
          host_id: config.raw.host_id,
        },
        'daemon outbound ws closed',
      );
      if (this.stopping) return;
      if (!wasCurrent) return;
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
    this.opts.logger.info(
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
        const dispatched = await dispatcher(command);
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
      this.opts.logger[err ? 'warn' : 'info'](
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

class OutboundWriteBuffer {
  pendingFrames = 0;
  pendingBytes = 0;
  private droppedRuntimeOutput = 0;

  constructor(private readonly opts: OutboundWriteBufferOptions) {}

  send(input: {
    ws: WebSocket;
    frame: OutboundDaemonToServerEventFrame;
    metadata: OutboundEventMetadata;
    logger: DaemonLogger;
  }): SendResult {
    let encoded: string;
    try {
      encoded = encodeOutboundFrame(input.frame);
    } catch (err) {
      if (input.metadata.kind === 'runtime_output') {
        this.logRuntimeOutputDrop(input, 0, (err as Error).message);
        return 'dropped';
      }
      this.logOverflow(input, 0, (err as Error).message);
      return 'overflow';
    }

    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    // Conservative on purpose: pendingBytes and ws.bufferedAmount can overlap
    // briefly for in-flight sends; prefer early backpressure to unbounded RAM.
    const totalBytes =
      this.pendingBytes + encodedBytes + Math.max(0, input.ws.bufferedAmount);
    const totalFrames = this.pendingFrames + 1;
    if (totalBytes > this.opts.maxBytes || totalFrames > this.opts.maxFrames) {
      if (input.metadata.kind === 'runtime_output') {
        this.logRuntimeOutputDrop(input, encodedBytes, 'buffer_limit');
        return 'dropped';
      }
      this.logOverflow(input, encodedBytes, 'buffer_limit');
      return 'overflow';
    }

    this.pendingFrames++;
    this.pendingBytes += encodedBytes;
    try {
      input.ws.send(encoded, err => {
        this.pendingFrames = Math.max(0, this.pendingFrames - 1);
        this.pendingBytes = Math.max(0, this.pendingBytes - encodedBytes);
        if (err) {
          input.logger.warn(
            {
              kind: 'outbound_ws',
              action: 'event_send_callback_error',
              err: err.message,
              event_kind: input.metadata.kind,
              conversation_id: input.metadata.conversation_id,
              agent_id: input.metadata.agent_id,
              ts: input.metadata.ts,
            },
            'daemon outbound event send callback failed',
          );
        }
      });
      return 'sent';
    } catch (err) {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - encodedBytes);
      input.logger.warn(
        {
          kind: 'outbound_ws',
          action: 'event_send_failed',
          err: (err as Error).message,
          event_kind: input.metadata.kind,
          conversation_id: input.metadata.conversation_id,
          agent_id: input.metadata.agent_id,
          ts: input.metadata.ts,
        },
        'daemon outbound event send failed',
      );
      return 'failed';
    }
  }

  reset(): void {
    this.pendingFrames = 0;
    this.pendingBytes = 0;
  }

  private logRuntimeOutputDrop(
    input: {
      metadata: OutboundEventMetadata;
      logger: DaemonLogger;
    },
    encodedBytes: number,
    reason: string,
  ): void {
    this.droppedRuntimeOutput++;
    input.logger.warn(
      {
        kind: 'outbound_ws',
        action: 'runtime_output_dropped',
        event_kind: input.metadata.kind,
        conversation_id: input.metadata.conversation_id,
        agent_id: input.metadata.agent_id,
        ts: input.metadata.ts,
        encoded_bytes: encodedBytes,
        pending_frames: this.pendingFrames,
        pending_bytes: this.pendingBytes,
        dropped_count: this.droppedRuntimeOutput,
        reason,
      },
      'daemon outbound runtime_output dropped under write-buffer pressure',
    );
  }

  private logOverflow(
    input: {
      metadata: OutboundEventMetadata;
      logger: DaemonLogger;
    },
    encodedBytes: number,
    reason: string,
  ): void {
    input.logger.warn(
      {
        kind: 'outbound_ws',
        action: 'non_droppable_overflow',
        event_kind: input.metadata.kind,
        conversation_id: input.metadata.conversation_id,
        agent_id: input.metadata.agent_id,
        ts: input.metadata.ts,
        encoded_bytes: encodedBytes,
        pending_frames: this.pendingFrames,
        pending_bytes: this.pendingBytes,
        reason,
      },
      'daemon outbound non-droppable event exceeded write-buffer cap',
    );
  }
}

async function defaultCommandDispatcher(
  command: OutboundServerToDaemonCommandFrame,
): Promise<ResponseFrame> {
  return {
    id: command.id,
    error: {
      code: 'internal_error',
      message: 'daemon outbound command dispatcher is not wired',
    },
  };
}

function toOutboundCommandResponse(
  command: OutboundServerToDaemonCommandFrame,
  response: ResponseFrame,
): {
  frame: OutboundDaemonToServerCommandResponseFrame;
  drift?: { summary: Record<string, unknown>; issues: string[] };
} {
  const candidate = 'error' in response
    ? {
        direction: 'daemon_to_server',
        type: 'command_response',
        id: command.id,
        kind: command.kind,
        error: response.error,
      }
    : {
        direction: 'daemon_to_server',
        type: 'command_response',
        id: command.id,
        kind: command.kind,
        result: response.result,
      };
  const parsed = OutboundDaemonToServerCommandResponseFrameSchema.safeParse(
    candidate,
  );
  if (parsed.success) return { frame: parsed.data };
  return {
    frame: {
      direction: 'daemon_to_server',
      type: 'command_response',
      id: command.id,
      kind: command.kind,
      error: {
        code: 'internal_error',
        message: `daemon outbound command response drift for ${command.kind}`,
      },
    } as OutboundDaemonToServerCommandResponseFrame,
    drift: {
      summary: summarizeResponseFrame(response),
      issues: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
    },
  };
}

function summarizeResponseFrame(response: ResponseFrame): Record<string, unknown> {
  if ('error' in response) {
    return {
      arm: 'error',
      id: response.id,
      error_code: response.error.code,
    };
  }
  const result = response.result;
  return {
    arm: 'result',
    id: response.id,
    result_type: Array.isArray(result) ? 'array' : typeof result,
    result_keys:
      result && typeof result === 'object' && !Array.isArray(result)
        ? Object.keys(result).slice(0, 10)
        : undefined,
  };
}

export function readHostConfig(
  path: string,
): { ok: true; config: DaemonHostConfig } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  try {
    const parsed = DaemonHostConfigSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    if (!parsed.success) return { ok: false, reason: 'invalid_shape' };
    return { ok: true, config: parsed.data };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
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

export function defaultDaemonHostConfigPath(silverhandDir: string): string {
  return join(silverhandDir, DAEMON_HOST_CONFIG_FILENAME);
}

export function hostConnectWebSocketUrl(serverUrl: string): string {
  const url = new URL(apiPaths.hostConnect, serverUrl);
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new Error('tls_required_for_non_loopback_host_ws');
    }
    url.protocol = 'ws:';
    return url.toString();
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
    return url.toString();
  }
  throw new Error(`unsupported_server_url_protocol:${url.protocol}`);
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
  return `${config.server_url}\0${config.host_id}\0${config.host_token}`;
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

function isLoopbackHost(hostname: string): boolean {
  // D3.c Commit 1: delegate to the shared `@silverhand/shared`
  // classifier so renderer / main / daemon never drift on what
  // "loopback host in V1" means. The local thunk stays so the rest
  // of this file reads the same, but the allowlist itself lives in
  // exactly one place.
  return sharedIsLoopbackHost(hostname);
}

function redactConfigPath(path: string): string {
  return path.endsWith(`/${DAEMON_HOST_CONFIG_FILENAME}`)
    ? `.../${DAEMON_HOST_CONFIG_FILENAME}`
    : '.../daemon-config';
}

function eventMetadata(event: EventFrame): OutboundEventMetadata {
  return {
    kind: event.event,
    conversation_id: 'conversation_id' in event ? event.conversation_id : undefined,
    agent_id: 'agent_id' in event ? event.agent_id : undefined,
    ts: 'ts' in event && typeof event.ts === 'number' ? event.ts : undefined,
  };
}

function toOutboundEventFrame(event: EventFrame): OutboundDaemonToServerEventFrame {
  switch (event.event) {
    case 'ready': {
      const {
        event: _event,
        socket_path: _socketPath,
        protocol_version: _protocolVersion,
        ...rest
      } = event;
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'ready',
        protocol_version: OUTBOUND_PROTOCOL_VERSION,
        ...rest,
      };
    }
    case 'shutting_down': {
      const { event: _event, ...rest } = event;
      return { direction: 'daemon_to_server', type: 'event', kind: event.event, ...rest };
    }
    default: {
      const { event: _event, ...rest } = event;
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind: event.event,
        ...rest,
      } as OutboundDaemonToServerEventFrame;
    }
  }
}
