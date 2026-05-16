import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type {
  ClientFrame,
  ErrorFrame,
  EventFrame,
  ServerFrame,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import { SettingsRepo } from '../repos/settings-repo.js';
import {
  canSubscribeScope,
  parseWsScope,
  type ParsedWsScope,
} from './permissions.js';
import type { ScopedEvent } from './scope-event-bus.js';

export interface EventWsConnectionOptions {
  authTimeoutMs?: number;
  authFrameMaxBytes?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_AUTH_FRAME_MAX_BYTES = 4 * 1024;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 5_000;

export class EventWsConnection {
  private readonly authTimeoutMs: number;
  private readonly authFrameMaxBytes: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly subscriptions = new Map<string, () => void>();
  private authenticated = false;
  private viewerUserId: string | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: BackendContext,
    opts: EventWsConnectionOptions = {},
  ) {
    this.authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.authFrameMaxBytes = opts.authFrameMaxBytes ?? DEFAULT_AUTH_FRAME_MAX_BYTES;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  }

  start(): void {
    this.authTimer = setTimeout(() => {
      this.closeWithError('auth_required', 'auth frame required', 1008);
    }, this.authTimeoutMs);
    this.authTimer.unref?.();

    this.ws.on('message', data => this.handleMessage(data));
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', err => {
      this.ctx.logger.warn({ err }, 'ws: connection error');
      this.cleanup();
    });
  }

  closeForShutdown(): void {
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1001, 'server_shutdown');
    }
  }

  terminate(): void {
    this.cleanup();
    if (this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.terminate();
    }
  }

  private handleMessage(data: RawData): void {
    if (!this.authenticated && rawDataBytes(data) > this.authFrameMaxBytes) {
      this.closeWithError('invalid_frame', 'auth frame too large', 1009);
      return;
    }

    const frame = parseJsonFrame(data);
    if (!frame) {
      this.closeWithError('invalid_frame', 'frame must be a JSON object', 1002);
      return;
    }

    if (!this.authenticated) {
      this.handleAuthFrame(frame);
      return;
    }

    this.handleAuthenticatedFrame(frame);
  }

  private handleAuthFrame(frame: ClientFrame): void {
    if (frame.type !== 'auth') {
      this.closeWithError('auth_required', 'first frame must be auth', 1008);
      return;
    }
    if (typeof frame.token !== 'string' || frame.token !== this.ctx.serverConfig.auth_token) {
      this.closeWithError('auth_failed', 'invalid auth token', 1008);
      return;
    }

    this.authenticated = true;
    // V1 single-user: the viewer pointer lives in
    // `app_settings.viewer_user_id` and is written by `POST
    // /api/register` (the sole creator of `users` rows). Pre-
    // registration the pointer is absent; the WS handshake refuses
    // because no user principal can be attached to the connection.
    // V2 multi-user replaces this with token-claim resolution; the
    // public WS handshake itself stays the same.
    const viewerUserId = new SettingsRepo(this.ctx.db).getViewerUserId();
    if (!viewerUserId) {
      this.closeWithError(
        'auth_failed',
        'no registered viewer — call POST /api/register first',
        1011,
      );
      return;
    }
    this.viewerUserId = viewerUserId;
    this.clearAuthTimer();
    this.send({
      type: 'authenticated',
      viewerId: this.viewerUserId,
      epoch: this.ctx.events.epoch,
    });
    this.startHeartbeat();
  }

  private handleAuthenticatedFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case 'auth':
        this.sendError('invalid_frame', 'already authenticated');
        return;
      case 'subscribe':
        this.handleSubscribe(frame.scope);
        return;
      case 'unsubscribe':
        this.handleUnsubscribe(frame.scope);
        return;
      case 'resume':
        this.handleResume(frame.scopes);
        return;
      case 'pong':
        this.clearPongTimer();
        return;
      default:
        this.sendError('invalid_frame', 'unknown frame type');
    }
  }

  private handleSubscribe(rawScope: unknown): void {
    const scope = this.resolveAllowedScope(rawScope);
    if (!scope) return;

    if (!this.subscriptions.has(scope.scope)) {
      const unsubscribe = this.ctx.events.subscribeScope(scope.scope, event => {
        this.send(scopedEventToFrame(event));
      });
      this.subscriptions.set(scope.scope, unsubscribe);
    }

    this.send({
      type: 'subscribed',
      scope: scope.scope,
      epoch: this.ctx.events.epoch,
      seq: this.ctx.events.currentSeq(scope.scope),
    });
  }

  private handleUnsubscribe(rawScope: unknown): void {
    const scope = this.resolveKnownScope(rawScope);
    if (!scope) return;
    const unsubscribe = this.subscriptions.get(scope.scope);
    if (!unsubscribe) return;
    unsubscribe();
    this.subscriptions.delete(scope.scope);
  }

  private handleResume(rawScopes: unknown): void {
    if (!isRecord(rawScopes)) {
      this.sendError('invalid_frame', 'resume.scopes must be an object');
      return;
    }

    for (const [rawScope, position] of Object.entries(rawScopes)) {
      const scope = this.resolveAllowedScope(rawScope);
      if (!scope) continue;
      if (!isRecord(position)) {
        this.sendError('invalid_frame', `invalid resume position for ${scope.scope}`);
        continue;
      }
      const epoch = position.epoch;
      const lastSeq = position.lastSeq;
      if (typeof epoch !== 'string' || !isValidSeq(lastSeq)) {
        this.sendError('invalid_frame', `invalid resume position for ${scope.scope}`);
        continue;
      }

      if (epoch !== this.ctx.events.epoch) {
        this.send({
          type: 'snapshot_required',
          scope: scope.scope,
          reason: 'epoch_mismatch',
        });
        continue;
      }

      const currentSeq = this.ctx.events.currentSeq(scope.scope);
      const replayBuffer = this.ctx.events.getReplayBuffer(scope.scope);
      if (currentSeq > 0 && lastSeq < currentSeq - replayBuffer.size) {
        this.send({
          type: 'snapshot_required',
          scope: scope.scope,
          reason: 'gap_too_large',
        });
        continue;
      }

      for (const entry of replayBuffer.replay(lastSeq, epoch)) {
        this.send({
          type: 'event',
          scope: scope.scope,
          seq: entry.seq,
          epoch: entry.epoch,
          kind: entry.kind,
          payload: entry.payload,
        });
      }
    }
  }

  private resolveAllowedScope(rawScope: unknown): ParsedWsScope | null {
    const scope = this.resolveKnownScope(rawScope);
    if (!scope) return null;
    const viewerUserId = this.viewerUserId;
    if (!viewerUserId || !canSubscribeScope(this.ctx, viewerUserId, scope)) {
      this.sendError('forbidden', `not allowed to subscribe to ${scope.scope}`);
      return null;
    }
    return scope;
  }

  private resolveKnownScope(rawScope: unknown): ParsedWsScope | null {
    if (typeof rawScope !== 'string') {
      this.sendError('invalid_frame', 'scope must be a string');
      return null;
    }
    const viewerUserId = this.viewerUserId;
    if (!viewerUserId) {
      this.sendError('auth_required', 'connection is not authenticated');
      return null;
    }
    const parsed = parseWsScope(rawScope, viewerUserId);
    if (!parsed) {
      this.sendError('unknown_scope', `unknown scope: ${rawScope}`);
      return null;
    }
    return parsed;
  }

  private startHeartbeat(): void {
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.ws.close(1008, 'pong_timeout');
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.ctx.logger.warn({ err }, 'ws: send failed');
    }
  }

  private sendError(code: ErrorFrame['code'], message: string): void {
    this.send({ type: 'error', code, message });
  }

  private closeWithError(
    code: ErrorFrame['code'],
    message: string,
    closeCode: number,
  ): void {
    this.cleanup();
    this.sendError(code, message);
    this.ws.close(closeCode, code);
  }

  private cleanup(): void {
    this.clearAuthTimer();
    this.clearPongTimer();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
  }

  private clearAuthTimer(): void {
    if (!this.authTimer) return;
    clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}

function scopedEventToFrame(event: ScopedEvent): EventFrame {
  return {
    type: 'event',
    scope: event.scope,
    seq: event.seq,
    epoch: event.epoch,
    kind: event.kind,
    payload: event.payload,
  };
}

function parseJsonFrame(data: RawData): ClientFrame | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as ClientFrame;
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

function rawDataBytes(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
