import type {
  ClientFrame,
  EventFrame,
  ResumeFrame,
  ServerFrame,
  SubscribedFrame,
  SubscribeFrame,
} from '@silverhand/shared';
import { getBackendInfo } from './api';

const EVENT_WS_PATH = '/api/ws/events';
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 30_000] as const;

export type WsClientStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected';

export type WsClientListener = (frame: ServerFrame) => void;
export type WsStatusListener = (status: WsClientStatus) => void;

export interface WsScopeSubscription {
  unsubscribe(): void;
}

interface ResumePosition {
  epoch: string;
  lastSeq: number;
}

type EventWsDiagnosticKind =
  | 'socket_open'
  | 'socket_close'
  | 'authenticated'
  | 'subscribed'
  | 'message_event'
  | 'live_gap'
  | 'resume_sent'
  | 'snapshot_required';

interface EventWsDiagnostic {
  kind: EventWsDiagnosticKind;
  scope?: string;
  eventKind?: string;
  seq?: number;
  lastSeq?: number;
  expectedSeq?: number;
  epoch?: string;
  reason?: string;
  code?: number;
  wasClean?: boolean;
}

/**
 * @internal — exported for unit tests so they can construct a fresh
 * client without sharing state with the module-level `eventWsClient`
 * singleton. Production code should always use `eventWsClient` (or the
 * top-level `subscribe*` helpers).
 */
export class EventWsClient {
  private ws: WebSocket | null = null;
  private status: WsClientStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly frameListeners = new Set<WsClientListener>();
  private readonly statusListeners = new Set<WsStatusListener>();
  private readonly desiredScopes = new Map<string, number>();
  private readonly positions = new Map<string, ResumePosition>();
  private readonly confirmedScopes = new Set<string>();
  /**
   * Scopes whose transport cursor we retain *without* a live subscriber —
   * i.e. unsubscribed scopes whose `positions` entry is kept so a later
   * resubscribe can resume from it and replay the no-listener gap
   * (#task:1251). `unsubscribe()` must NOT drop the cursor: doing so made
   * the next `subscribe` re-baseline to server head via the `subscribed`
   * ack, silently skipping any event published while no listener was
   * attached. Insertion-ordered so it doubles as the LRU eviction queue;
   * bounded by `MAX_DETACHED_POSITIONS` so retained-but-unused cursors
   * can't grow without limit. Eviction is *safe*: a dropped cursor just
   * sends the next resubscribe down the fresh-baseline / `snapshot_required`
   * path — never a silent skip.
   */
  private readonly detachedScopes = new Set<string>();
  private static readonly MAX_DETACHED_POSITIONS = 64;
  /**
   * Scopes with a forward-gap recovery in flight. When a live `event`
   * frame arrives beyond the next expected seq we hold the cursor, ask
   * the server to replay from it, and latch the scope here so every
   * further gapped frame coalesces into the one in-flight resume instead
   * of firing a redundant one. The latch drops as soon as the in-order
   * replay delivers the next contiguous seq (see `acceptEventFrame`).
   */
  private readonly recovering = new Set<string>();
  /**
   * Live `subscribeViewerScope()` handles. Each holds a deferred inner
   * subscription that materialises against the canonical
   * `viewer:{resolvedViewerId}` scope once the server's `authenticated`
   * frame arrives. Keeping the indirection out of `subscribe()` itself
   * means `desiredScopes` / `positions` / `confirmedScopes` only ever
   * see the canonical key, so `resubscribeDesiredScopes()` naturally
   * carries the viewer's last seq across reconnects.
   */
  private readonly viewerSubscribers = new Set<ViewerSubscriber>();
  /**
   * Server-resolved viewer id from the `authenticated` frame. Used by
   * `getResolvedViewerScope()` so callers can match incoming events
   * scoped to `viewer:{id}` without needing to know the id up front
   * (clients subscribe via the `viewer:self` alias and the server
   * canonicalizes both directions).
   */
  private resolvedViewerId: string | null = null;

