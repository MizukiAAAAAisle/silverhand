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
    this.connect();
    if (
      previousCount === 0 ||
      (this.status === 'connected' && !this.confirmedScopes.has(scope))
    ) {
      this.sendIfConnected({ type: 'subscribe', scope });
    }

    return {
      unsubscribe: () => {
        const count = this.desiredScopes.get(scope) ?? 0;
        if (count <= 1) {
          this.desiredScopes.delete(scope);
          this.positions.delete(scope);
          this.confirmedScopes.delete(scope);
          this.sendIfConnected({ type: 'unsubscribe', scope });
        } else {
          this.desiredScopes.set(scope, count - 1);
        }
      },
    };
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
    let token: string;
    try {
      const info = await getBackendInfo();
      url = eventWsUrl(info.url);
      token = info.auth_token;
    } catch {
      this.scheduleReconnect();
      return;
    }

    if (!this.shouldReconnect) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.confirmedScopes.clear();

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.setStatus('authenticating');
      this.sendOnSocket(ws, { type: 'auth', token });
    });

    ws.addEventListener('message', raw => {
      if (this.ws !== ws) return;
      const frame = parseServerFrame(raw.data);
      if (!frame) return;
      this.handleFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.confirmedScopes.clear();
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
      this.resolvedViewerId = frame.viewerId;
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
      this.recordPosition(frame);
    } else if (frame.type === 'event') {
      this.recordPosition(frame);
    } else if (frame.type === 'snapshot_required') {
      this.positions.delete(frame.scope);
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
    this.sendIfConnected({ type: 'resume', scopes });
  }

  private sendIfConnected(frame: ClientFrame): void {
    if (
      this.status !== 'connected' ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.send(frame);
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
 * need to hardcode the viewer's id (it's a random hex written by
 * `POST /api/register`).
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
