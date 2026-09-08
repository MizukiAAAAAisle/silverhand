// The foreign-workspace reconcile SCHEDULER (#task:1689 blockers 1/4, review round 2).
//
// Split out of the hook because everything that can be WRONG here is scheduling
// and failure classification, not React: coalescing concurrent notices so no
// channel is dropped, never probing twice at once for the same workspace, and
// telling "the viewer cannot see this workspace at all" apart from "this read did
// not happen". With the transport and the cache injected, all of that is
// falsifiable without rendering anything.
import {
  isWorkspaceVisibilityDenied,
  resolveChannelMembershipLosses,
  type ChannelMembershipLoss,
  type ChannelMembershipRow,
} from "./viewer-channel-removal";

/** Which channels of a workspace a notice asks about: a set of ids, or `null` for
 *  "unknown — every channel this client holds state for" (what a per-scope
 *  `snapshot_required`, or a payload without a channel id, means). */
export type ReconcileScope = ReadonlySet<string> | null;

/**
 * Merge a newly-arrived notice into the one already queued for that workspace.
 *
 * `null` (unknown extent) ABSORBS everything — it is already the widest question.
 * Two narrow notices UNION, which is the part a single slot got wrong: with
 * last-write-wins, c2 arriving during c1's probe and c3 arriving right after left
 * only c3 queued, and c2 — possibly the actual removal — was never re-read.
 */
export function mergeReconcileScope(
  pending: ReconcileScope | undefined,
  incoming: ReconcileScope,
): ReconcileScope {
  if (pending === undefined) return incoming;
  if (pending === null || incoming === null) return null;
  return new Set([...pending, ...incoming]);
}

export interface ForeignReconcilerDeps {
  /** Authoritative re-read of the workspace's two channel tables. MUST reject on
   *  any non-2xx: only a successful read is an observation. */
  fetchTables: (workspaceId: string) => Promise<{
    active: readonly ChannelMembershipRow[];
    archived: readonly ChannelMembershipRow[];
  }>;
  /** Which channels of this workspace the client still holds state for. */
  heldChannelIds: (workspaceId: string) => Set<string>;
  /** One channel of this workspace was lost. */
  onLoss: (workspaceId: string, loss: ChannelMembershipLoss) => void;
  /** The whole workspace is unreadable (403/404): a strictly stronger fact than
   *  any per-channel resolution, carrying every channel still held for it. */
  onWorkspaceUnreadable: (workspaceId: string, held: readonly string[]) => void;
}

export interface ForeignReconciler {
  /** Record a notice for one workspace and probe when a probe is free. */
  request: (workspaceId: string, scope: ReconcileScope) => void;
  /** Resolves once no probe is running or queued. For tests; production fires and
   *  forgets. */
  settled: () => Promise<void>;
  dispose: () => void;
}

/**
 * One probe in flight per workspace, notices coalesced while it runs.
 *
 * FAILURE CLASSIFICATION is the other half of this file. Both list routes are
 * gated by `canViewWorkspace`, so losing the WORKSPACE surfaces as 403 (or 404
 * once it is deleted) on both reads, not as "the channel is absent from both
 * tables" — and it is the one failure the caller must act on, because the
 * workspace scope is truncated the moment the membership edge is deleted, so no
 * later notice for it arrives. Everything else (5xx, timeout, unreachable
 * backend) leaves every cache exactly as it is: a failed read is never evidence
 * of a removal.
 */
export function createForeignWorkspaceReconciler(deps: ForeignReconcilerDeps): ForeignReconciler {
  const inFlight = new Map<string, Promise<void>>();
  const queued = new Map<string, ReconcileScope>();
  let disposed = false;

  const run = async (workspaceId: string, scope: ReconcileScope): Promise<void> => {
    const held = deps.heldChannelIds(workspaceId);
    const observed = scope ? [...held].filter((id) => scope.has(id)) : [...held];
    // Holding nothing for the named channel(s) is the churn guard: a busy
    // workspace the viewer keeps no state in costs no requests.
    if (observed.length === 0) return;
    let tables: Awaited<ReturnType<ForeignReconcilerDeps["fetchTables"]>>;
    try {
      tables = await deps.fetchTables(workspaceId);
    } catch (error) {
      if (!disposed && isWorkspaceVisibilityDenied(error)) {
        deps.onWorkspaceUnreadable(workspaceId, [...held]);
      }
      return;
    }
    if (disposed) return;
    for (const loss of resolveChannelMembershipLosses({ observed, ...tables })) {
      deps.onLoss(workspaceId, loss);
    }
  };

  const start = (workspaceId: string, scope: ReconcileScope): void => {
    const promise = run(workspaceId, scope).finally(() => {
      inFlight.delete(workspaceId);
      if (!queued.has(workspaceId)) return;
      const next = queued.get(workspaceId) ?? null;
      queued.delete(workspaceId);
      if (!disposed) start(workspaceId, next);
    });
    inFlight.set(workspaceId, promise);
  };

  return {
    request(workspaceId, scope) {
      if (disposed) return;
      if (inFlight.has(workspaceId)) {
        queued.set(workspaceId, mergeReconcileScope(queued.get(workspaceId), scope));
        return;
      }
      start(workspaceId, scope);
    },
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
    },
    dispose() {
      disposed = true;
      queued.clear();
    },
  };
}
