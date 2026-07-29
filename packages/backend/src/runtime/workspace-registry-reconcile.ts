import type { Database as Db } from 'better-sqlite3';
import { WORKSPACE_UNBIND_MAX_BATCH } from '@silverhand/host';
import type { BackendLogger } from '../context.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  dispatchWorkspaceRegistryIds,
  dispatchWorkspaceUnbind,
  resolveRegistryReconcileOutbound,
} from './workspace-data-plane.js';

/**
 * #task:1719 — ready-generation workspace-registry reconcile.
 *
 * Deleting a workspace row while a daemon is OFFLINE leaves that daemon's
 * `workspace-registry.json` entry behind as a ghost that keeps participating
 * in path-overlap validation (same/nested-path recreation → spurious
 * `path_conflict`). There is deliberately NO tombstone/outbox: instead, every
 * time a daemon establishes a valid attachment (auth + protocol + ready —
 * never a raw socket open), the backend runs ONE single-flight reconcile for
 * that `(hostId, connectionId)` generation:
 *
 *   1. PULL — `workspace_registry_ids`: the ids the daemon's registry binds
 *      (ids only, never paths).
 *   2. LEGAL — from the DB: home = regular workspaces with
 *      `workspace_host_id === hostId`; guest = workspaces with ≥1 member
 *      agent (`workspace_members` ⋈ `agents`) living on `hostId`.
 *   3. GHOSTS = reported − legal → `workspace_unbind` in
 *      `WORKSPACE_UNBIND_MAX_BATCH` chunks.
 *
 * One pass covers deletions that happened while the daemon was offline,
 * pre-fix legacy ghosts, and historical guest orphans. Path-overlap
 * validation itself is never weakened — the daemon cannot locally prove an
 * id dead; only this DB-authoritative diff can.
 *
 * Compatibility (P0-2): both intents are capability-gated on
 * `workspace.registry_reconcile.v1` via `resolveRegistryReconcileOutbound`.
 * A generation that did not advertise the token is recorded as PASS-THROUGH:
 * zero new traffic to that daemon (an old binary strict-rejects unknown
 * commands and drops the connection) and the provision barrier resolves
 * immediately — the host converges on its first post-upgrade ready.
 *
 * Generation binding: every await re-checks that the live connectionId still
 * equals the pinned one; a mismatch abandons the run silently (the NEW
 * generation's own ready starts its own run) — a stale run's result never
 * marks the new generation reconciled and never dispatches into it.
 *
 * Barrier: `workspace_provision` dispatches await `barrier(hostId)` so a
 * provision can never race the ghost sweep of its own generation (recreating
 * at a ghosted path would otherwise still hit `path_conflict`). Heartbeat /
 * status / runtime paths do NOT touch the barrier.
 */

/**
 * Typed barrier failure: the current generation's reconcile failed (or the
 * reconciler was shut down mid-wait), so a `workspace_provision` on this
 * host cannot yet trust path-overlap validation. Callers map it to their
 * existing retryable-unavailability arm (503-class, retriable) — never a
 * "computer offline" verdict and never a relaxation of overlap validation.
 */
export class WorkspaceRegistryReconcilePendingError extends Error {
  constructor(readonly hostId: string) {
    super(
      `workspace registry reconcile is pending/failed for host ${hostId}; retry`,
    );
    this.name = 'WorkspaceRegistryReconcilePendingError';
  }
}

type GenerationState =
  | {
      kind: 'running';
      connectionId: string;
      /** Settles when the run does; rejects with the typed error on failure. */
      promise: Promise<void>;
      /** close() uses these to reject waiters promptly on shutdown. */
      resolve: () => void;
      reject: (err: WorkspaceRegistryReconcilePendingError) => void;
      settled: boolean;
    }
  /** Ghost sweep completed for this generation. */
  | { kind: 'reconciled'; connectionId: string }
  /** Generation lacks the capability — nothing to await, ever. */
  | { kind: 'pass_through'; connectionId: string }
  /** Run failed; the next barrier() re-kicks single-flight on demand. */
  | { kind: 'failed'; connectionId: string };

export class WorkspaceRegistryReconciler {
  private readonly workspaces: WorkspaceRepo;
  private readonly adapter: () => OutboundFrameAdapter | null;
  private readonly logger: BackendLogger;
  /** hostId → state for the generation we most recently observed. */
  private readonly states = new Map<string, GenerationState>();
  private closed = false;

