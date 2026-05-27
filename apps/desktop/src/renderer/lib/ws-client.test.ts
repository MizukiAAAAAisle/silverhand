import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module BEFORE importing the client so its module-level
// import of `getBackendInfo` resolves to our stub. This must precede
// the dynamic import below.
vi.mock('./api', () => ({
  getBackendInfo: vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:1234',
    mode: 'embedded',
    local_host_id: 'host-local',
    local_host_status: 'claimed',
    local_host_ws_attached_at: null,
  }),
}));

import { EventWsClient } from './ws-client';

/**
 * Minimal WebSocket double: records outbound frames in `sent`, exposes
 * `fireOpen()` / `fireMessage()` / `fireClose()` helpers so the test
 * drives the lifecycle deterministically. Mirrors the static
 * `OPEN/CONNECTING/CLOSED` constants the real `WebSocket` exposes
 * because ws-client.ts checks them directly via `WebSocket.OPEN`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  /** Parsed JSON of every frame the client sent on this socket. */
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(public readonly url: string) {}

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  // Test-only drivers ──────────────────────────────────────────────

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  fireMessage(frame: Record<string, unknown>): void {
    this.dispatch('message', { data: JSON.stringify(frame) });
  }

  fireClose(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  private dispatch(type: string, ev: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) fn(ev);
  }
}

/** Stash the original global WebSocket so we can restore it. */
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

let createdSockets: FakeWebSocket[] = [];
/** Track every client we construct so we can `disconnect()` it after
 *  each test — that clears any pending reconnect `setTimeout`, which
 *  would otherwise fire in a later test, push a stray socket into the
 *  fresh `createdSockets` array, and break length assertions. */
const liveClients: EventWsClient[] = [];

function makeClient(): EventWsClient {
  const c = new EventWsClient();
  liveClients.push(c);
  return c;
}

function installFakeWebSocket(): void {
  createdSockets = [];
  const ctor = function (this: unknown, url: string): FakeWebSocket {
    const ws = new FakeWebSocket(url);
    createdSockets.push(ws);
    return ws;
  } as unknown as typeof WebSocket;
  // The client checks `ws.readyState === WebSocket.OPEN` against the
  // global constructor's static constants — keep them aligned with the
  // fake's instance values.
  Object.assign(ctor, {
    CONNECTING: FakeWebSocket.CONNECTING,
    OPEN: FakeWebSocket.OPEN,
    CLOSING: FakeWebSocket.CLOSING,
    CLOSED: FakeWebSocket.CLOSED,
  });
  (globalThis as { WebSocket?: unknown }).WebSocket = ctor;
}

