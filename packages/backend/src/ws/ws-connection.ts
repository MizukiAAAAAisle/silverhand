import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type {
  ClientFrame,
  ErrorFrame,
  EventFrame,
  ServerFrame,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import {
  canSubscribeScope,
  parseWsScope,
  type ParsedWsScope,
} from './permissions.js';
import type { ScopedEvent } from './scope-event-bus.js';

export interface EventWsConnectionOptions {
  viewerUserId: string;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 5_000;

export class EventWsConnection {
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly subscriptions = new Map<string, () => void>();
  private viewerUserId: string;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: BackendContext,
    opts: EventWsConnectionOptions,
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.viewerUserId = opts.viewerUserId;
  }

  start(): void {
    this.ws.on('message', data => this.handleMessage(data));
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', err => {
      this.ctx.logger.warn({ err }, 'ws: connection error');
      this.cleanup();
    });
    this.send({
      type: 'authenticated',
      viewerId: this.viewerUserId,
      epoch: this.ctx.events.epoch,
    });
    this.startHeartbeat();
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
    const frame = parseJsonFrame(data);
    if (!frame) {
      this.closeWithError('invalid_frame', 'frame must be a JSON object', 1002);
      return;
    }

    this.handleAuthenticatedFrame(frame);
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

    const seq = this.ctx.events.currentSeq(scope.scope);
    this.ctx.logger.info(
      {
        category: 'event_ws.subscribe',
        viewerUserId: this.viewerUserId,
        scope: scope.scope,
        conversationId: conversationIdFromScope(scope.scope),
        seq,
        epoch: this.ctx.events.epoch,
        subscriptionCount: this.subscriptions.size,
      },
      'event ws subscribed',
    );
    this.send({
      type: 'subscribed',
      scope: scope.scope,
      epoch: this.ctx.events.epoch,
      seq,
    });
  }

  private handleUnsubscribe(rawScope: unknown): void {
    const scope = this.resolveKnownScope(rawScope);
    if (!scope) return;
    const unsubscribe = this.subscriptions.get(scope.scope);
    if (!unsubscribe) return;
    unsubscribe();
    this.subscriptions.delete(scope.scope);
    this.ctx.logger.info(
      {
        category: 'event_ws.unsubscribe',
        viewerUserId: this.viewerUserId,
        scope: scope.scope,
        conversationId: conversationIdFromScope(scope.scope),
        subscriptionCount: this.subscriptions.size,
      },
      'event ws unsubscribed',
    );
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

      const currentSeq = this.ctx.events.currentSeq(scope.scope);
      const replayBuffer = this.ctx.events.getReplayBuffer(scope.scope);
      this.ctx.logger.info(
        {
          category: 'event_ws.resume',
          viewerUserId: this.viewerUserId,
          scope: scope.scope,
          conversationId: conversationIdFromScope(scope.scope),
          lastSeq,
          currentSeq,
          epoch,
          serverEpoch: this.ctx.events.epoch,
          replayBufferSize: replayBuffer.size,
        },
        'event ws resume requested',
      );

      if (epoch !== this.ctx.events.epoch) {
        this.logSnapshotRequired(scope.scope, 'epoch_mismatch', {
          lastSeq,
          currentSeq,
          epoch,
        });
        this.send({
          type: 'snapshot_required',
          scope: scope.scope,
          reason: 'epoch_mismatch',
          epoch: this.ctx.events.epoch,
          currentSeq,
        });
        continue;
      }

      if (currentSeq > 0 && lastSeq < currentSeq - replayBuffer.size) {
        this.logSnapshotRequired(scope.scope, 'gap_too_large', {
          lastSeq,
          currentSeq,
          epoch,
          replayBufferSize: replayBuffer.size,
        });
        this.send({
          type: 'snapshot_required',
          scope: scope.scope,
          reason: 'gap_too_large',
          epoch: this.ctx.events.epoch,
          currentSeq,
        });
        continue;
      }

      const replayEntries = replayBuffer.replay(lastSeq, epoch);
      this.ctx.logger.info(
        {
          category: 'event_ws.resume',
          viewerUserId: this.viewerUserId,
          scope: scope.scope,
          conversationId: conversationIdFromScope(scope.scope),
          lastSeq,
          currentSeq,
          epoch,
          replayCount: replayEntries.length,
        },
        'event ws resume replay',
      );
      for (const entry of replayEntries) {
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
    if (!canSubscribeScope(this.ctx, viewerUserId, scope)) {
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
    if (this.ws.readyState !== WebSocket.OPEN) {
      if (shouldLogSkippedSend(frame)) {
        this.ctx.logger.warn(
          {
            category: 'event_ws.send_skipped_non_open',
            viewerUserId: this.viewerUserId,
            readyState: this.ws.readyState,
            ...serverFrameLogFields(frame),
          },
          'event ws send skipped: socket not open',
        );
      }
      return;
    }
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.ctx.logger.warn(
        { err, ...serverFrameLogFields(frame) },
        'ws: send failed',
      );
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

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private logSnapshotRequired(
    scope: string,
    reason: 'epoch_mismatch' | 'gap_too_large',
    fields: Record<string, unknown>,
  ): void {
    this.ctx.logger.info(
      {
        category: 'event_ws.snapshot_required',
        viewerUserId: this.viewerUserId,
        scope,
        conversationId: conversationIdFromScope(scope),
        reason,
        ...fields,
      },
      'event ws snapshot required',
    );
  }
}

function conversationIdFromScope(scope: string): string | undefined {
  return scope.startsWith('conversation:') ? scope.slice('conversation:'.length) : undefined;
}

function shouldLogSkippedSend(frame: ServerFrame): boolean {
  return (
    frame.type === 'event' ||
    frame.type === 'snapshot_required' ||
    frame.type === 'subscribed'
  );
}

function serverFrameLogFields(frame: ServerFrame): Record<string, unknown> {
  switch (frame.type) {
    case 'event':
      return {
        frameType: frame.type,
        scope: frame.scope,
        conversationId: conversationIdFromScope(frame.scope),
        seq: frame.seq,
        epoch: frame.epoch,
        eventKind: frame.kind,
      };
    case 'subscribed':
      return {
        frameType: frame.type,
        scope: frame.scope,
        conversationId: conversationIdFromScope(frame.scope),
        seq: frame.seq,
        epoch: frame.epoch,
      };
    case 'snapshot_required':
      return {
        frameType: frame.type,
        scope: frame.scope,
        conversationId: conversationIdFromScope(frame.scope),
        reason: frame.reason,
      };
    case 'authenticated':
      return { frameType: frame.type, epoch: frame.epoch };
    default:
      return { frameType: frame.type };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
