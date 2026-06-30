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
    // D3.c Commit 4 — `BackendInfo` snapshot now carries the
    // daemon-config `server_url` view. ws-client doesn't read this
    // field, but the mock matches the typed surface so future typed
    // mocks (and the structural twin between `preload/index.ts` and
    // `api.d.ts`) stay in sync.
    local_host_server_url: 'http://127.0.0.1:1234',
  }),
}));

import { EventWsClient, type WsScopeSubscription } from './ws-client';

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
    // Seqs are per-scope contiguous (see scope-event-bus `nextSeq`), so the
    // event after a `subscribed` at seq 9 is seq 10 — the client now treats
    // a non-contiguous jump as a dropped-frame gap (#1241), not normal flow.
    ws1.fireMessage({
      type: 'subscribed',
      scope: 'viewer:u-alice',
      epoch: 'epoch-1',
      seq: 9,
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

/**
 * #1241 — live forward-gap recovery. A frame dropped while the socket
 * stays OPEN (so reconnect/resume never fires) used to advance the
 * cursor silently, stranding the UI behind until a manual refresh. The
 * client now detects the seq discontinuity and resumes in place.
 */
describe('EventWsClient — live forward-gap recovery', () => {
  /** Seqs of `event` frames that actually reached `onFrame` listeners. */
  function eventSeqs(frames: Array<Record<string, unknown>>): number[] {
    return frames
      .filter(f => f.type === 'event')
      .map(f => f.seq as number);
  }

  function fireEvent(
    ws: FakeWebSocket,
    scope: string,
    seq: number,
    epoch = 'epoch-1',
  ): void {
    ws.fireMessage({ type: 'event', scope, epoch, seq, kind: 'message', payload: {} });
  }

  /**
   * Bring a client to `connected`, subscribed to `scope`, with the
   * resume cursor baselined at `seq` (via a `subscribed` frame). Returns
   * the captured dispatch log and the socket with its outbound buffer
   * cleared, so later `resume`/dispatch assertions only see gap traffic.
   */
  async function connectedAt(
    scope: string,
    seq: number,
  ): Promise<{
    client: EventWsClient;
    ws: FakeWebSocket;
    sub: WsScopeSubscription;
    dispatched: Array<Record<string, unknown>>;
  }> {
    const client = makeClient();
    const dispatched: Array<Record<string, unknown>> = [];
    client.onFrame(f => dispatched.push(f as unknown as Record<string, unknown>));
    const sub = client.subscribe(scope);
    await flushMicrotasks();
    const ws = createdSockets[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'authenticated', viewerId: 'u', epoch: 'epoch-1' });
    ws.fireMessage({ type: 'subscribed', scope, epoch: 'epoch-1', seq });
    ws.sent.length = 0;
    return { client, ws, sub, dispatched };
  }

  it('dispatches contiguous events and advances without resuming', async () => {
    const { ws, dispatched } = await connectedAt('conv:room', 5);

    fireEvent(ws, 'conv:room', 6);
    fireEvent(ws, 'conv:room', 7);
    fireEvent(ws, 'conv:room', 8);

    expect(eventSeqs(dispatched)).toEqual([6, 7, 8]);
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(0);
  });

  it('swallows a gapped frame and resumes from the held cursor', async () => {
    const { ws, dispatched } = await connectedAt('conv:room', 5);

    // seq 9 with cursor at 5 → 6/7/8 were dropped on the open socket.
    fireEvent(ws, 'conv:room', 9);

    // The gapped frame must NOT be dispatched ahead of the missing ones…
    expect(eventSeqs(dispatched)).toEqual([]);
    // …and a resume from the held cursor (5, not 9) must be sent.
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 5 } } },
    ]);

    // Server replays the hole in order; everything dispatches once, in order.
    for (const seq of [6, 7, 8, 9]) fireEvent(ws, 'conv:room', seq);
    expect(eventSeqs(dispatched)).toEqual([6, 7, 8, 9]);

    // Recovery latch dropped: a later contiguous live frame flows normally.
    fireEvent(ws, 'conv:room', 10);
    expect(eventSeqs(dispatched)).toEqual([6, 7, 8, 9, 10]);
  });

  it('clears recovery on snapshot_required and re-baselines from it', async () => {
    const { ws, dispatched } = await connectedAt('conv:room', 5);

    fireEvent(ws, 'conv:room', 9); // gap → resume + recovering latch
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(1);

    // Replay buffer too small → server gives up on the gap.
    ws.fireMessage({
      type: 'snapshot_required',
      scope: 'conv:room',
      epoch: 'epoch-1',
      reason: 'gap_too_large',
    });

    // The frame reaches listeners so conversation hooks can refetch.
    expect(
      dispatched.some(f => f.type === 'snapshot_required' && f.scope === 'conv:room'),
    ).toBe(true);

    // Cursor wiped + latch cleared: the next event re-baselines (no stale
    // gap detection against the deleted cursor, no leftover suppression).
    ws.sent.length = 0;
    fireEvent(ws, 'conv:room', 20);
    expect(eventSeqs(dispatched)).toContain(20);
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(0);
  });

  it('coalesces concurrent gapped frames into a single in-flight resume', async () => {
    const { ws, dispatched } = await connectedAt('conv:room', 5);

    // Three live frames land while the gap is open, before any replay.
    fireEvent(ws, 'conv:room', 9);
    fireEvent(ws, 'conv:room', 10);
    fireEvent(ws, 'conv:room', 11);

    // Exactly one resume — the latch suppressed the redundant two.
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(1);
    expect(eventSeqs(dispatched)).toEqual([]);

    // Replay fills the hole in order; a fresh live frame follows.
    for (const seq of [6, 7, 8, 9, 10, 11]) fireEvent(ws, 'conv:room', seq);
    fireEvent(ws, 'conv:room', 12);

    expect(eventSeqs(dispatched)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    // Still only ever one resume across the whole episode.
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(1);
  });
});