  constructor(opts: {
    db: Db;
    adapter: () => OutboundFrameAdapter | null;
    logger: BackendLogger;
  }) {
    this.workspaces = new WorkspaceRepo(opts.db);
    this.adapter = opts.adapter;
    this.logger = opts.logger;
  }

  /**
   * Fire-and-forget entry, called from the composition root's fanout
   * `onHostReady` (a valid attachment for a NEW generation). Never throws.
   */
  onHostReady(hostId: string): void {
    if (this.closed) return;
    this.ensureRunForCurrentGeneration(hostId);
  }

  /**
   * Provision gate. Resolves when the CURRENT generation is reconciled or
   * pass-through; awaits an in-flight run (never starts a second for the
   * same generation); re-kicks single-flight after a failed run
   * (retry-on-demand). Throws {@link WorkspaceRegistryReconcilePendingError}
   * when the run fails or the reconciler is closed. A host with NO live
   * connection resolves immediately — the provision dispatch right after
   * fails with its own transport error, which is the clearer signal.
   */
  async barrier(hostId: string): Promise<void> {
    if (this.closed) throw new WorkspaceRegistryReconcilePendingError(hostId);
    const current = this.adapter()?.connectionIdForHost(hostId) ?? null;
    if (current === null) return;
    let state: GenerationState | null = this.states.get(hostId) ?? null;
    if (!state || state.connectionId !== current || state.kind === 'failed') {
      // Missed ready (e.g. backend restarted mid-generation), stale entry
      // from a previous generation, or a failed run: (re-)kick exactly one
      // run for the CURRENT generation before waiting.
      state = this.ensureRunForCurrentGeneration(hostId);
      if (!state) return; // connection vanished mid-check → provision's own transport error reports it
    }
    switch (state.kind) {
      case 'reconciled':
      case 'pass_through':
        return;
      case 'failed':
        // ensureRun above only leaves 'failed' when it could not start a
        // replacement (single-flight raced close()); surface the typed error.
        throw new WorkspaceRegistryReconcilePendingError(hostId);
      case 'running':
        return state.promise;
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  /**
   * Drop all state and REJECT every in-flight waiter with the typed error
   * (documented choice: a shutdown mid-provision surfaces as the caller's
   * retryable 503-class outcome instead of hanging the request). Later
   * `onHostReady`/`barrier` calls are inert/throw respectively.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [hostId, state] of this.states) {
      if (state.kind === 'running' && !state.settled) {
        state.settled = true;
        state.reject(new WorkspaceRegistryReconcilePendingError(hostId));
      }
    }
    this.states.clear();
  }

  /**
   * Single-flight per (hostId, connectionId): reuse the existing state when
   * it already belongs to the CURRENT generation and is not 'failed';
   * otherwise resolve capability + start one run. Returns the state now in
   * the map, or null when no usable connection/attachment exists.
   */
  private ensureRunForCurrentGeneration(hostId: string): GenerationState | null {
    if (this.closed) return null;
    const adapter = this.adapter();
    if (!adapter) return null;
    const gate = resolveRegistryReconcileOutbound(adapter, hostId);
    if (gate.kind === 'failed') return null; // no/unstable connection → no-op
    const existing = this.states.get(hostId);
    if (
      existing &&
      existing.connectionId === gate.connectionId &&
      existing.kind !== 'failed'
    ) {
      return existing;
    }
    if (gate.kind === 'no_capability') {
      // PASS-THROUGH for this whole generation: the barrier resolves
      // immediately and no #1719 command ever targets this daemon. It
      // converges on the first ready after upgrade.
      const state: GenerationState = {
        kind: 'pass_through',
        connectionId: gate.connectionId,
      };
      this.states.set(hostId, state);
      this.logger.info(
        {
          event: 'workspace_registry_reconcile_pass_through',
          host_id: hostId,
          connection_id: gate.connectionId,
        },
        'workspace registry reconcile: daemon lacks workspace.registry_reconcile.v1; generation passes through (converges after upgrade)',
      );
      return state;
    }
    let resolveFn!: () => void;
    let rejectFn!: (err: WorkspaceRegistryReconcilePendingError) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // onHostReady is fire-and-forget: without a pre-attached catch, a run
    // that fails before any barrier awaits it would be an unhandled
    // rejection. Barrier callers still observe the rejection through
    // `state.promise`.
    void promise.catch(() => undefined);
    const state: GenerationState = {
      kind: 'running',
      connectionId: gate.connectionId,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      settled: false,
    };
    this.states.set(hostId, state);
    void this.runReconcile(hostId, state, gate.adapter);
    return state;
  }

  /** True while `state` is still the map's entry for `hostId` — i.e. no newer
   *  generation replaced it and close() has not cleared it. */
  private ownsSlot(hostId: string, state: GenerationState): boolean {
    return this.states.get(hostId) === state;
  }

  /** Generation guard: the run may keep going only while the LIVE connection
   *  still is the pinned one and the reconciler is open. */
  private generationLive(
    hostId: string,
    state: Extract<GenerationState, { kind: 'running' }>,
  ): boolean {
    if (this.closed) return false;
    return (
      (this.adapter()?.connectionIdForHost(hostId) ?? null) ===
      state.connectionId
    );
  }

  private async runReconcile(
    hostId: string,
    state: Extract<GenerationState, { kind: 'running' }>,
    adapter: OutboundFrameAdapter,
  ): Promise<void> {
    const connectionId = state.connectionId;
    const abandon = (): void => {
      // Stale generation (or shutdown): abandon SILENTLY. Resolve waiters —
      // their subsequent provision dispatch is generation-pinned and fails
      // with its own transport error if the old connection is truly gone —
      // and vacate the slot ONLY if it is still ours, so the new
      // generation's own run/state is never touched.
      if (!state.settled) {
        state.settled = true;
        state.resolve();
      }
      if (this.ownsSlot(hostId, state)) this.states.delete(hostId);
    };
    const fail = (code: string): void => {
      this.logger.warn(
        {
          event: 'workspace_registry_reconcile_failed',
          host_id: hostId,
          connection_id: connectionId,
          code,
        },
        'workspace registry reconcile failed; provisions on this host stay gated until a retry succeeds',
      );
      if (this.ownsSlot(hostId, state)) {
        this.states.set(hostId, { kind: 'failed', connectionId });
      }
      if (!state.settled) {
        state.settled = true;
        state.reject(new WorkspaceRegistryReconcilePendingError(hostId));
      }
    };

    const pulled = await dispatchWorkspaceRegistryIds(
      adapter,
      hostId,
      connectionId,
      {},
    );
    if (!this.generationLive(hostId, state)) return abandon();
    if (pulled.kind === 'failed') return fail(pulled.code);

    // LEGAL set from the DB, read AFTER the pull so a workspace deleted
    // in-between is correctly classified as a ghost (the daemon-side unbind
    // is idempotent either way).
    const legal = new Set<string>([
      ...this.workspaces.listRegularByHost(hostId).map(w => w.id),
      ...this.workspaces.listIdsWithMemberAgentOnHost(hostId),
    ]);
    const reported = pulled.result.workspace_ids;
    const ghosts = [...new Set(reported)].filter(id => !legal.has(id));

    let ghostsRemoved = 0;
    for (
      let offset = 0;
      offset < ghosts.length;
      offset += WORKSPACE_UNBIND_MAX_BATCH
    ) {
      const chunk = ghosts.slice(offset, offset + WORKSPACE_UNBIND_MAX_BATCH);
      const unbound = await dispatchWorkspaceUnbind(
        adapter,
        hostId,
        connectionId,
        { workspace_ids: chunk },
      );
      if (!this.generationLive(hostId, state)) return abandon();
      if (unbound.kind === 'failed') return fail(unbound.code);
      ghostsRemoved += unbound.result.removed.length;
    }

    this.logger.info(
      {
        event: 'workspace_registry_reconcile',
        host_id: hostId,
        connection_id: connectionId,
        reported: reported.length,
        legal: legal.size,
        ghosts_removed: ghostsRemoved,
      },
      'workspace registry reconcile: daemon registry converged with DB',
    );
    if (this.ownsSlot(hostId, state)) {
      this.states.set(hostId, { kind: 'reconciled', connectionId });
    }
    if (!state.settled) {
      state.settled = true;
      state.resolve();
    }
  }
}
