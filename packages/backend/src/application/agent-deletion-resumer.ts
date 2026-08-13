import type { OutboundFrameAdapter } from '../runtime/outbound-frame-adapter.js';
import {
  dispatchAgentFilesPurge,
  resolveOutboundForHost,
} from '../runtime/workspace-data-plane.js';
import type {
  AgentDeletionAttempt,
  AgentDeletionLifecyclePort,
  CompleteAgentDeletionResult,
} from './agent-teardown-ports.js';

export type AgentDeletionRunResult =
  | { kind: 'completed' }
  | { kind: 'alreadyRunning' }
  | { kind: 'pending'; code: string; message: string };

export interface AgentDeletionRunner {
  tryNow(attempt: AgentDeletionAttempt): Promise<AgentDeletionRunResult>;
}

export interface AgentDeletionResumerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AgentDeletionResumerOptions {
  deletion: AgentDeletionLifecyclePort;
  adapter: () => OutboundFrameAdapter | null;
  onCommitted: (
    result: Extract<CompleteAgentDeletionResult, { kind: 'committed' }>,
    purge: { purgedCount: number; quiescedCount: number },
  ) => void | Promise<void>;
  logger: AgentDeletionResumerLogger;
  retryDelaysMs?: readonly number[];
}

interface RetryGeneration {
  connectionId: string;
  nextDelayIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Durable deletion worker: DB discovery is synchronous and IO starts only
 * after an admitted host-ready generation or an explicit request retry. */
export class AgentDeletionResumer implements AgentDeletionRunner {
  private readonly pending = new Map<string, AgentDeletionAttempt>();
  private readonly inFlight = new Map<string, Promise<AgentDeletionRunResult>>();
  private readonly generations = new Map<string, RetryGeneration>();
  private readonly retryDelaysMs: readonly number[];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly opts: AgentDeletionResumerOptions) {
    this.retryDelaysMs = opts.retryDelaysMs ?? [1_000, 5_000, 30_000];
    // Discovery only: constructor/boot performs no daemon IO.
    for (const attempt of opts.deletion.listPending()) {
      this.pending.set(attempt.agentId, attempt);
    }
  }

  startConnectedHosts(): void {
    const adapter = this.opts.adapter();
    if (!adapter) return;
    for (const hostId of adapter.connectedHostIds()) {
      const connectionId = adapter.connectionIdForHost(hostId);
      if (connectionId) this.onHostReady(hostId, connectionId);
    }
  }

  onHostReady(hostId: string, connectionId: string): void {
    if (this.closed) return;
    const current = this.generations.get(hostId);
    if (current?.connectionId === connectionId) return;
    if (current?.timer) clearTimeout(current.timer);
    this.generations.set(hostId, {
      connectionId,
      nextDelayIndex: 0,
      timer: null,
    });
    // Ready owns the first immediate attempt; retry budget starts only after a
    // pending result, at 1s. Running this directly also avoids a zero-delay
    // timer becoming a second scheduler beside request/explicit retry.
    void this.runHostGeneration(hostId, connectionId);
  }