/**
 * #1251 — no-listener gap. When a scope's last subscriber goes away
 * (component unmount) and resubscribes (remount), events published in the
 * gap used to be lost: `unsubscribe()` dropped the per-scope cursor, so the
 * next `subscribe()` re-baselined to server head off the `subscribed` ack,
 * silently skipping anything published while no listener was attached. The
 * pre-existing transport bug (`646d223`) was exposed/amplified by the
 * inbox/Activity churn that mounts and unmounts conversation views far more
 * often.
 *
 * The fix: the transport cursor is client-authoritative. `unsubscribe()`
 * retains `positions[scope]`; `subscribe()` pairs a `resume` from it so the
 * server replays the gap; the `subscribed` ack does NOT re-baseline a
 * retained same-epoch cursor. Retained-but-detached cursors are bounded by
 * an LRU so they can't grow without limit — eviction degrades to a fresh
 * ack baseline, never a silent skip.
 *
 * Three-axis discipline (the #1244 "surfaced ≠ eliminated" failure class,
 * re-asserted at the transport layer): replay only touches the transport
 * frame cursor. It NEVER writes the read cursor or directed `read_at` — a
 * replayed frame is byte-identical to a live one and read-inert by
 * construction. "补帧『可得』≠『已读』".
 */
describe('EventWsClient — no-listener gap recovery (#1251)', () => {
  function eventSeqs(frames: Array<Record<string, unknown>>): number[] {
    return frames.filter(f => f.type === 'event').map(f => f.seq as number);
  }

  function fireEvent(
    ws: FakeWebSocket,
    scope: string,
    seq: number,
    epoch = 'epoch-1',
  ): void {
    ws.fireMessage({ type: 'event', scope, epoch, seq, kind: 'message', payload: {} });
  }

  async function connectedAt(
    scope: string,
    seq: number,
  ): Promise<{
    client: EventWsClient;
    ws: FakeWebSocket;
    sub: WsScopeSubscription;
    dispatched: Array<Record<string, unknown>>;
  }> {
    const client = makeClient();
    const dispatched: Array<Record<string, unknown>> = [];
    client.onFrame(f => dispatched.push(f as unknown as Record<string, unknown>));
    const sub = client.subscribe(scope);
    await flushMicrotasks();
    const ws = createdSockets[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'authenticated', viewerId: 'u', epoch: 'epoch-1' });
    ws.fireMessage({ type: 'subscribed', scope, epoch: 'epoch-1', seq });
    ws.sent.length = 0;
    return { client, ws, sub, dispatched };
  }

  it('retains the cursor across unsubscribe and replays the gap on resubscribe', async () => {
    const { client, ws, sub, dispatched } = await connectedAt('conv:room', 5);

    // A live event advances the cursor to 6.
    fireEvent(ws, 'conv:room', 6);
    expect(eventSeqs(dispatched)).toEqual([6]);

    // Last subscriber goes away (unmount). The unsubscribe frame goes out
    // but the cursor must be RETAINED for the eventual remount.
    sub.unsubscribe();
    expect(ws.sent.filter(f => f.type === 'unsubscribe')).toEqual([
      { type: 'unsubscribe', scope: 'conv:room' },
    ]);
    ws.sent.length = 0;

    // [server publishes seq 7, 8 here — no listener attached: the gap.]

    // Remount. The resubscribe must re-subscribe AND resume from the
    // retained cursor (6) so the server replays the gap — not re-baseline
    // to head and skip it.
    client.subscribe('conv:room');
    expect(ws.sent.filter(f => f.type === 'subscribe')).toEqual([
      { type: 'subscribe', scope: 'conv:room' },
    ]);
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 6 } } },
    ]);

    // Server replays the hole in order; every gap event dispatches once.
    for (const seq of [7, 8]) fireEvent(ws, 'conv:room', seq);
    expect(eventSeqs(dispatched)).toEqual([6, 7, 8]);
  });

  it('does not let the subscribed ack re-baseline a retained same-epoch cursor', async () => {
    const { client, ws, sub } = await connectedAt('conv:room', 5);
    fireEvent(ws, 'conv:room', 6); // cursor → {epoch-1, 6}
    sub.unsubscribe();
    ws.sent.length = 0;

    client.subscribe('conv:room'); // subscribe + resume{6}

    // Server acks the resubscription at its current head (8) before the
    // replay lands. The ack must NOT advance the retained cursor to 8.
    ws.fireMessage({ type: 'subscribed', scope: 'conv:room', epoch: 'epoch-1', seq: 8 });
    ws.sent.length = 0;

    // A forward-gapped live frame reveals where the cursor actually sits:
    // if the ack had clobbered it to 8, seq 9 would be contiguous (no
    // resume). Because the cursor is still the client-authoritative 6, seq 9
    // is a forward gap and resumes from 6.
    fireEvent(ws, 'conv:room', 9);
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 6 } } },
    ]);
  });

  it('re-baselines from the ack when the retained cursor is from a stale epoch', async () => {
    const { client, ws, sub } = await connectedAt('conv:room', 5);
    fireEvent(ws, 'conv:room', 6); // cursor → {epoch-1, 6}
    sub.unsubscribe();
    ws.sent.length = 0;

    client.subscribe('conv:room');
    // New epoch (server buffer rotated) — the retained epoch-1 cursor is
    // moot; baseline fresh from the new-epoch ack. (The resume{epoch-1,6}
    // we optimistically sent self-heals server-side via snapshot_required.)
    ws.fireMessage({ type: 'subscribed', scope: 'conv:room', epoch: 'epoch-2', seq: 50 });
    ws.sent.length = 0;

    // Contiguous in the new epoch from 50 → dispatch, no gap/resume.
    fireEvent(ws, 'conv:room', 51, 'epoch-2');
    expect(ws.sent.filter(f => f.type === 'resume')).toHaveLength(0);
  });

  it('retains detached cursors for the whole session (no lossy eviction)', async () => {
    // A bounded LRU here would re-create the no-listener gap: an evicted
    // scope resubscribes with no `resume`, the server never emits
    // `snapshot_required`, and the `subscribed` ack baselines to head —
    // silently skipping gap traffic. So cursors are retained for the
    // session; this guards that the oldest detached scope still resumes
    // even after far more detach/resubscribe churn than any past LRU bound.
    const CHURN = 200; // well past the old cap of 64

    const client = makeClient();
    client.subscribe('conv:keep'); // a live scope, just to drive connect()
    await flushMicrotasks();
    const ws = createdSockets[0]!;
    ws.fireOpen();
    ws.fireMessage({ type: 'authenticated', viewerId: 'u', epoch: 'epoch-1' });

    // The oldest detached scope: subscribe, give it a cursor, detach first.
    const oldest = 'conv:oldest';
    const osub = client.subscribe(oldest);
    ws.fireMessage({ type: 'subscribed', scope: oldest, epoch: 'epoch-1', seq: 7 });
    osub.unsubscribe();

    // Churn far more scopes through detach than any LRU bound would hold.
    for (let i = 0; i < CHURN; i++) {
      const scope = `conv:churn${i}`;
      const sub = client.subscribe(scope);
      ws.fireMessage({ type: 'subscribed', scope, epoch: 'epoch-1', seq: 1 });
      sub.unsubscribe();
    }
    ws.sent.length = 0;

    // The oldest scope's cursor must still be retained → resubscribe resumes
    // from it (7), never a silent baseline-to-head.
    client.subscribe(oldest);
    expect(ws.sent.filter(f => f.type === 'subscribe')).toEqual([
      { type: 'subscribe', scope: oldest },
    ]);
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:oldest': { epoch: 'epoch-1', lastSeq: 7 } } },
    ]);
  });

  // ── Orphan-scope gate (#1251 round-2 dogfood) ──────────────────────────
  //
  // The cursor must be the "applied-to-active-scope high-water", NOT the
  // "socket-received high-water". When a view unmounts, the scope leaves
  // `desiredScopes` (cursor retained) and the bridge listener detaches, but
  // the socket stays OPEN and the server keeps fanning out until it processes
  // the unsubscribe. A frame landing in that race window has no consumer; if
  // it advanced the cursor (or a late ack re-baselined / late snapshot
  // refetched), the cursor would move past a never-applied frame and the
  // resubscribe would resume *after* it — losing it until a manual refetch.
  // This was the dropped R2-C1 (a live message published ~2s before the
  // client switched away). Orphan frames for non-desired scopes must be
  // ignored entirely.

  it('ignores an orphan event after unsubscribe — cursor frozen at last applied seq', async () => {
    const { client, ws, sub, dispatched } = await connectedAt('conv:room', 5);
    fireEvent(ws, 'conv:room', 6); // applied while desired → cursor 6
    expect(eventSeqs(dispatched)).toEqual([6]);

    // View unmounts: scope leaves desiredScopes, cursor retained at 6.
    sub.unsubscribe();
    ws.sent.length = 0;

    // Race-window frame: server hasn't processed the unsubscribe yet, so seq
    // 7 still arrives. No consumer → it must NOT dispatch and must NOT
    // advance the cursor.
    fireEvent(ws, 'conv:room', 7);
    expect(eventSeqs(dispatched)).toEqual([6]); // 7 swallowed, not dispatched

    // Resubscribe: resume from the frozen cursor (6, not 7) so the server
    // replays seq 7. If the orphan had advanced the cursor to 7, this resume
    // would read lastSeq:7 and 7 would be lost — exactly the R2-C1 bug.
    client.subscribe('conv:room');
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 6 } } },
    ]);
  });

  it('ignores a late subscribed ack for a no-longer-desired scope (no re-baseline)', async () => {
    const { client, ws, sub } = await connectedAt('conv:room', 5);
    fireEvent(ws, 'conv:room', 6); // cursor 6
    sub.unsubscribe();
    ws.sent.length = 0;

    // A subscribed ack from the just-cancelled subscription lands late, at
    // server head (50). Scope is no longer desired → it must not
    // confirm/baseline; the retained cursor stays 6.
    ws.fireMessage({ type: 'subscribed', scope: 'conv:room', epoch: 'epoch-1', seq: 50 });

    client.subscribe('conv:room');
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 6 } } },
    ]);
  });

  it('ignores a late snapshot_required for a no-longer-desired scope (cursor kept)', async () => {
    const { client, ws, sub } = await connectedAt('conv:room', 5);
    fireEvent(ws, 'conv:room', 6); // cursor 6
    sub.unsubscribe();
    ws.sent.length = 0;

    // A snapshot_required for the cancelled scope must not delete the
    // retained cursor (no consumer to refetch); the cursor survives so the
    // next subscribe still resumes.
    ws.fireMessage({
      type: 'snapshot_required',
      scope: 'conv:room',
      epoch: 'epoch-1',
      reason: 'gap_too_large',
    });

    client.subscribe('conv:room');
    expect(ws.sent.filter(f => f.type === 'resume')).toEqual([
      { type: 'resume', scopes: { 'conv:room': { epoch: 'epoch-1', lastSeq: 6 } } },
    ]);
  });
});
