/**
 * In-memory intent dispatcher.
 *
 * Split from socket transport so:
 *
 *  - Unit tests can drive `dispatch(intent, params)` with raw JSON
 *    and assert the typed response without spinning up `node:net`.
 *  - PR-2 can slot in `runtime_*` handlers here without touching the
 *    socket loop.
 *
 * The dispatcher owns:
 *
 *  - The daemon's `started_at` (set on construction, surfaced via
 *    `ping` / `status`)
 *  - `intent_count` — number of intents handled this lifetime, used
 *    by reconnect tests to assert "second batch actually re-issued".
 *  - `shuttingDown` flag — once set, every further intent returns
 *    `{ code: 'shutting_down' }` instead of executing the handler.
 *
 * It does NOT own:
 *
 *  - The socket. The transport layer (server.ts) calls `dispatch` per
 *    decoded frame and writes the returned `ResponseFrame` back.
 *  - The pid file or signal handlers (lifecycle.ts).
 *  - Logging policy. The transport hands a logger in via the ctor; the
 *    dispatcher only logs errors that handlers throw.
 */
import {
  intentSchemas,
  type IntentName,
  type ResponseError,
  type ResponseFrame,
} from '../protocol.js';
import { DAEMON_VERSION } from './version.js';
import type { DaemonLogger } from './logger.js';

export interface DispatcherOptions {
  logger: DaemonLogger;
  /** Epoch ms; injected so tests can pin time. Default: Date.now(). */
  startedAt?: number;
  /** Epoch ms supplier; injected so tests can pin time. Default: Date.now. */
  now?: () => number;
}

export class IntentDispatcher {
  private readonly logger: DaemonLogger;
  private readonly startedAt: number;
  private readonly now: () => number;
  private intentCount = 0;
  private shuttingDown = false;

  constructor(opts: DispatcherOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
  }

  /** Signal that subsequent intents should be rejected with
   *  `shutting_down`. Idempotent. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getIntentCount(): number {
    return this.intentCount;
  }

  /**
   * Dispatch a single intent. Always returns a well-formed
   * `ResponseFrame` — never throws. Handlers that throw are caught
   * and projected as `internal_error`; the caller writes the frame
   * to the socket as-is.
   */
  async dispatch(
    requestId: string,
    intent: string,
    rawParams: unknown,
  ): Promise<ResponseFrame> {
    if (this.shuttingDown) {
      return this.errorFrame(requestId, {
        code: 'shutting_down',
        message: 'daemon is shutting down',
      });
    }
    const schema = intentSchemas[intent as IntentName];
    if (!schema) {
      return this.errorFrame(requestId, {
        code: 'unknown_intent',
        message: `unknown intent: ${intent}`,
      });
    }
    const parsed = schema.params.safeParse(rawParams);
    if (!parsed.success) {
      return this.errorFrame(requestId, {
        code: 'invalid_params',
        message: parsed.error.errors
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join('; '),
      });
    }
    this.intentCount += 1;
    try {
      const result = await this.runHandler(intent as IntentName, parsed.data);
      // Validate the handler's own result against the declared schema
      // BEFORE sending it on the wire. If a handler ever drifts from
      // the contract (e.g. a refactor accidentally drops a field, or
      // the schema gets tightened without updating the handler), we
      // want to catch it at the IPC boundary on the *daemon* side
      // rather than ship malformed bytes the client has to puzzle out.
      //
      // The mirror check on the client (HostClient.handleFrame) is a
      // second line of defense against version skew between a newer
      // daemon and older client (or vice versa).
      const resultValidated = schema.result.safeParse(result);
      if (!resultValidated.success) {
        this.logger.error(
          {
            intent,
            issues: resultValidated.error.errors
              .map(e => `${e.path.join('.')}: ${e.message}`)
              .join('; '),
          },
          'daemon emitted result that does not match schema',
        );
        return this.errorFrame(requestId, {
          code: 'internal_error',
          message: `daemon result drift for intent ${intent}`,
        });
      }
      return { id: requestId, result: resultValidated.data };
    } catch (err) {
      this.logger.error(
        {
          intent,
          err: err instanceof Error ? err.message : String(err),
        },
        'intent handler threw',
      );
      return this.errorFrame(requestId, {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private errorFrame(id: string, error: ResponseError): ResponseFrame {
    return { id, error };
  }

  /**
   * Per-intent business logic. Each case is intentionally tiny — PR-1
   * is here to prove the IPC plumbing, not to do real runtime work.
   * PR-2 will add `runtime_start` / `runtime_stop` / `runtime_wake`
   * and they will be wider; if this switch grows past ~5 cases, split
   * it into a registry map keyed by intent name.
   *
   * `protected` so a test-only subclass can override one intent's
   * output to verify the result-drift guard in `dispatch()` (without
   * monkey-patching production code). Production callers go through
   * `dispatch()` and never see this method directly.
   */
  protected async runHandler(
    intent: IntentName,
    params: unknown,
  ): Promise<unknown> {
    switch (intent) {
      case 'ping':
        return {
          pong: true as const,
          daemon_pid: process.pid,
          daemon_version: DAEMON_VERSION,
          started_at: this.startedAt,
        };
      case 'status':
        return {
          daemon_pid: process.pid,
          daemon_version: DAEMON_VERSION,
          started_at: this.startedAt,
          uptime_ms: this.now() - this.startedAt,
          intent_count: this.intentCount,
          runtimes: [],
        };
      case 'echo': {
        const p = params as { message: string };
        return { echoed: p.message };
      }
    }
  }
}
