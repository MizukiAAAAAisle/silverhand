// D4.c C7 — clear-session waiter registry for the outbound fanout.
//
// A `clearSession` blocks on a bounded wait for the post-
// `runtime_clear_session` `runtime_exit` event to land in projection
// before it commits `cli_session_id=null` (and, for ConversationSlot only,
// the existing conversation audit row). This registry
// is the self-contained state machine behind that wait: it owns its own
// waiter map + lifecycle (register → notify → bounded await → cleanup),
// indexed by semantic RuntimeScope for the concurrent-operation lock while
// every notification is matched against the exact generation + daemon token.
// It depends on nothing in the
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
import type {
  RuntimeCustody,
  RuntimePrincipalScope,
} from '../auth/runtime-principal.js';

/** Identity of one clear attempt. Scope names the durable slot; generation and
 * daemon bind the operation to the runtime that was current before dispatch. */
export interface ClearSessionOperation {
  scope: RuntimePrincipalScope;
  generation: number;
  daemonInstanceId: string | null;
}

/**
 * One-shot waiter for the bounded wait on `runtime_exit` projection
 * landing. Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6` final.
 */
interface ClearSessionWaiter {
  operation: ClearSessionOperation;
  exited: boolean;
  resolveExited: (() => void) | null;
}

export class ClearSessionWaiterRegistry {
  /**
   * Keyed by AgentSlot or ConversationSlot identity. Presence of an entry
   * means a `clearSession` is awaiting `runtime_exit` for that slot.
   */
  private readonly waiters = new Map<string, ClearSessionWaiter>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  private key(scope: RuntimePrincipalScope): string {
    return scope.kind === 'agent'
      ? `agent|${scope.agentId}`
      : `conversation|${scope.conversationId}|${scope.agentId}`;
  }

  /**
   * True while a `clearSession` for this slot is in flight. The caller
   * uses this to fail fast (`ClearSessionInProgressError`) on concurrent
   * dispatch for the same pair.
   */
  inProgress(scope: RuntimePrincipalScope): boolean {
    return this.waiters.has(this.key(scope));
  }

  /** Register a one-shot waiter BEFORE dispatch. */
  begin(operation: ClearSessionOperation): void {
    this.waiters.set(this.key(operation.scope), {
      operation,
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
  awaitExit(
    operation: ClearSessionOperation,
  ): Promise<void> {
    const waiter = this.waiters.get(this.key(operation.scope));
    if (!waiter || !this.sameOperation(waiter.operation, operation)) {
      return Promise.resolve();
    }
    if (waiter.exited) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        // Detach the resolver so a late `runtime_exit` doesn't try
        // to call `resolve` on an already-rejected promise.
        waiter.resolveExited = null;
        reject(new ClearSessionExitTimeoutError(operation.scope));
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
   * Invoked at fanout ingress after connection/perimeter/scope validation but
   * before RuntimeEventHandler's current-custody gate. Only the exact runtime
   * custody captured before dispatch may latch the waiter. This lets old N's
   * real exit finish clear N after DB authority advanced to N+1, while all
   * projection side effects remain gated and the subsequent generation CAS
   * rejects N's settlement. A successor or different daemon is a no-op.
   */
  notifyExit(scope: RuntimePrincipalScope, custody: RuntimeCustody): void {
    const waiter = this.waiters.get(this.key(scope));
    if (
      !waiter
      || waiter.operation.generation !== custody.generation
      || waiter.operation.daemonInstanceId !== custody.daemonInstanceId
    ) return;
    waiter.exited = true;
    const resolve = waiter.resolveExited;
    if (resolve) resolve();
  }

  /** Finally cleanup — remove the waiter regardless of outcome. */
  end(operation: ClearSessionOperation): void {
    const key = this.key(operation.scope);
    const waiter = this.waiters.get(key);
    if (waiter && this.sameOperation(waiter.operation, operation)) {
      this.waiters.delete(key);
    }
  }

  private sameOperation(
    left: ClearSessionOperation,
    right: ClearSessionOperation,
  ): boolean {
    return left.generation === right.generation
      && left.daemonInstanceId === right.daemonInstanceId;
  }
}
