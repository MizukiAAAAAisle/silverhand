import type {
  ClientFrame,
  EventFrame,
  ResumeFrame,
  ServerFrame,
  SubscribedFrame,
  SubscribeFrame,
} from '@silverhand/shared';
import { parseConversationScope } from '@silverhand/shared';
import { getBackendInfo } from './api';

const EVENT_WS_PATH = '/api/ws/events';
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 30_000] as const;

export type WsClientStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected';

/**
 * Delivery provenance of an `event` frame (Stage-2 #1255 §2/§4.1). NOT a wire
 * or payload field — it is transport delivery metadata the ws-client derives
 * from its own received-water: a frame extending the received-water is fresh
 * `live` fanout; a frame at-or-below it is a `backfill` re-delivery (resume /
 * replay-buffer drain). The ingestor branches non-idempotent deltas on it
 * (reply-count bump: `+1` on `live`, authoritative recovery on `backfill`),
 * so the wire `event` frame and `MessageDto` stay byte-identical.
 * See docs/event-ws-transport-v1.md §2.
 */
export type EventDeliveryProvenance = 'live' | 'backfill';

/** Delivery metadata attached to a dispatched `event` frame (undefined for
 *  non-event frames). See {@link EventDeliveryProvenance}. */
export interface EventDeliveryMeta {
  provenance: EventDeliveryProvenance;
}