  async tryNow(attempt: AgentDeletionAttempt): Promise<AgentDeletionRunResult> {
    if (this.closed) {
      return {
        kind: 'pending',
        code: 'agent_deletion_worker_closed',
        message: 'agent deletion worker is shutting down',
      };
    }
    this.pending.set(attempt.agentId, attempt);
    const active = this.inFlight.get(attempt.agentId);
    if (active) return { kind: 'alreadyRunning' };
    let connectionId: string | null;
    try {
      connectionId =
        this.opts.adapter()?.connectionIdForHost(attempt.hostId) ?? null;
    } catch (err) {
      this.opts.logger.warn(
        { agentId: attempt.agentId, hostId: attempt.hostId, err },
        'agent deletion connection lookup failed unexpectedly',
      );
      this.scheduleNextRetry(attempt.hostId);
      return {
        kind: 'pending',
        code: 'agent_deletion_worker_failure',
        message: 'agent deletion could not be completed; retry later',
      };
    }
    if (connectionId) {
      const generation = this.generations.get(attempt.hostId);
      if (generation?.timer) clearTimeout(generation.timer);
      this.generations.set(attempt.hostId, {
        connectionId,
        nextDelayIndex: 0,
        timer: null,
      });
    }
    const result = await this.runSingleFlight(attempt);
    if (result.kind === 'pending') this.scheduleNextRetry(attempt.hostId);
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const generation of this.generations.values()) {
      if (generation.timer) clearTimeout(generation.timer);
    }
    this.generations.clear();
    // Drain work that already crossed admission. Shutdown keeps the transport
    // and DB open until this resolves, so a purge already on the wire may
    // finish safely; after this promise resolves no in-flight callback can
    // reach either dependency.
    this.closePromise = Promise.allSettled([...this.inFlight.values()]).then(
      () => undefined,
    );
    return this.closePromise;
  }

  private scheduleHost(hostId: string, delayMs: number): void {
    const generation = this.generations.get(hostId);
    if (!generation || this.closed) return;
    if (generation.timer) return;
    generation.nextDelayIndex += 1;
    generation.timer = setTimeout(() => {
      generation.timer = null;
      void this.runHostGeneration(hostId, generation.connectionId);
    }, delayMs);
    generation.timer.unref?.();
  }

  private scheduleNextRetry(hostId: string): void {
    const generation = this.generations.get(hostId);
    if (!generation || generation.timer || this.closed) return;
    const delay = this.retryDelaysMs[generation.nextDelayIndex];
    if (delay === undefined) {
      this.opts.logger.warn(
        {
          hostId,
          connectionId: generation.connectionId,
          attempts: generation.nextDelayIndex,
        },
        'agent deletion retry cap reached for host connection generation',
      );
      return;
    }
    this.scheduleHost(hostId, delay);
  }

  private async runHostGeneration(
    hostId: string,
    connectionId: string,
  ): Promise<void> {
    try {
      const generation = this.generations.get(hostId);
      const adapter = this.opts.adapter();
      if (
        this.closed ||
        !generation ||
        generation.connectionId !== connectionId ||
        adapter?.connectionIdForHost(hostId) !== connectionId
      ) {
        return;
      }

      const attempts = [...this.pending.values()].filter(a => a.hostId === hostId);
      const results = await Promise.all(
        attempts.map(attempt => this.runSingleFlightOrJoin(attempt)),
      );
      if (results.some(result => result.kind === 'pending')) {
        this.scheduleNextRetry(hostId);
      }
    } catch (err) {
      this.opts.logger.warn(
        { hostId, connectionId, err },
        'agent deletion host-generation scheduler failed unexpectedly',
      );
      this.scheduleNextRetry(hostId);
    }
  }

  private runSingleFlightOrJoin(
    attempt: AgentDeletionAttempt,
  ): Promise<AgentDeletionRunResult> {
    return this.inFlight.get(attempt.agentId) ?? this.runSingleFlight(attempt);
  }

  private runSingleFlight(
    attempt: AgentDeletionAttempt,
  ): Promise<AgentDeletionRunResult> {
    const promise = this.execute(attempt)
      .catch((err: unknown): AgentDeletionRunResult => {
        this.opts.logger.warn(
          {
            agentId: attempt.agentId,
            hostId: attempt.hostId,
            deletionStartedAt: attempt.deletionStartedAt,
            err,
          },
          'agent deletion attempt failed unexpectedly; retaining durable marker',
        );
        return {
          kind: 'pending',
          code: 'agent_deletion_attempt_failed',
          message: 'agent deletion could not be completed; retry later',
        };
      })
      .finally(() => {
        if (this.inFlight.get(attempt.agentId) === promise) {
          this.inFlight.delete(attempt.agentId);
        }
      });
    this.inFlight.set(attempt.agentId, promise);
    return promise;
  }

  private async execute(
    attempt: AgentDeletionAttempt,
  ): Promise<AgentDeletionRunResult> {
    const outbound = resolveOutboundForHost(this.opts.adapter(), attempt.hostId);
    if (outbound.kind === 'failed') {
      return { kind: 'pending', code: outbound.code, message: outbound.message };
    }
    const purge = await dispatchAgentFilesPurge(
      outbound.adapter,
      attempt.hostId,
      outbound.connectionId,
      { agent_id: attempt.agentId },
    );
    if (purge.kind === 'failed') {
      return { kind: 'pending', code: purge.code, message: purge.message };
    }

    const completed = this.opts.deletion.complete(attempt);
    if (completed.kind === 'attemptLost') {
      return {
        kind: 'pending',
        code: 'agent_deletion_attempt_lost',
        message: 'deletion attempt no longer matches agent placement or marker',
      };
    }
    this.pending.delete(attempt.agentId);
    if (completed.kind === 'committed') {
      // The row is already committed away. Publishing and blob cleanup remain
      // best-effort post-commit effects; their failure must not resurrect a
      // retry loop whose durable routing anchor no longer exists.
      try {
        await this.opts.onCommitted(completed, {
          purgedCount: purge.result.purged_count,
          quiescedCount: purge.result.quiesced_count,
        });
      } catch (err) {
        this.opts.logger.warn(
          { agentId: attempt.agentId, hostId: attempt.hostId, err },
          'agent deletion post-commit effects failed',
        );
      }
    }
    this.opts.logger.info(
      {
        agentId: attempt.agentId,
        hostId: attempt.hostId,
        deletionStartedAt: attempt.deletionStartedAt,
      },
      'agent deletion completed',
    );
    return { kind: 'completed' };
  }
}