function restoreWebSocket(): void {
  if (originalWebSocket === undefined) {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  } else {
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
}

/**
 * Wait for `openSocket()`'s `await getBackendInfo()` microtask plus
 * the subsequent `new WebSocket(...)` to be observable. A single
 * `await Promise.resolve()` isn't enough because there's an async fn
 * + an awaited promise chain.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  installFakeWebSocket();
});

afterEach(() => {
  while (liveClients.length > 0) {
    liveClients.pop()!.disconnect();
  }
  restoreWebSocket();
});

describe('EventWsClient — viewer scope canonicalisation', () => {
  /**
   * The B1 contract: whatever the renderer subscribes to via
   * `subscribeViewerScope()` must end up keyed by the canonical
   * `viewer:<id>` everywhere internal — `desiredScopes` /
   * `confirmedScopes` / `positions`. The on-the-wire form
   * `viewer:self` must NEVER appear in subsequent client→server
   * frames once `authenticated` has supplied the id.
   */
  it('subscribes against canonical viewer:<id> after authenticated', async () => {
    const client = makeClient();

    // Subscribe BEFORE the connection has completed — this is the hot
    // path: hooks mount during initial render, viewer hydration is async.
    client.subscribeViewerScope();

    await flushMicrotasks();
    expect(createdSockets).toHaveLength(1);
    const ws = createdSockets[0]!;

    ws.fireOpen();
    // Auth is owned by Electron main's HttpOnly websocket cookie; the
    // renderer must not send any bearer-bearing frame.
    expect(ws.sent).toEqual([]);

    ws.fireMessage({
      type: 'authenticated',
      viewerId: 'abcdef0123456789',
      epoch: 'epoch-1',
    });

    // After authenticated, the client should have sent a `subscribe`
    // frame keyed by canonical `viewer:<id>`. The alias `viewer:self`
    // must NOT appear anywhere on the wire.
    const subscribeFrames = ws.sent.filter(f => f.type === 'subscribe');
    expect(subscribeFrames).toEqual([
      { type: 'subscribe', scope: 'viewer:abcdef0123456789' },
    ]);

    expect(client.getResolvedViewerId()).toBe('abcdef0123456789');
  });

  /**
   * The actual B1 blocker: events accumulated against the canonical
   * scope must be re-claimed via a `resume` frame on reconnect.
   * Pre-fix, `desiredScopes` was keyed by alias and `positions` by
   * canonical, so `resubscribeDesiredScopes` would send `subscribe
   * viewer:self` again but never carry over the lastSeq.
   */
  it('reconnect resume frame carries canonical viewer:<id> with last seq', async () => {
    const client = makeClient();
    client.subscribeViewerScope();

    await flushMicrotasks();
    const ws1 = createdSockets[0]!;
    ws1.fireOpen();
    ws1.fireMessage({
      type: 'authenticated',
      viewerId: 'u-alice',
      epoch: 'epoch-1',
    });

    // Server confirms the canonical subscription and pushes an event.
    ws1.fireMessage({
      type: 'subscribed',
      scope: 'viewer:u-alice',
      epoch: 'epoch-1',
      seq: 7,
    });
    ws1.fireMessage({
      type: 'event',
      scope: 'viewer:u-alice',
      epoch: 'epoch-1',
      seq: 10,
      kind: 'unread_updated',
      payload: {},
    });

    // Simulate transient network loss (NOT explicit disconnect — the
    // wrapper handle stays live, viewerSubscribers retain currentScope
    // so reconnect re-authenticated is a no-op attach).
    ws1.fireClose();

    // The reconnect timer fires after a delay; bypass it by calling
    // connect() directly (idempotent — `shouldReconnect` is still true,
    // status flipped to 'disconnected'). connect() kicks off a new
    // openSocket().
    client.connect();
    await flushMicrotasks();
    expect(createdSockets).toHaveLength(2);
    const ws2 = createdSockets[1]!;
    ws2.fireOpen();
    ws2.fireMessage({
      type: 'authenticated',
      viewerId: 'u-alice',
      epoch: 'epoch-2',
    });

    // After re-auth, the resume frame on the new socket MUST include
    // the canonical viewer scope with the last seq we'd recorded. This
    // is the assertion that broke pre-fix.
    const resumeFrames = ws2.sent.filter(f => f.type === 'resume');
    expect(resumeFrames).toHaveLength(1);
    expect(resumeFrames[0]).toEqual({
      type: 'resume',
      scopes: {
        'viewer:u-alice': { epoch: 'epoch-1', lastSeq: 10 },
      },
    });

    // And the subscribe-on-reconnect must also be canonical, never
    // the alias.
    const subscribeFrames = ws2.sent.filter(f => f.type === 'subscribe');
    expect(subscribeFrames).toEqual([
      { type: 'subscribe', scope: 'viewer:u-alice' },
    ]);
  });

  /**
   * Defensive: the literal `'viewer:self'` alias must never leak into
   * any client→server frame on either socket. The fix's value
   * proposition is purely "alias kept at the boundary", so a regex
   * sweep across all sent frames is the cleanest drift guard.
   */
  it('never emits viewer:self alias on the wire after authenticated', async () => {
    const client = makeClient();
    client.subscribeViewerScope();

    await flushMicrotasks();
    const ws1 = createdSockets[0]!;
    ws1.fireOpen();
    ws1.fireMessage({
      type: 'authenticated',
      viewerId: 'u-bob',
      epoch: 'epoch-1',
    });
    ws1.fireMessage({
      type: 'event',
      scope: 'viewer:u-bob',
      epoch: 'epoch-1',
      seq: 3,
      kind: 'saved_changed',
      payload: {},
    });
    ws1.fireClose();

    client.connect();
    await flushMicrotasks();
    const ws2 = createdSockets[1]!;
    ws2.fireOpen();
    ws2.fireMessage({
      type: 'authenticated',
      viewerId: 'u-bob',
      epoch: 'epoch-2',
    });

    const allSent = [...ws1.sent, ...ws2.sent];
    const offenders = allSent.filter(frame =>
      JSON.stringify(frame).includes('viewer:self'),
    );
    expect(offenders).toEqual([]);
  });
});
