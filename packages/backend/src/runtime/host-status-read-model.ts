/**
 * #task:1588 — generation-bound read model for `GET
 * /api/hosts/:id/status`.
 *
 * Contract (task gate #4, slice 2): the HTTP read surface performs
 * ZERO daemon RPC — {@link HostStatusReadModel.read} is synchronous and
 * only touches memory. ALL dispatch is owned by the background seeding
 * chain ({@link HostStatusReadModel.seedEagerly}), triggered by the
 * fanout on every daemon `ready` and retried on a bounded backoff.
 * A request that arrives before the seed lands gets an explicit
 * non-available outcome; the composition root re-publishes
 * `host_connection_changed` when the seed lands, so renderers refetch
 * and converge without polling.
 *
 * The three facts the route needs decompose by source:
 *
 *   1. **availability** — whether the host has a live ATTACHMENT (a daemon
 *      admitted by a compatible `ready`, #task:1966) is a backend-local
 *      fact (`connectionIdForHost`), never an RPC. A socket that is merely
 *      authenticated is not availability.
 *   2. **static snapshot** (os / arch / daemon pid / version /
 *      started_at) — immutable for the lifetime of one daemon process,
 *      hence of one connection generation. Seeded by ONE `host_status`
 *      RPC per generation (single-flighted), then served from memory.
 *      `uptime_ms` derives from the seed base + monotonic elapsed, so
 *      backend/daemon clock skew and NTP jumps never show through.
 *   3. **active agent set** — maintained by the outbound event fanout's
 *      per-host runtime cache (runtime_state / runtime_exit events +
 *      atomic `runtime_status` hydrate). The read model consumes it
 *      through the {@link HostRuntimeActivitySource} port.
 *
 * Active-set precedence is deterministic, both arms generation-bound:
 * BEFORE the fanout's hydrate for the current daemon lands, the seed
 * RPC's `active_agent_ids` (authoritative at seed time) is served;
 * AFTER hydrate, the event-maintained cache wins. There is never a
 * merge. The seed→cache authority switch is made visible to renderers
 * by the fanout's per-hydrate forced `host_agent_liveness_changed`
 * publish (see `outbound-event-fanout.ts`), so a seed set that the
 * hydrate contradicts cannot be cached stale client-side.
 *
 * Generation binding: the seed is keyed to the `connectionId` resolved
 * at admission and dispatched via
 * {@link HostStatusSingleFlight.dispatchKeyed} with that exact id; a
 * publish-time recheck drops any outcome (success or failure) whose
 * generation is no longer live, so a late old-generation settle can
 * neither overwrite a successor seed nor be served. A disconnected
 * host drops its seed eagerly; failure outcomes are never cached.
 */
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  HostStatusSingleFlight,
  type HostStatusOutcome,
} from './host-status-dispatch.js';

/**
 * Per-host live-runtime view the event fanout exposes to this read
 * model. `activeAgentIds` is derived from the fanout's runtime cache
 * filtered by the same active-phase whitelist the daemon applies to
 * `host_status.active_agent_ids` (spawning / startup_pending / ready /
 * draining — fail closed on unknown phases).
 */
export interface HostRuntimeActivityView {
  /** Connection the fanout last saw events on for this host. */
  connectionId: string | null;
  /**
   * True once the `runtime_status` hydrate for the CURRENT daemon
   * generation has completed (atomic whole-set replace). Until then
   * the cache may be empty or partial and must not drive liveness.
   */
  hydratedForCurrentDaemon: boolean;
  /** Agents with at least one live runtime on this host. */
  activeAgentIds: readonly string[];
}

export type HostRuntimeActivitySource = (
  hostId: string,
) => HostRuntimeActivityView | null;

export type HostStatusReadOutcome =
  | {
      kind: 'ok';
      snapshot: {
        os: string;
        os_arch?: string;
        daemon_pid: number;
        daemon_version: string;
        started_at: number;
        uptime_ms: number;
      };
      activeAgentIds: ReadonlySet<string>;
    }
  | { kind: 'disconnected' }
  | Extract<HostStatusOutcome, { kind: 'unreachable' }>;

interface HostStatusSeed {
  connectionId: string;
  /** Monotonic timestamp (not wall clock): used only for elapsed
   *  diffs, so an NTP jump on the backend can never warp uptime. */
  seededAtMonotonic: number;
  os: string;
  osArch: string | undefined;
  daemonPid: number;
  daemonVersion: string;
  startedAt: number;
  uptimeMsAtSeed: number;
  /** Pre-hydrate liveness fallback, authoritative at seed time. */
  activeAgentIds: readonly string[];
}

export class HostStatusReadModel {
  private readonly seeds = new Map<string, HostStatusSeed>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly singleFlight: HostStatusSingleFlight;
  private readonly monotonicNow: () => number;
  private closed = false;