  connect(): void {
    this.shouldReconnect = true;
    if (
      this.status === 'connecting' ||
      this.status === 'authenticating' ||
      this.status === 'connected'
    ) {
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    void this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    this.confirmedScopes.clear();
    this.recovering.clear();
    this.resolvedViewerId = null;
    // Detach viewer wrappers so desiredScopes/positions for the canonical
    // `viewer:<id>` are released. They'll re-attach on the next connect()
    // → authenticated cycle if the wrapper handle is still live.
    for (const sub of Array.from(this.viewerSubscribers)) {
      sub.detach();
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, 'client_disconnect');
    }
    this.setStatus('disconnected');
  }

  subscribe(scope: string): WsScopeSubscription {
    const previousCount = this.desiredScopes.get(scope) ?? 0;
    this.desiredScopes.set(scope, previousCount + 1);
    // This scope has a live subscriber again — it's no longer a detached,
    // evictable cursor. (No-op for an already-subscribed scope.)
    this.detachedScopes.delete(scope);
    this.connect();
    if (
      previousCount === 0 ||
      (this.status === 'connected' && !this.confirmedScopes.has(scope))
    ) {
      this.sendSubscribe(scope);
    }

    return {
      unsubscribe: () => {
        const count = this.desiredScopes.get(scope) ?? 0;
        if (count <= 1) {
          this.desiredScopes.delete(scope);
          this.confirmedScopes.delete(scope);
          this.recovering.delete(scope);
          // Retain `positions[scope]` (the transport cursor) so a later
          // resubscribe resumes from it and replays the no-listener gap
          // (#task:1251). Track it as detached for bounded LRU eviction.
          if (this.positions.has(scope)) {
            this.detachedScopes.delete(scope);
            this.detachedScopes.add(scope);
            this.evictDetachedPositions();
          }
          this.sendIfConnected({ type: 'unsubscribe', scope });
        } else {
          this.desiredScopes.set(scope, count - 1);
        }
      },
    };
  }

  /**
   * Send a `subscribe` for the scope and, when we hold a retained cursor
   * for it, a paired `resume` from that cursor (#task:1251). The resume
   * makes the server replay events published while no listener was
   * attached; without it the `subscribed` ack would re-baseline to head
   * and skip them. No-op until connected — a disconnected subscribe is
   * (re)issued, cursor and all, by `resubscribeDesiredScopes()` on the
   * next `authenticated` frame.
   */
  private sendSubscribe(scope: string): void {
    if (!this.sendIfConnected({ type: 'subscribe', scope })) return;
    const position = this.positions.get(scope);
    if (position) this.sendResume({ [scope]: position });
  }

  /**
   * Drop the oldest detached cursors once we exceed
   * `MAX_DETACHED_POSITIONS`. Only scopes with no live subscriber are
   * evictable; a dropped cursor degrades the next resubscribe to a fresh
   * baseline (or `snapshot_required`), never a silent skip.
   */
  private evictDetachedPositions(): void {
    while (this.detachedScopes.size > EventWsClient.MAX_DETACHED_POSITIONS) {
      const oldest = this.detachedScopes.values().next().value;
      if (oldest === undefined) break;
      this.detachedScopes.delete(oldest);
      this.positions.delete(oldest);
    }
  }

  /**
   * Subscribe to the resolved viewer's private scope. Returns a handle
   * that immediately participates in refcounting on the canonical
   * `viewer:{id}` scope when the viewer id is already resolved, and
   * otherwise materialises on the next `authenticated` frame. The
   * caller never sees the alias key — it stays an over-the-wire detail
   * so `desiredScopes` / `positions` / `confirmedScopes` are
   * canonical-only and reconnect resume frames can carry the viewer
   * scope's last seq.
   */
  subscribeViewerScope(): WsScopeSubscription {
    const sub = new ViewerSubscriber(this);
    this.viewerSubscribers.add(sub);
    this.connect();
    sub.attach();
    return {
      unsubscribe: () => {
        sub.detach();
        this.viewerSubscribers.delete(sub);
      },
    };
  }