export type WsClientListener = (
  frame: ServerFrame,
  meta?: EventDeliveryMeta,
) => void;
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
  | 'snapshot_required'
  | 'orphan_frame';

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
 *
 * ── Transport cursor model (Stage-2 #1255 P2 step-4) ────────────────────────
 * Per scope the client tracks TWO water marks, not one (docs/event-ws-transport-v1.md
 * §4.1). They exist only to serve different jobs the old single cursor conflated:
 *
 * - `receivedPositions[scope]` — the highest seq contiguously RECEIVED on the
 *   socket. Advanced in `acceptEventFrame` on every in-order desired-scope
 *   frame. Serves wire-continuity / forward-gap detection ONLY, and derives
 *   delivery provenance (a frame at-or-below it is a `backfill` re-delivery). It
 *   is NOT a resume floor.
 * - `appliedPositions[scope]` — the resume FLOOR (what `resume` replays from).
 *   For a CONTENT-GATED scope (`conversation:<id>`, the message stream) it is
 *   advanced ONLY by `markApplied` (a real content write) or `commitSnapshotBaseline`
 *   (an apply-settled snapshot re-cold-start) — never by frame receipt. For every
 *   OTHER scope (viewer / workspace / app / `conversation-side:`) there is no
 *   content-apply seam, so the floor auto-advances with `received` (the pre-P2
 *   single-cursor behavior, preserved bit-for-bit).
 *
 * The two coincide for auto-advance scopes and while a content reader applies
 * every frame; they diverge when a content-gated scope receives a frame that
 * writes no warm content (no reader / off-window no-op) — `received` advances so
 * the stream keeps flowing and gaps stay detectable, `applied` stays pinned so a
 * resume re-delivers the un-applied frame (idempotent) rather than skipping it
 * (the #1251 class of bug). See docs/event-ws-transport-v1.md §1/§4.1/§5/§6.
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
  /** Wire-continuity / gap-detection high-water (see class docstring). */
  private readonly receivedPositions = new Map<string, ResumePosition>();
  /** Resume floor (see class docstring). The ONLY thing `resume` replays from. */
  private readonly appliedPositions = new Map<string, ResumePosition>();
  /**
   * Server-stamped transport baseline for an in-flight `snapshot_required`
   * re-cold-start on a content-gated scope (§6). Recorded on receipt but NOT
   * committed to `appliedPositions` until the ingestor signals its REST
   * reconcile settled via `commitSnapshotBaseline` (apply-gated). While present,
   * live frames for the scope are buffered (`pendingBuffers`) rather than
   * applied, exactly like cold-start.
   */
  private readonly pendingBaselines = new Map<string, ResumePosition>();
  /** Frames `> pendingBaselines[scope].lastSeq` held during a snapshot
   *  re-cold-start, drained in seq order once the baseline commits. */
  private readonly pendingBuffers = new Map<string, EventFrame[]>();
  private readonly confirmedScopes = new Set<string>();
  /**
   * Scopes with a forward-gap recovery in flight. When a live `event`
   * frame arrives beyond the next expected seq we hold the received-water,
   * ask the server to replay from the applied floor, and latch the scope here
   * so every further gapped frame coalesces into the one in-flight resume
   * instead of firing a redundant one. The latch drops as soon as the in-order
   * replay delivers the next contiguous seq (see `acceptEventFrame`).
   */
  private readonly recovering = new Set<string>();
  /**
   * Live `subscribeViewerScope()` handles. Each holds a deferred inner
   * subscription that materialises against the canonical
   * `viewer:{resolvedViewerId}` scope once the server's `authenticated`
   * frame arrives. Keeping the indirection out of `subscribe()` itself
   * means the position maps / `desiredScopes` / `confirmedScopes` only ever
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
    this.clearConnectionState();
    this.resolvedViewerId = null;
    // Detach viewer wrappers so the canonical `viewer:<id>` subscription
    // state — desiredScopes refcount + confirmed — is released. The
    // resume floor (`appliedPositions`) and received-water are deliberately
    // retained so a later resume can replay; wrappers re-attach on the next
    // connect() → authenticated cycle if the wrapper handle is still live.
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
      this.sendSubscribe(scope);
    }

    return {
      unsubscribe: () => {
        const count = this.desiredScopes.get(scope) ?? 0;
        if (count <= 1) {
          this.desiredScopes.delete(scope);
          this.confirmedScopes.delete(scope);
          this.recovering.delete(scope);
          // A recovery in flight is abandoned (no consumer to reconcile).
          this.pendingBaselines.delete(scope);
          this.pendingBuffers.delete(scope);
          // Retain the resume floor (`appliedPositions`) AND the received-water
          // — do NOT delete them. The retained floor is what lets the next
          // resubscribe resume and replay the no-listener gap (#task:1251); the
          // received-water lets gap detection continue seamlessly. Cost is a
          // scope string + a few primitives, negligible even at 10× the
          // conversations a session ever opens. A bounded LRU is deliberately
          // NOT used: a bare evict re-creates the no-listener gap (an evicted
          // scope resubscribes with no `resume`, the server has no reason to
          // emit `snapshot_required`, and the `subscribed` ack baselines to head
          // — silently skipping gap traffic). If memory ever forces a bound it
          // must carry a tombstone → forced snapshot, never a bare delete (see
          // docs/event-ws-transport-v1.md §4).
          this.sendIfConnected({ type: 'unsubscribe', scope });
        } else {
          this.desiredScopes.set(scope, count - 1);
        }
      },
    };
  }

  /**
   * Send a `subscribe` for the scope and, when we hold a retained resume
   * floor for it, a paired `resume` from that floor (#task:1251). The resume
   * makes the server replay events published while no listener was
   * attached; without it the `subscribed` ack would re-baseline to head
   * and skip them. No-op until connected — a disconnected subscribe is
   * (re)issued, floor and all, by `resubscribeDesiredScopes()` on the
   * next `authenticated` frame.
   */
  private sendSubscribe(scope: string): void {
    if (!this.sendIfConnected({ type: 'subscribe', scope })) return;
    const floor = this.appliedPositions.get(scope);
    if (floor) this.sendResume({ [scope]: floor });
  }

  /**
   * Subscribe to the resolved viewer's private scope. Returns a handle
   * that immediately participates in refcounting on the canonical
   * `viewer:{id}` scope when the viewer id is already resolved, and
   * otherwise materialises on the next `authenticated` frame. The
   * caller never sees the alias key — it stays an over-the-wire detail
   * so the position maps / `desiredScopes` / `confirmedScopes` are
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
    this.appliedPositions.set(scope, position);
    this.receivedPositions.set(scope, position);
    this.sendResume({ [scope]: position });
  }

  /**
   * Advance a CONTENT-GATED scope's resume floor after the ingestor applied a
   * frame to a resume-recoverable content cache (Stage-2 #1255 §4.1). This is
   * the SOLE content-driven writer of `appliedPositions` — the ingestor calls
   * it exactly once per frame that produced ≥1 real content write, never on a
   * no-op / readerless / derived-invalidate frame.
   *
   * Advance is STRICT-CONTIGUOUS (v1 option-1, simple-safe): the floor moves to
   * `seq` only when `seq === floor + 1`. A skipped seq — an un-applied no-op, a
   * readerless frame, or a pending backfill delta awaiting authoritative
   * recovery — PINS the floor; it releases only via the covering
   * `snapshot_required` → `commitSnapshotBaseline` path (§6). We deliberately
   * never set-max: jumping the floor past an un-applied seq would silently skip
   * content on the next resume (a #1251 re-entry). A false positive is forbidden
   * always; the conservative pin (bounded, idempotent redundant replay) is the
   * accepted cost — correctness over efficiency. Option-2's pending-satisfaction
   * queue (advance contiguously absorbing already-applied later frames) is
   * deferred. Non-content-gated scopes have no content-apply seam and are ignored
   * here (their floor auto-advances in `acceptEventFrame`).
   */
  markApplied(scope: string, seq: number, epoch: string): void {
    if (!isContentGated(scope)) return;
    const floor = this.appliedPositions.get(scope);
    if (!floor || floor.epoch !== epoch) {
      // No same-epoch floor yet. Normal cold-start baselines the floor from the
      // `subscribed` ack, so this is a rare post-epoch-reset fallback where the
      // first apply establishes it.
      this.appliedPositions.set(scope, { epoch, lastSeq: seq });
      return;
    }
    if (seq === floor.lastSeq + 1) {
      this.appliedPositions.set(scope, { epoch, lastSeq: seq });
    }
  }

  /**
   * Commit an in-flight `snapshot_required` re-cold-start for a content-gated
   * scope (Stage-2 #1255 §6). The ingestor calls this once its REST reconcile
   * for every target in the scope has SETTLED (its `Promise.allSettled` join is
   * all-fulfilled) — the transport→ingestor bounded-context boundary: the
   * renderer signals "content committed", the transport translates that into
   * advancing the floor to the server-stamped transport seq it stashed in
   * `pendingBaselines`.
   *
   * Apply-gated and epoch-checked: a stale-epoch or no-pending signal is
   * discarded (a newer epoch superseded the recovery, or a double-signal). On a
   * match the floor + received-water jump to the pending baseline, and any live
   * frames buffered past it during recovery drain in seq order — released to the
   * ingestor as fresh `live` frames.
   */
  commitSnapshotBaseline(scope: string, epoch: string): void {
    const pending = this.pendingBaselines.get(scope);
    if (!pending || pending.epoch !== epoch) return;
    this.appliedPositions.set(scope, { epoch: pending.epoch, lastSeq: pending.lastSeq });
    this.receivedPositions.set(scope, { epoch: pending.epoch, lastSeq: pending.lastSeq });
    this.pendingBaselines.delete(scope);
    this.recovering.delete(scope);
    const buffered = this.pendingBuffers.get(scope) ?? [];
    this.pendingBuffers.delete(scope);
    // Drain buffered live frames (> baseline seq) in transport-seq order. They
    // are genuinely new (never applied) → the `acceptEventFrame` contiguous path
    // tags them `live` and the ingestor applies + `markApplied`s each.
    for (const frame of buffered.sort((a, b) => a.seq - b.seq)) {
      const outcome = this.acceptEventFrame(frame);
      if (outcome.accept) this.dispatch(frame, { provenance: outcome.provenance });
    }
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
    this.clearConnectionState();

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
      this.clearConnectionState();
      this.setStatus('disconnected');
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` follows for network errors; keep the state transition in one path.
    });
  }

  /**
   * Reset the per-connection transient state (subscription acks, in-flight
   * recoveries, snapshot re-cold-start buffers). Deliberately RETAINS the
   * received-water + resume floor so a reconnect can resume/replay. Called on
   * every socket open/close/disconnect so a snapshot recovery never leaks its
   * buffer across connections (it re-arms via a fresh `snapshot_required`).
   */
  private clearConnectionState(): void {
    this.confirmedScopes.clear();
    this.recovering.clear();
    this.pendingBaselines.clear();
    this.pendingBuffers.clear();
  }

  private handleFrame(frame: ServerFrame): void {
    // Orphan-scope gate (#task:1251). Retained through Stage-2 P2: its
    // preconditions for removal are not all met (a view hook still holds an
    // `onWsFrame`), and it stays complementary to the two-watermark model — it
    // pre-filters frames for scopes the client no longer desires, so a
    // post-unsubscribe race frame never touches received-water, floor, or
    // dispatch. Any scope-bearing frame for a non-desired scope is an orphan:
    // ignore it entirely. The retained floor stays frozen at the last applied
    // seq, so the resubscribe's resume replays the gap. See
    // docs/event-ws-transport-v1.md §4.1.
    if (
      (frame.type === 'event' ||
        frame.type === 'subscribed' ||
        frame.type === 'snapshot_required') &&
      !this.desiredScopes.has(frame.scope)
    ) {
      recordEventWsDiagnostic({
        kind: 'orphan_frame',
        scope: frame.scope,
        eventKind: frame.type === 'event' ? frame.kind : frame.type,
        seq: frame.type === 'snapshot_required' ? undefined : frame.seq,
      });
      return;
    }

    let meta: EventDeliveryMeta | undefined;

    if (frame.type === 'authenticated') {
      this.reconnectAttempt = 0;
      this.clearConnectionState();
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
      // The ack confirms the listener is registered; any in-flight gap
      // recovery for the scope is moot.
      this.recovering.delete(frame.scope);
      // Baseline from the ack ONLY when there's no usable retained resume floor.
      // A same-epoch retained floor is client-authoritative: `sendSubscribe`
      // paired a `resume` with it, so the server replays the gap and the ack
      // must NOT re-baseline to server head (the no-listener-gap skip,
      // #task:1251). A floor from a stale epoch is moot — baseline both water
      // marks fresh; a mismatched resume self-heals via snapshot_required.
      const floor = this.appliedPositions.get(frame.scope);
      if (!floor || floor.epoch !== frame.epoch) {
        this.recordReceived(frame);
        this.recordApplied(frame);
      }
      recordEventWsDiagnostic({
        kind: 'subscribed',
        scope: frame.scope,
        seq: frame.seq,
        epoch: frame.epoch,
      });
    } else if (frame.type === 'event') {
      // Snapshot re-cold-start in progress on a content-gated scope: buffer
      // frames past the pending baseline (drained on commit), drop frames the
      // upcoming snapshot already covers, and never dispatch during the pending
      // window (§6, isomorphic to cold-start buffering).
      const pending = isContentGated(frame.scope)
        ? this.pendingBaselines.get(frame.scope)
        : undefined;
      if (pending) {
        if (frame.epoch === pending.epoch && frame.seq > pending.lastSeq) {
          const buffer = this.pendingBuffers.get(frame.scope) ?? [];
          buffer.push(frame);
          this.pendingBuffers.set(frame.scope, buffer);
        }
        // else: covered by the snapshot (≤ baseline seq), or a mismatched-epoch
        // straggler (a yet-newer epoch re-arms via its own snapshot_required) →
        // drop.
        return;
      }

      const outcome = this.acceptEventFrame(frame);
      if (!outcome.accept) {
        // Gap detected (or a frame still beyond the received-water while
        // recovery is in flight): swallow it. The server's in-order replay
        // redelivers it.
        return;
      }
      meta = { provenance: outcome.provenance };
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
      this.recovering.delete(frame.scope);
      if (isContentGated(frame.scope)) {
        // Stage-2 §6: a snapshot_required IS a re-cold-start. Record the
        // server-stamped transport baseline but DO NOT advance the floor now —
        // the commit is apply-gated (waits for the ingestor's reconcile via
        // `commitSnapshotBaseline`). Keep the retained floor pinned meanwhile;
        // buffer live frames > baseline. (Stage-1 deleted the cursor here and
        // let the next event re-baseline — impossible once the floor is
        // markApplied-driven, hence the server-stamped baseline.)
        this.pendingBaselines.set(frame.scope, {
          epoch: frame.epoch,
          lastSeq: frame.currentSeq,
        });
        this.pendingBuffers.delete(frame.scope);
      } else {
        // Non-content-gated scopes keep Stage-1 behavior: they are cursor-inert
        // / self-healing (own REST + invalidate), so drop both water marks and
        // let the next event re-baseline.
        this.appliedPositions.delete(frame.scope);
        this.receivedPositions.delete(frame.scope);
      }
      recordEventWsDiagnostic({
        kind: 'snapshot_required',
        scope: frame.scope,
        reason: frame.reason,
      });
    }

    this.dispatch(frame, meta);
  }

  private dispatch(frame: ServerFrame, meta?: EventDeliveryMeta): void {
    for (const listener of Array.from(this.frameListeners)) {
      listener(frame, meta);
    }
  }

  private resubscribeDesiredScopes(): void {
    for (const scope of this.desiredScopes.keys()) {
      this.send({ type: 'subscribe', scope });
    }
    const resumeScopes: ResumeFrame['scopes'] = {};
    for (const [scope, floor] of this.appliedPositions.entries()) {
      if (!this.desiredScopes.has(scope)) continue;
      resumeScopes[scope] = floor;
    }
    if (Object.keys(resumeScopes).length > 0) {
      this.sendResume(resumeScopes);
    }
  }

  /**
   * Gate a live `event` frame on seq continuity (received-water space) and
   * derive its delivery provenance. Returns whether the frame should be
   * dispatched, and — when it should — whether it is `live` or `backfill`.
   *
   * The bug this guards against: a frame dropped while the socket stays OPEN
   * (so resume-on-reconnect never fires) used to advance the cursor silently,
   * stranding the UI one-or-more events behind until a manual refresh. We detect
   * the forward gap on the received-water and trigger a resume FROM THE APPLIED
   * FLOOR so the server replays the hole in order (and re-delivers any
   * un-applied content below the received-water too — §4.1).
   *
   * Cases (same epoch as the received-water):
   * - `seq === received + 1` — contiguous. Advance received (and, for a
   *   non-content-gated scope, the auto floor), drop any recovery latch, dispatch
   *   as `live` (it extends what we've seen → fresh fanout).
   * - `seq > received + 1` — forward gap. Hold received, resume from the applied
   *   floor, latch `recovering` so subsequent gapped frames coalesce, swallow the
   *   frame (replay redelivers it).
   * - `seq <= received` — a re-delivery by definition (already observed).
   *   Dispatch as `backfill` (idempotent kinds re-apply; the ingestor routes
   *   non-idempotent deltas to authoritative recovery, never `+1`) without moving
   *   any water mark or disturbing recovery.
   *
   * A missing received-water or an epoch change is taken as a fresh baseline
   * (`live`) rather than a gap — epoch transitions arrive via `subscribed` /
   * `snapshot_required` in normal flow.
   */
  private acceptEventFrame(
    frame: EventFrame,
  ): { accept: boolean; provenance: EventDeliveryProvenance } {
    const gated = isContentGated(frame.scope);
    const received = this.receivedPositions.get(frame.scope);

    if (!received || received.epoch !== frame.epoch) {
      this.recovering.delete(frame.scope);
      this.recordReceived(frame);
      // Non-content-gated scopes auto-advance the floor with received (no
      // content-apply seam). Content-gated scopes leave the floor to markApplied.
      if (!gated) this.recordApplied(frame);
      return { accept: true, provenance: 'live' };
    }

    if (frame.seq > received.lastSeq + 1) {
      if (!this.recovering.has(frame.scope)) {
        this.recovering.add(frame.scope);
        recordEventWsDiagnostic({
          kind: 'live_gap',
          scope: frame.scope,
          eventKind: frame.kind,
          seq: frame.seq,
          lastSeq: received.lastSeq,
          expectedSeq: received.lastSeq + 1,
          epoch: frame.epoch,
        });
        // Resume from the applied floor (may lag received), NOT received — so a
        // frame that reached the socket but never applied is re-delivered.
        const floor = this.appliedPositions.get(frame.scope) ?? received;
        this.sendResume({ [frame.scope]: floor });
      }
      return { accept: false, provenance: 'live' };
    }

    if (frame.seq === received.lastSeq + 1) {
      this.recovering.delete(frame.scope);
      this.recordReceived(frame);
      if (!gated) this.recordApplied(frame);
      return { accept: true, provenance: 'live' };
    }

    // seq <= received: a re-delivery (already observed). Dispatch as backfill,
    // move no water mark, disturb no recovery.
    return { accept: true, provenance: 'backfill' };
  }

  private recordReceived(frame: EventFrame | SubscribedFrame): void {
    const previous = this.receivedPositions.get(frame.scope);
    if (
      previous &&
      previous.epoch === frame.epoch &&
      previous.lastSeq >= frame.seq
    ) {
      return;
    }
    this.receivedPositions.set(frame.scope, {
      epoch: frame.epoch,
      lastSeq: frame.seq,
    });
  }

  private recordApplied(frame: EventFrame | SubscribedFrame): void {
    const previous = this.appliedPositions.get(frame.scope);
    if (
      previous &&
      previous.epoch === frame.epoch &&
      previous.lastSeq >= frame.seq
    ) {
      return;
    }
    this.appliedPositions.set(frame.scope, {
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

/**
 * A conversation scope is CONTENT-GATED — its resume floor advances only on a
 * real content apply (`markApplied`) / apply-settled snapshot commit, never on
 * frame receipt (see EventWsClient docstring / docs/event-ws-transport-v1.md
 * §4.1). Only the message-stream scope `conversation:<id>` qualifies; the
 * side-channel `conversation-side:<id>` is cursor-inert (self-healing) and every
 * other scope has no content-apply seam, so all of them auto-advance. Routed
 * through the shared parser only — never a fuzzy `startsWith('conversation')`,
 * which would capture `conversation-side:`.
 */
function isContentGated(scope: string): boolean {
  return parseConversationScope(scope) !== null;
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
 * the client's position maps. Pair with `isCurrentViewerScope()` for
 * frame-level filtering.
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