  constructor(
    private readonly opts: {
      adapter: () => OutboundFrameAdapter | null;
      /** Absent (e.g. a route test harness without a fanout) means the
       *  seed fallback serves liveness for the whole generation. */
      runtimeView?: HostRuntimeActivitySource;
      /** Fired when a seed is published for a generation — the
       *  composition root re-publishes `host_connection_changed` so
       *  renderers that read the pre-seed pending arm refetch. */
      onSeeded?: (hostId: string) => void;
      singleFlight?: HostStatusSingleFlight;
      /** Monotonic clock override (elapsed-diff use only). */
      monotonicNow?: () => number;
      logger?: {
        warn: (meta: Record<string, unknown>, msg: string) => void;
      };
    },
  ) {
    this.singleFlight = opts.singleFlight ?? new HostStatusSingleFlight();
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());
  }

  /**
   * Memory-only read — synchronous BY DESIGN (task gate #4: the HTTP
   * request path never calls `sendCommand`). Before the generation's
   * seed lands (or after its bounded retries exhausted) this returns an
   * explicit transient non-available outcome; the `onSeeded` →
   * `host_connection_changed` republish converges renderers once the
   * seed arrives.
   */
  read(hostId: string): HostStatusReadOutcome {
    const adapter = this.opts.adapter();
    const connectionId = adapter?.connectionIdForHost(hostId) ?? null;
    if (!adapter || !connectionId) {
      this.seeds.delete(hostId);
      return { kind: 'disconnected' };
    }

    const seed = this.seeds.get(hostId);
    if (!seed || seed.connectionId !== connectionId) {
      return {
        kind: 'unreachable',
        reason: 'daemon_unreachable',
        message:
          'host status snapshot is not seeded for the current connection yet',
      };
    }

    const view = this.opts.runtimeView?.(hostId) ?? null;
    const cacheIsAuthoritative =
      view !== null &&
      view.connectionId === connectionId &&
      view.hydratedForCurrentDaemon;
    const activeAgentIds = new Set(
      cacheIsAuthoritative ? view.activeAgentIds : seed.activeAgentIds,
    );

    return {
      kind: 'ok',
      snapshot: {
        os: seed.os,
        ...(seed.osArch !== undefined ? { os_arch: seed.osArch } : {}),
        daemon_pid: seed.daemonPid,
        daemon_version: seed.daemonVersion,
        started_at: seed.startedAt,
        uptime_ms: Math.round(
          Math.max(
            seed.uptimeMsAtSeed,
            seed.uptimeMsAtSeed +
              (this.monotonicNow() - seed.seededAtMonotonic),
          ),
        ),
      },
      activeAgentIds,
    };
  }

  /**
   * Attach-triggered seeding chain — the SOLE owner of `host_status`
   * dispatch. Called by the fanout on every daemon `ready`; a fresh
   * call supersedes any pending retry from the previous generation.
   * Failures retry on the bounded backoff; every await is followed by
   * a closed/generation recheck so a late settle can neither publish a
   * stale seed nor keep probing a replaced connection. Returns the
   * chain's completion promise for tests; production callers ignore it.
   */
  seedEagerly(hostId: string): Promise<void> {
    this.clearRetryTimer(hostId);
    return this.seedAttempt(hostId, 0);
  }

  /** Cancel all background work. Read stays functional (memory-only). */
  close(): void {
    this.closed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async seedAttempt(hostId: string, attempt: number): Promise<void> {
    if (this.closed) return;
    const adapter = this.opts.adapter();
    const connectionId = adapter?.connectionIdForHost(hostId) ?? null;
    if (!adapter || !connectionId) return;
    const existing = this.seeds.get(hostId);
    if (existing && existing.connectionId === connectionId) return;

    const outcome = await this.singleFlight.dispatchKeyed(
      adapter,
      hostId,
      connectionId,
    );
    if (this.closed) return;
    // Publish-time recheck: an outcome (success OR failure) belonging
    // to a generation that is no longer live is dropped — the new
    // generation's own `ready` started its own chain.
    const liveConnectionId =
      this.opts.adapter()?.connectionIdForHost(hostId) ?? null;
    if (liveConnectionId !== connectionId) return;

    if (outcome.kind === 'ok') {
      this.seeds.set(hostId, {
        connectionId,
        seededAtMonotonic: this.monotonicNow(),
        os: outcome.result.os,
        osArch: outcome.result.os_arch,
        daemonPid: outcome.result.daemon_pid,
        daemonVersion: outcome.result.daemon_version,
        startedAt: outcome.result.started_at,
        uptimeMsAtSeed: outcome.result.uptime_ms,
        activeAgentIds: outcome.result.active_agent_ids,
      });
      try {
        this.opts.onSeeded?.(hostId);
      } catch {
        // Invalidation publish is best-effort; the seed itself stands.
      }
      return;
    }

    const delayMs = SEED_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      // The agreed post-rollout observable for the residual risk
      // "seed exhausted while the connection stays healthy": count
      // these occurrences (and whether a reconnect follows) before
      // deciding whether a low-frequency recovery is warranted.
      this.opts.logger?.warn(
        {
          kind: 'host_status_seed',
          action: 'seed_exhausted',
          hostId,
          connectionId,
          attempts: attempt + 1,
        },
        'host_status seed retries exhausted; generation stays un-seeded (reads return unreachable) until the next daemon ready',
      );
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(hostId);
      if (this.closed) return;
      const currentConnectionId =
        this.opts.adapter()?.connectionIdForHost(hostId) ?? null;
      if (currentConnectionId !== connectionId) return;
      void this.seedAttempt(hostId, attempt + 1);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(hostId, timer);
  }

  private clearRetryTimer(hostId: string): void {
    const timer = this.retryTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(hostId);
    }
  }
}

/**
 * Bounded backoff for the eager-seed retry (~48s total; the values
 * mirror the hydrate retry schedule by convention only — no shared
 * import, no retry framework). After exhaustion the generation stays
 * un-seeded (reads keep returning the pending arm) until the next
 * daemon `ready` starts a fresh chain.
 */
export const SEED_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000,
];