  resume(scope: string, position: ResumePosition): void {
    this.recovering.delete(scope);
    this.positions.set(scope, position);
    this.sendResume({ [scope]: position });
  }

  onFrame(listener: WsClientListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WsClientStatus {
    return this.status;
  }

  /**
   * The server-resolved viewer id from the most recent `authenticated`
   * frame, or null while the connection is establishing. Returned by
   * `getResolvedViewerScope()` and consumed by `isCurrentViewerScope()`.
   */
  getResolvedViewerId(): string | null {
    return this.resolvedViewerId;
  }

  private async openSocket(): Promise<void> {
    this.clearReconnectTimer();
    this.setStatus('connecting');
    let url: string;
    try {
      const info = await getBackendInfo();
      url = eventWsUrl(info.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    if (!this.shouldReconnect) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.confirmedScopes.clear();
    this.recovering.clear();

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      recordEventWsDiagnostic({ kind: 'socket_open' });
      this.setStatus('authenticating');
    });

    ws.addEventListener('message', raw => {
      if (this.ws !== ws) return;
      const frame = parseServerFrame(raw.data);
      if (!frame) return;
      this.handleFrame(frame);
    });

    ws.addEventListener('close', ev => {
      if (this.ws !== ws) return;
      recordEventWsDiagnostic({
        kind: 'socket_close',
        code: ev.code,
        wasClean: ev.wasClean,
      });
      this.ws = null;
      this.confirmedScopes.clear();
      this.recovering.clear();
      this.setStatus('disconnected');
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` follows for network errors; keep the state transition in one path.
    });
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === 'authenticated') {
      this.reconnectAttempt = 0;
      this.confirmedScopes.clear();
      this.recovering.clear();
      this.resolvedViewerId = frame.viewerId;
      recordEventWsDiagnostic({ kind: 'authenticated', epoch: frame.epoch });
      // Attach viewer wrappers BEFORE status flips to 'connected'.
      // `subscribe()` is then refcount-only (sendIfConnected gated on
      // status==='connected' returns early), so the canonical viewer
      // scope is added to desiredScopes silently and picked up by the
      // single `resubscribeDesiredScopes()` pass below — no duplicate
      // subscribe frames.
      for (const sub of Array.from(this.viewerSubscribers)) {
        sub.attach();
      }
      this.setStatus('connected');
      this.resubscribeDesiredScopes();
    } else if (frame.type === 'ping') {
      this.send({ type: 'pong' });
    } else if (frame.type === 'subscribed') {
      this.confirmedScopes.add(frame.scope);
      // A subscription confirmation re-baselines the scope's cursor, so any
      // in-flight gap recovery for it is moot.
      this.recovering.delete(frame.scope);
      // Baseline from the ack ONLY when there's no usable retained cursor.
      // A same-epoch retained cursor is client-authoritative: `sendSubscribe`
      // paired a `resume` with it, so the server replays the gap and the
      // ack must NOT re-baseline to server head (that's the no-listener-gap
      // skip, #task:1251). A retained cursor from a stale epoch is moot —
      // baseline fresh; a mismatched resume self-heals via snapshot_required.
      const retained = this.positions.get(frame.scope);
      if (!retained || retained.epoch !== frame.epoch) {
        this.recordPosition(frame);
      }
      recordEventWsDiagnostic({
        kind: 'subscribed',
        scope: frame.scope,
        seq: frame.seq,
        epoch: frame.epoch,
      });
    } else if (frame.type === 'event') {
      if (!this.acceptEventFrame(frame)) {
        // Gap detected (or a frame still beyond the cursor while recovery is
        // in flight): swallow it. The server's in-order replay redelivers it.
        return;
      }
      if (frame.kind === 'message') {
        recordEventWsDiagnostic({
          kind: 'message_event',
          scope: frame.scope,
          eventKind: frame.kind,
          seq: frame.seq,
          epoch: frame.epoch,
        });
      }
    } else if (frame.type === 'snapshot_required') {
      this.positions.delete(frame.scope);
      // The server couldn't replay the gap (buffer too small / epoch
      // mismatch). Recovery is over — drop the latch and let the dispatched
      // frame drive a full refetch via the conversation hooks.
      this.recovering.delete(frame.scope);
      recordEventWsDiagnostic({
        kind: 'snapshot_required',
        scope: frame.scope,
        reason: frame.reason,
      });
    }

    for (const listener of Array.from(this.frameListeners)) {
      listener(frame);
    }
  }

  private resubscribeDesiredScopes(): void {
    for (const scope of this.desiredScopes.keys()) {
      this.send({ type: 'subscribe', scope });
    }
    const resumeScopes: ResumeFrame['scopes'] = {};
    for (const [scope, position] of this.positions.entries()) {
      if (!this.desiredScopes.has(scope)) continue;
      resumeScopes[scope] = position;
    }
    if (Object.keys(resumeScopes).length > 0) {
      this.sendResume(resumeScopes);
    }
  }

  /**
   * Gate a live `event` frame on seq continuity and keep the scope's
   * resume cursor honest. Returns whether the frame should be dispatched.
   *
   * The bug this guards against: a frame dropped while the socket stays
   * OPEN (so resume-on-reconnect never fires) used to advance the cursor
   * silently, stranding the UI one-or-more events behind until a manual
   * refresh. We now detect the forward gap and trigger a resume so the
   * server replays the hole in order.
   *
   * Cases (same epoch as the cursor):
   * - `seq === lastSeq + 1` — contiguous. Advance, drop any recovery
   *   latch (the in-order stream has caught up), dispatch.
   * - `seq > lastSeq + 1` — forward gap. Hold the cursor, send a resume
   *   from it, latch `recovering` so subsequent gapped frames coalesce
   *   into this one resume, and swallow the frame (replay redelivers it).
   * - `seq <= lastSeq` — duplicate/stale. Dispatch (the message cache is
   *   idempotent) but don't move the cursor or disturb recovery.
   *
   * A missing baseline or an epoch change is taken as a fresh baseline
   * rather than a gap — epoch transitions arrive via `subscribed` /
   * `snapshot_required` in normal flow.
   */
  private acceptEventFrame(frame: EventFrame): boolean {
    const previous = this.positions.get(frame.scope);

    if (!previous || previous.epoch !== frame.epoch) {
      this.recovering.delete(frame.scope);
      this.recordPosition(frame);
      return true;
    }

    if (frame.seq > previous.lastSeq + 1) {
      if (!this.recovering.has(frame.scope)) {
        this.recovering.add(frame.scope);
        recordEventWsDiagnostic({
          kind: 'live_gap',
          scope: frame.scope,
          eventKind: frame.kind,
          seq: frame.seq,
          lastSeq: previous.lastSeq,
          expectedSeq: previous.lastSeq + 1,
          epoch: frame.epoch,
        });
        this.sendResume({ [frame.scope]: previous });
      }
      return false;
    }

    if (frame.seq === previous.lastSeq + 1) {
      this.recovering.delete(frame.scope);
      this.recordPosition(frame);
      return true;
    }

    // Duplicate / stale: dispatch without advancing the cursor or
    // disturbing an in-flight recovery.
    return true;
  }

  private recordPosition(frame: EventFrame | SubscribedFrame): void {
    const previous = this.positions.get(frame.scope);
    if (
      previous &&
      previous.epoch === frame.epoch &&
      previous.lastSeq >= frame.seq
    ) {
      return;
    }

    this.positions.set(frame.scope, {
      epoch: frame.epoch,
      lastSeq: frame.seq,
    });
  }

  private sendResume(scopes: ResumeFrame['scopes']): void {
    if (Object.keys(scopes).length === 0) return;
    if (!this.sendIfConnected({ type: 'resume', scopes })) return;
    for (const [scope, position] of Object.entries(scopes)) {
      recordEventWsDiagnostic({
        kind: 'resume_sent',
        scope,
        epoch: position.epoch,
        lastSeq: position.lastSeq,
      });
    }
  }

  private sendIfConnected(frame: ClientFrame): boolean {
    if (
      this.status !== 'connected' ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    this.send(frame);
    return true;
  }

  private send(frame: ClientFrame): void {
    if (!this.ws) return;
    this.sendOnSocket(this.ws, frame);
  }

  private sendOnSocket(ws: WebSocket, frame: ClientFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[index]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) void this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: WsClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of Array.from(this.statusListeners)) {
      listener(status);
    }
  }
}

export const eventWsClient = new EventWsClient();

/**
 * Bridges `subscribeViewerScope()` to the canonical `viewer:{id}` key.
 * Each handle owns at most one inner refcounted subscription. While
 * the viewer id is unknown the wrapper is "detached" — `attach()` is
 * a no-op until the next `authenticated` frame supplies the id, at
 * which point the wrapper materialises an inner `subscribe(canonical)`.
 *
 * Idempotency:
 * - `attach()` does nothing if already attached to the same canonical
 *   scope. Calling it on every `authenticated` frame is safe.
 * - `detach()` releases the inner refcount (decrement + possible
 *   unsubscribe). Calling it twice is safe (second call sees
 *   `inner === null`).
 *
 * The wrapper is not exported — callers receive a plain
 * `WsScopeSubscription` from `subscribeViewerScope()`.
 */
class ViewerSubscriber {
  private inner: WsScopeSubscription | null = null;
  private currentScope: string | null = null;

  constructor(private readonly client: EventWsClient) {}

  attach(): void {
    const id = this.client.getResolvedViewerId();
    if (!id) return;
    const scope = `viewer:${id}`;
    if (this.currentScope === scope) return;
    if (this.inner) this.inner.unsubscribe();
    this.inner = this.client.subscribe(scope);
    this.currentScope = scope;
  }

  detach(): void {
    if (this.inner) this.inner.unsubscribe();
    this.inner = null;
    this.currentScope = null;
  }
}

export function connectEventWs(): void {
  eventWsClient.connect();
}

export function subscribeWsScope(scope: SubscribeFrame['scope']): WsScopeSubscription {
  return eventWsClient.subscribe(scope);
}

/**
 * Subscribe to the authenticated viewer's private scope. Internally
 * keyed by the canonical `viewer:{resolvedViewerId}` once the server's
 * `authenticated` frame supplies the id, so disconnects/reconnects
 * resume against the same scope without losing events. The
 * `viewer:self` alias is the on-the-wire form only — never written to
 * the client's `desiredScopes` / `positions` maps. Pair with
 * `isCurrentViewerScope()` for frame-level filtering.
 */
export function subscribeViewerScope(): WsScopeSubscription {
  return eventWsClient.subscribeViewerScope();
}

/**
 * On-the-wire alias the server canonicalises to
 * `viewer:{resolvedViewerId}`. Exposed for documentation / tests; do
 * not pass it to `subscribeWsScope()` directly — call
 * `subscribeViewerScope()` so the client refcounts on the canonical
 * key.
 */
export const VIEWER_SCOPE_ALIAS = 'viewer:self';

/**
 * True iff `scope` is the current viewer's resolved scope. Hooks call
 * this on incoming `event`/`snapshot_required` frames so they don't
 * need to hardcode the viewer's id.
 */
export function isCurrentViewerScope(scope: string): boolean {
  const resolved = eventWsClient.getResolvedViewerId();
  if (!resolved) return false;
  return scope === `viewer:${resolved}`;
}

export function onWsFrame(listener: WsClientListener): () => void {
  return eventWsClient.onFrame(listener);
}

export function onWsStatus(listener: WsStatusListener): () => void {
  return eventWsClient.onStatus(listener);
}

function recordEventWsDiagnostic(input: EventWsDiagnostic): void {
  if (typeof window === 'undefined') return;
  const recorder = window.agentHub?.recordEventWsDiagnostic;
  if (!recorder) return;
  void recorder(input).catch(() => {
    // Diagnostics must never affect the live WS delivery path.
  });
}

function eventWsUrl(baseUrl: string): string {
  const url = new URL(EVENT_WS_PATH, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as ServerFrame;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
