import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type {
  ClientFrame,
  ErrorFrame,
  EventFrame,
  ServerFrame,
} from '@silverhand/shared';
import {
  decodeTransportEpoch,
  decodeTransportSeq,
  parseConversationScope,
  parseConversationSideScope,
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
  /**
   * Last observed delivery-authorization verdict per subscribed scope, so
   * {@link authorizedForDelivery} logs each transition once instead of once per
   * frame. Absent = "assumed allowed" (the subscribe gate just passed).
   */
  private readonly deliveryAuthorized = new Map<string, boolean>();
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
        if (!this.authorizedForDelivery(scope)) return;
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
    this.deliveryAuthorized.delete(scope.scope);
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
      // Inbound decode boundary: this is untrusted client input, so the raw
      // {epoch, lastSeq} is validated + branded into transport-space here (never
      // a bare trust-cast). These are the only client→server transport mints;
      // all server→client frames pass through already-branded bus values.
      const resumeEpoch = decodeTransportEpoch(epoch);
      const resumeSeq = decodeTransportSeq(lastSeq);

      const currentSeq = this.ctx.events.currentSeq(scope.scope);
      const replayBuffer = this.ctx.events.getReplayBuffer(scope.scope);
      this.ctx.logger.info(
        {
          category: 'event_ws.resume',
          viewerUserId: this.viewerUserId,
          scope: scope.scope,
          conversationId: conversationIdFromScope(scope.scope),
          lastSeq: resumeSeq,
          currentSeq,
          epoch: resumeEpoch,
          serverEpoch: this.ctx.events.epoch,
          replayBufferSize: replayBuffer.size,
        },
        'event ws resume requested',
      );

      if (resumeEpoch !== this.ctx.events.epoch) {
        this.logSnapshotRequired(scope.scope, 'epoch_mismatch', {
          lastSeq: resumeSeq,
          currentSeq,
          epoch: resumeEpoch,
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

      if (currentSeq > 0 && resumeSeq < currentSeq - replayBuffer.size) {
        this.logSnapshotRequired(scope.scope, 'gap_too_large', {
          lastSeq: resumeSeq,
          currentSeq,
          epoch: resumeEpoch,
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

      const replayEntries = replayBuffer.replay(resumeSeq, resumeEpoch);
      this.ctx.logger.info(
        {
          category: 'event_ws.resume',
          viewerUserId: this.viewerUserId,
          scope: scope.scope,
          conversationId: conversationIdFromScope(scope.scope),
          lastSeq: resumeSeq,
          currentSeq,
          epoch: resumeEpoch,
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

  /**
   * Re-decide, for THIS frame, whether the viewer may still receive this scope
   * (#task:1690).
   *
   * Authorization is a current fact about the viewer and the resource; a
   * subscription is only the client's declared interest. Collapsing the two —
   * "allowed at subscribe time" as a credential the connection keeps — meant a
   * viewer who lost access (removed from a channel by someone else, a channel
   * flipped private, a workspace membership revoked) kept receiving live frames
   * until they happened to reconnect, i.e. the perimeter depended on client
   * good will. So every delivery re-runs the SAME `canSubscribeScope` the
   * subscribe/resume paths run — one policy, not a second copy that can drift,
   * and the existing per-scope semantics carry over unchanged (a public channel's
   * content stream survives losing membership because `canReadConversation`
   * still passes; its member-only side plane does not).
   *
   * Deliberately NOT a revoke: the subscription entry stays, so regaining access
   * resumes delivery on the next frame with no client round-trip. The cost is a
   * predicate evaluation per frame per subscription (a handful of indexed reads,
   * against a JSON serialize + socket write we are already paying); the benefit
   * is that no future mutation has to remember to revoke anything — omission
   * fails closed here, whereas a revoke list fails open.
   *
   * A withheld frame is silent by design: `seq` continues to advance on the bus,
   * so a client that regains access and resumes gets `snapshot_required` /
   * replay through the normal recovery path rather than a bespoke signal.
   * Transitions are logged once each way, not per frame.
   */
  private authorizedForDelivery(scope: ParsedWsScope): boolean {
    const allowed = canSubscribeScope(this.ctx, this.viewerUserId, scope);
    if (allowed !== (this.deliveryAuthorized.get(scope.scope) ?? true)) {
      this.deliveryAuthorized.set(scope.scope, allowed);
      this.ctx.logger.info(
        {
          category: 'event_ws.delivery_authorization_changed',
          viewerUserId: this.viewerUserId,
          scope: scope.scope,
          conversationId: conversationIdFromScope(scope.scope),
          allowed,
        },
        allowed
          ? 'event ws delivery re-authorized'
          : 'event ws delivery withheld: viewer no longer allowed to subscribe',
      );
    }
    return allowed;
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
    this.deliveryAuthorized.clear();
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
  // Recognize BOTH conversation recovery classes for diagnostics so a
  // `conversation-side:` scope's logs carry the conversationId too. Routing
  // stays on the disjoint shared parsers — never a fuzzy `startsWith`.
  return (
    parseConversationScope(scope) ?? parseConversationSideScope(scope) ?? undefined
  );
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
