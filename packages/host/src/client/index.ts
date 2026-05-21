/**
 * `HostClient` — typed RPC client for talking to `silverhand-daemon`.
 *
 * Consumers see a small surface:
 *
 *   const host = new HostClient({ socketPath })
 *   await host.connect()
 *   const r = await host.ping()
 *   ...
 *   await host.close()
 *
 * Under the hood it owns three things:
 *
 *   1. The transport (Unix socket by default, swappable for tests).
 *   2. A pending-request table: `Map<requestId, { resolve, reject,
 *      timer }>`. Frames coming back from the daemon land here by id.
 *   3. A reconnect loop with exponential backoff. When the transport
 *      fires `disconnect`, all in-flight requests reject with
 *      `disconnected`; we then wait `backoff_ms` and try a fresh
 *      transport. Backoff doubles each failure up to `maxBackoffMs`,
 *      with jitter to avoid thundering-herd if multiple clients
 *      reconnect at once.
 *
 * Why no automatic request retry on reconnect:
 *
 *  - At-least-once delivery is the wrong default for an RPC layer.
 *    Some intents are not idempotent (PR-2's `runtime_start` is the
 *    obvious case). Callers that want retry semantics implement them
 *    on top — usually by re-calling after `onReconnect` fires.
 *
 *  - The reconnect_callbacks hook gives callers exactly that:
 *    `client.onReconnect(() => { ...re-issue idempotent probes... })`.
 *
 * Why ids are random not sequential:
 *
 *  - Sequential ids are tempting (easier to debug) but they'd collide
 *    if two HostClient instances share a socket — and tests do exactly
 *    that. randomBytes(8).base64url is short enough for greppable logs
 *    and collision-free across processes.
 */
import { randomBytes } from 'node:crypto';
import {
  encodeFrame,
  intentSchemas,
  type EventFrame,
  type IntentName,
  type IntentParams,
  type IntentResult,
  type RequestFrame,
  type ResponseError,
  type RuntimeStartParams,
  type RuntimeStopParams,
  type RuntimeWakeParams,
  type RuntimeStatusParams,
  type RuntimeClearSessionParams,
} from '../protocol.js';
import type { DecodedFrame, Transport } from './transport.js';
import { SocketTransport } from './socket-transport.js';

/**
 * Typed error thrown by `HostClient.call()` and friends. Carries the
 * daemon's `ResponseError.code` when the failure came from the daemon,
 * or a synthetic code when the failure is local to the client (timeout,
 * disconnect, never_connected). Callers branch on `.code`.
 */
export class HostClientError extends Error {
  constructor(
    public readonly code: ResponseError['code'] | 'disconnected' | 'timeout' | 'closed',
    message: string,
  ) {
    super(message);
    this.name = 'HostClientError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: HostClientError) => void;
  timer: NodeJS.Timeout;
  intent: string;
}

export interface HostClientLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const NOOP_LOGGER: HostClientLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface HostClientOptions {
  /** Absolute path to the daemon's Unix socket. Required unless
   *  `transportFactory` is supplied (tests). */
  socketPath?: string;
  /** Test seam: override the transport factory. Each call should
   *  return a fresh, unconnected transport — the client manages the
   *  connect lifecycle. */
  transportFactory?: () => Transport;
  /** Per-request timeout. Default 5_000ms. */
  requestTimeoutMs?: number;
  /** Initial reconnect delay. Default 250ms. */
  initialBackoffMs?: number;
  /** Cap on exponential backoff. Default 30_000ms. */
  maxBackoffMs?: number;
  /** Logger. Defaults to silent. */
  logger?: HostClientLogger;
  /** Inject Math.random() substitute for deterministic backoff in tests. */
  rng?: () => number;
}

export class HostClient {
  private readonly transportFactory: () => Transport;
  private readonly requestTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly logger: HostClientLogger;
  private readonly rng: () => number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly reconnectHandlers = new Set<() => void>();
  private readonly eventHandlers = new Set<(event: EventFrame) => void>();
  private transport: Transport | null = null;
  private closed = false;
  /** Resolves once *some* transport reaches connected; replaced on each
   *  reconnect cycle so callers can `await readyPromise` between cycles. */
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectAttempted = false;

  constructor(opts: HostClientOptions) {
    if (!opts.transportFactory && !opts.socketPath) {
      throw new Error('HostClient requires either socketPath or transportFactory');
    }
    this.transportFactory =
      opts.transportFactory ??
      (() => new SocketTransport({ socketPath: opts.socketPath! }));
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.initialBackoffMs = opts.initialBackoffMs ?? 250;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.rng = opts.rng ?? Math.random;
    this.backoffMs = this.initialBackoffMs;
    this.resetReadyPromise();
  }

