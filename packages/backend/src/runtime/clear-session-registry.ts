// D4.c C7 — clear-session waiter registry for the outbound fanout.
//
// A `clearSession` blocks on a bounded wait for the post-
// `runtime_clear_session` `runtime_exit` event to land in projection
// before it commits `cli_session_id=null` + the audit row. This registry
// is the self-contained state machine behind that wait: it owns its own
// waiter map + lifecycle (register → notify → bounded await → cleanup),
// keyed by `(conversationId, agentId)`, and depends on nothing in the
// fanout's per-host `states` map. Extracting it keeps the fanout core from
// carrying the waiter mechanics while avoiding a second runtime-state map.
//
// Lifecycle of a single waiter:
//
//   1. `begin` is called BEFORE `transport.sendCommand('runtime_clear_session')`
//      so a `runtime_exit` that lands during the WS round-trip cannot
//      be missed (the daemon emits the event from `onChildExit`, which
//      can race the command response).
//   2. `notifyExit` is called from `stateForHost.onRuntimeExit`'s callback
//      wrapper after the cache/SSE has already updated. Latches
//      `exited = true` and resolves any awaiter.
//   3. `clearSession` calls `awaitExit` after dispatch; either resolves
//      immediately (latched) or races the timeout.
//   4. `end` (the caller's `finally`, Cindy `nPqEVJjCLjuNDH-6` #2) removes
//      the entry regardless of success/timeout/dispatch-fail/DB-tx-fail.
import { ClearSessionExitTimeoutError } from './agent-runtime-host.js';

/**
 * One-shot waiter for the bounded wait on `runtime_exit` projection
 * landing. Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6` final.
 */
interface ClearSessionWaiter {
  exited: boolean;
  resolveExited: (() => void) | null;
}

export class ClearSessionWaiterRegistry {
  /**
   * Keyed by `${conversationId}|${agentId}`. Presence of an entry
   * means a `clearSession` is awaiting `runtime_exit` for that pair.
   */
  private readonly waiters = new Map<string, ClearSessionWaiter>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  private key(conversationId: string, agentId: string): string {
    return `${conversationId}|${agentId}`;
  }

  /**
   * True while a `clearSession` for this pair is in flight. The caller
   * uses this to fail fast (`ClearSessionInProgressError`) on concurrent
   * dispatch for the same pair.
   */
  inProgress(conversationId: string, agentId: string): boolean {
    return this.waiters.has(this.key(conversationId, agentId));
  }

  /** Register a one-shot waiter BEFORE dispatch. */
  begin(conversationId: string, agentId: string): void {
    this.waiters.set(this.key(conversationId, agentId), {
      exited: false,
      resolveExited: null,
    });
  }

  /**
   * Race the one-shot `runtime_exit` waiter against the configured
   * timeout. Throws {@link ClearSessionExitTimeoutError} on timeout;
   * resolves on `runtime_exit` projection landed (or immediately when
   * the waiter is already latched). Does NOT remove the entry — the
   * caller's `finally` (`end`) does that for both branches.
   */
  awaitExit(conversationId: string, agentId: string): Promise<void> {
    const waiter = this.waiters.get(this.key(conversationId, agentId));
    if (!waiter || waiter.exited) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        // Detach the resolver so a late `runtime_exit` doesn't try
        // to call `resolve` on an already-rejected promise.
        waiter.resolveExited = null;
        reject(new ClearSessionExitTimeoutError(conversationId, agentId));
      }, this.timeoutMs);
      waiter.resolveExited = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        waiter.resolveExited = null;
        resolve();
      };
    });
  }

  /**
   * Invoked from the `RuntimeEventHandler.onRuntimeExit` callback wrapper
   * after the cache and SSE have already updated. Latches `exited = true`
   * on any in-flight waiter for this pair and resolves the awaiter (if one
   * is parked). Idempotent: a second `runtime_exit` for the same pair is a
   * no-op (the resolver is null after first fire).
   */
  notifyExit(conversationId: string, agentId: string): void {
    const waiter = this.waiters.get(this.key(conversationId, agentId));
    if (!waiter) return;
    waiter.exited = true;
    const resolve = waiter.resolveExited;
    if (resolve) resolve();
  }

  /** Finally cleanup — remove the waiter regardless of outcome. */
  end(conversationId: string, agentId: string): void {
    this.waiters.delete(this.key(conversationId, agentId));
  }
}
