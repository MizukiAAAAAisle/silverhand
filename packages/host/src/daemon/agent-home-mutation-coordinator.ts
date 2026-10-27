import type { AgentFilesPurgeResult } from '../protocol.js';
import { DaemonTypedError } from './typed-error.js';

export class AgentDeletingError extends DaemonTypedError {
  readonly code = 'agent_deleting';

  constructor(agentId: string) {
    super(`agent ${agentId} is being deleted`);
    this.name = 'AgentDeletingError';
  }
}

export class AgentQuiesceFailedError extends DaemonTypedError {
  readonly code = 'quiesce_failed';

  constructor(agentId: string, livingCount: number) {
    super(
      `agent ${agentId} still has ${livingCount} runtime child${livingCount === 1 ? '' : 'ren'} alive after quiesce timeout`,
    );
    this.name = 'AgentQuiesceFailedError';
  }
}

export class AgentCustodySettlementTimeoutError extends DaemonTypedError {
  readonly code = 'quiesce_failed';

  constructor(agentId: string, reservationCount: number) {
    super(
      `agent ${agentId} still has ${reservationCount} stale-receive custody reservation${reservationCount === 1 ? '' : 's'} awaiting response handoff settlement`,
    );
    this.name = 'AgentCustodySettlementTimeoutError';
  }
}

export interface AgentHomeFenceAuthority {
  isFenced(agentId: string): boolean;
}

type PurgeState =
  | { kind: 'purging'; promise: Promise<AgentFilesPurgeResult> }
  | { kind: 'fenced_retryable' }
  | { kind: 'fenced_complete'; result: AgentFilesPurgeResult };

/**
 * The daemon's single per-agent fence authority.
 *
 * Fence installation and bounded-work admission are synchronous operations.
 * Both daemon ingresses share one dispatcher/coordinator instance, and the
 * Supervisor consults this same object for start/deliver/internal respawn.
 */
export class AgentHomeMutationCoordinator implements AgentHomeFenceAuthority {
  private readonly bounded = new Map<string, Set<Promise<unknown>>>();
  private readonly purgeStates = new Map<string, PurgeState>();

  isFenced(agentId: string): boolean {
    return this.purgeStates.has(agentId);
  }

  runBounded<T>(agentId: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.isFenced(agentId)) {
      return Promise.reject(new AgentDeletingError(agentId));
    }

    let promise: Promise<T>;
    try {
      // Invoke immediately after admission. An async handler runs until its
      // first await before another ingress can install a fence.
      promise = Promise.resolve(fn());
    } catch (error) {
      promise = Promise.reject(error);
    }

    let entries = this.bounded.get(agentId);
    if (!entries) {
      entries = new Set();
      this.bounded.set(agentId, entries);
    }
    entries.add(promise);
    void promise
      .finally(() => {
        entries!.delete(promise);
        if (entries!.size === 0) this.bounded.delete(agentId);
      })
      .catch(() => undefined);
    return promise;
  }

  runPurge(
    agentId: string,
    fn: () => AgentFilesPurgeResult | Promise<AgentFilesPurgeResult>,
  ): Promise<AgentFilesPurgeResult> {
    const current = this.purgeStates.get(agentId);
    if (current?.kind === 'purging') return current.promise;
    if (current?.kind === 'fenced_complete') {
      return Promise.resolve(current.result);
    }

    // Load-bearing: publish the shared fence before constructing or awaiting
    // any promise. Dispatcher admission and Supervisor respawn see it now.
    const promise = this.finishPurge(agentId, fn);
    this.purgeStates.set(agentId, { kind: 'purging', promise });
    return promise;
  }

  private async finishPurge(
    agentId: string,
    fn: () => AgentFilesPurgeResult | Promise<AgentFilesPurgeResult>,
  ): Promise<AgentFilesPurgeResult> {
    try {
      const admitted = [...(this.bounded.get(agentId) ?? [])];
      await Promise.allSettled(admitted);
      const result = await fn();
      this.purgeStates.set(agentId, { kind: 'fenced_complete', result });
      return result;
    } catch (error) {
      // Terminal fence: quiesce failure, partial purge, transport timeout and
      // later retries never reopen mutator admission.
      this.purgeStates.set(agentId, { kind: 'fenced_retryable' });
      throw error;
    }
  }
}