  /** Open the initial connection. Rejects only if the FIRST connect
   *  attempt fails — subsequent failures go through the reconnect loop
   *  and resolve on the next success. Use `await client.connect()` at
   *  boot to surface "daemon not running" loudly. */
  async connect(): Promise<void> {
    if (this.closed) throw new HostClientError('closed', 'client is closed');
    if (this.connectAttempted) return this.readyPromise!;
    this.connectAttempted = true;
    try {
      await this.openTransport();
    } catch (err) {
      // Reject the readyPromise too so callers awaiting it see the
      // same failure (rather than hanging waiting for a reconnect we
      // haven't yet decided to schedule).
      this.readyReject?.(err as Error);
      throw err;
    }
  }

  /** Register a callback fired AFTER a successful reconnect (not after
   *  the initial connect). Use for re-establishing subscriptions /
   *  re-issuing idempotent probes. Returns an unsubscribe function. */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  isConnected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  /**
   * Typed RPC call. Resolves with the daemon's `result`, rejects with
   * a `HostClientError` whose `.code` is either a daemon-side error
   * code, `disconnected`, `timeout`, or `closed`.
   */
  async call<N extends IntentName>(
    intent: N,
    params: IntentParams<N>,
  ): Promise<IntentResult<N>> {
    if (this.closed) throw new HostClientError('closed', 'client is closed');
    if (!this.transport || !this.transport.isConnected()) {
      throw new HostClientError('disconnected', 'host client is not connected');
    }
    const id = randomBytes(8).toString('base64url');
    const frame: RequestFrame = { id, intent, params };
    const encoded = encodeFrame(frame);
    return new Promise<IntentResult<N>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostClientError('timeout', `intent ${intent} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        intent,
        timer,
        resolve: value => resolve(value as IntentResult<N>),
        reject,
      });
      const ok = this.transport!.write(encoded);
      if (!ok) {
        // Failed to even put bytes on the wire — fail fast.
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(new HostClientError('disconnected', `failed to write intent ${intent}`));
      }
    });
  }

  ping(): Promise<IntentResult<'ping'>> {
    return this.call('ping', {});
  }

  status(): Promise<IntentResult<'status'>> {
    return this.call('status', {});
  }

  echo(message: string): Promise<IntentResult<'echo'>> {
    return this.call('echo', { message });
  }

  // ── PR-2 runtime_* typed helpers ───────────────────────────────
  // Thin wrappers around `call()` so backend code reads
  // `host.runtimeStart({...})` rather than `host.call('runtime_start',
  // {...})`. The typing is identical to the underlying `call()`; the
  // helper just locks the intent name so a typo can't reach the
  // wire.

  runtimeStart(
    params: RuntimeStartParams,
  ): Promise<IntentResult<'runtime_start'>> {
    return this.call('runtime_start', params);
  }

  runtimeStop(
    params: RuntimeStopParams,
  ): Promise<IntentResult<'runtime_stop'>> {
    return this.call('runtime_stop', params);
  }

  runtimeWake(
    params: RuntimeWakeParams,
  ): Promise<IntentResult<'runtime_wake'>> {
    return this.call('runtime_wake', params);
  }

  runtimeStatus(
    params: RuntimeStatusParams = {},
  ): Promise<IntentResult<'runtime_status'>> {
    return this.call('runtime_status', params);
  }

  runtimeClearSession(
    params: RuntimeClearSessionParams,
  ): Promise<IntentResult<'runtime_clear_session'>> {
    return this.call('runtime_clear_session', params);
  }

  runtimeStopAll(): Promise<IntentResult<'runtime_stop_all'>> {
    return this.call('runtime_stop_all', {});
  }

  runtimeCloseActivityLog(): Promise<IntentResult<'runtime_close_activity_log'>> {
    return this.call('runtime_close_activity_log', {});
  }

  /**
   * Subscribe to **unsolicited events** the daemon emits — runtime_*
   * lifecycle (state, output, exit, ready_for_drain,
   * startup_delivery_consumed/_failed, output_dropped/_paused/_resumed)
   * plus the daemon-level `shutting_down` and `ready` envelopes from
   * PR-1. Re-subscription on reconnect is automatic via
   * `onReconnect` — the handler set is preserved across the
   * lifecycle of the HostClient itself, not the underlying
   * transport.
   *
   * Returns an unsubscribe function. Multiple subscribers are
   * supported; each receives every event in arrival order.
   */
  subscribe(handler: (event: EventFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Tear down. Cancels reconnect, rejects every pending request,
   *  closes the transport. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new HostClientError('closed', 'client closed'));
    this.transport?.close();
    this.transport = null;
  }

  private async openTransport(): Promise<void> {
    if (this.closed) return;
    const transport = this.transportFactory();
    this.transport = transport;
    transport.on('frame', frame => this.handleFrame(frame));
    transport.on('disconnect', reason => this.handleDisconnect(reason));
    transport.on('overflow', () => {
      this.logger.warn({}, 'daemon sent oversize frame; reconnecting');
      transport.close();
    });
    await transport.connect();
    this.backoffMs = this.initialBackoffMs;
    this.readyResolve?.();
    this.logger.info({}, 'host client connected');
  }

  private handleFrame(frame: DecodedFrame): void {
    if ('event' in frame) {
      // PR-1 events are informational; we log and move on. The
      // `shutting_down` event hints reconnect will fail until the
      // daemon comes back — we don't preempt the disconnect handler,
      // which fires when the socket actually closes a moment later.
      if (frame.event === 'shutting_down') {
        this.logger.info({ reason: frame.reason }, 'daemon notified shutdown');
      } else if (frame.event === 'ready') {
        this.logger.info(
          {
            daemon_pid: frame.daemon_pid,
            daemon_version: frame.daemon_version,
            started_at: frame.started_at,
          },
          'daemon ready handshake',
        );
      }
      // Dispatch to subscribers AFTER logging so a subscriber that
      // throws doesn't suppress the log line. Errors are isolated per
      // handler — one bad subscriber does not break the others.
      for (const h of this.eventHandlers) {
        try {
          h(frame);
        } catch (err) {
          this.logger.error(
            { err: (err as Error).message, event: frame.event },
            'event subscriber threw',
          );
        }
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      // Late response or duplicate; ignore.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if ('error' in frame) {
      pending.reject(new HostClientError(frame.error.code, frame.error.message));
      return;
    }
    // Mirror-validate the result against the schema we know for the
    // intent the caller dispatched. The daemon already validates on
    // its end (dispatcher.ts), but a client/daemon version skew —
    // e.g. an older client running against a newer daemon that added
    // fields — would still get caught here. We treat drift as a
    // typed `internal_error` so callers branching on `.code` see the
    // same surface as a daemon-side handler failure.
    const schema = intentSchemas[pending.intent as IntentName];
    if (schema) {
      const validated = schema.result.safeParse(frame.result);
      if (!validated.success) {
        const issues = validated.error.errors
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        this.logger.warn(
          { intent: pending.intent, issues },
          'host client received response that does not match intent schema',
        );
        pending.reject(
          new HostClientError(
            'internal_error',
            `drift: response for ${pending.intent} failed schema validation (${issues})`,
          ),
        );
        return;
      }
      pending.resolve(validated.data);
      return;
    }
    // Unknown intent (shouldn't happen — `call()` is typed against
    // the registry) — pass through without validation so we don't
    // strand the caller.
    pending.resolve(frame.result);
  }

  private handleDisconnect(reason: string): void {
    this.logger.warn({ reason }, 'host client transport disconnected');
    this.rejectAllPending(
      new HostClientError('disconnected', `transport disconnected: ${reason}`),
    );
    this.transport = null;
    if (this.closed) return;
    // The current ready promise is no longer "ready" — replace it so
    // future awaiters wait on the NEXT connect cycle, not the closed
    // one.
    this.resetReadyPromise();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    // Full-jitter exponential backoff: pick uniform in [0, current).
    // Standard recipe (AWS architecture blog) for avoiding thundering-
    // herd when many clients re-establish simultaneously.
    const delay = Math.max(
      this.initialBackoffMs,
      Math.floor(this.backoffMs * this.rng()),
    );
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
    this.reconnectTimer.unref?.();
    this.logger.info({ delay }, 'host client scheduling reconnect');
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) return;
    try {
      await this.openTransport();
      // Notify subscribers AFTER the new transport is live so handlers
      // can synchronously issue calls inside the callback.
      for (const h of this.reconnectHandlers) {
        try {
          h();
        } catch (err) {
          this.logger.error(
            { err: (err as Error).message },
            'onReconnect handler threw',
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'host client reconnect attempt failed; will retry',
      );
      this.scheduleReconnect();
    }
  }

  private rejectAllPending(err: HostClientError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Swallow unhandled rejections on the promise itself — callers
    // must await `connect()` explicitly to learn about failures.
    this.readyPromise.catch(() => {});
  }
}
