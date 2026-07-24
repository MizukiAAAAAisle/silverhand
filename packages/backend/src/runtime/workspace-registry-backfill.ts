import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  dispatchAgentL2Seed,
  dispatchWorkspaceProvision,
  resolveOutboundForHost,
  type DataPlaneFailureCode,
} from './workspace-data-plane.js';

/**
 * D4.e-1 3b-2 — migration backfill of the daemon workspace registry.
 *
 * Pre-D4.e, a regular workspace's host-local path lived ONLY in the server
 * column `workspaces.workspace_path`. From D4.e the daemon registry is the
 * authority (I1), and the read path (`agent_workspace_index`) fail-closes on
 * any `workspace_id` the daemon never provisioned. So every legacy row must be
 * re-bound into the registry by RE-PROVISIONING it with its stored path as the
 * `requested_path` — a faithful re-bind the daemon treats as idempotent
 * (registry idempotent-first: re-binding an id to the exact path it already
 * holds is a no-op, even for a managed-default path inside the managed root).
 *
 * Design constraints (Cindy, Plan A + 3b P1-2):
 * - The helper ONLY dispatches `workspace_provision`. It never assembles or
 *   interprets a host path — it forwards `workspace_path` as `requested_path`
 *   and caches the daemon's authoritative `bound_workspace_path` back into the
 *   legacy column.
 * - Failure is NOT swallowed. `ensure()` returns a STRUCTURED result
 *   (per-id provisioned / alreadyBound / failed) so a caller (the list route)
 *   can fail-closed and surface it — never silently fall back to
 *   `workspace_path`.
 * - **Scoped to the caller's rows (P1-2, Cindy):** `ensure()` takes the EXACT
 *   rows the current response needs resolved (the visible regular workspaces),
 *   NOT every regular row on the host. A bad/unbindable legacy row that the
 *   current agent can't even see must never fail-close that agent's list. The
 *   "read fail-closed" granularity is per-requested-id, not per-host.
 * - Per-(host,id) in-flight guard collapses concurrent callers onto one
 *   dispatch per row. The registry namespace is owned by the stable
 *   (server_origin, host_id) binding, not by a websocket connection or daemon
 *   process. A successfully-bound (host,id) therefore survives transport and
 *   process reconnects within this backend lifetime. A failed id is NOT
 *   memoized — backfill is not one-shot.
 */

export interface WorkspaceRegistryBackfillRow {
  /** The registry key (workspace id). */
  id: string;
  /**
   * Path to forward as `requested_path`:
   * - a string — the legacy cached home path, forwarded verbatim (same-host
   *   re-bind / migration);
   * - `null` — cross-computer guest ensure: the daemon self-picks its
   *   deterministic managed root. A guest bind must NEVER receive the home
   *   computer's path, and its `bound_workspace_path` ack must NEVER be
   *   written back into the server's legacy `workspace_path` column (that
   *   column is the home computer's path, not a per-computer value).
   */
  workspace_path: string | null;
}

export interface WorkspaceRegistryBackfillFailure {
  id: string;
  code: DataPlaneFailureCode;
  message: string;
  retriable: boolean;
}

export interface WorkspaceRegistryBackfillResult {
  hostId: string;
  /**
   * - `noop`    — caller passed no rows to bind.
   * - `ok`      — every requested row is now bound (newly or idempotently).
   * - `partial` — some rows bound, some failed (mixed) → retriable.
   * - `failed`  — no row bound; all failed (e.g. daemon offline) → retriable.
   */
  status: 'noop' | 'ok' | 'partial' | 'failed';
  /** Ids the daemon bound for the first time this run. */
  provisioned: string[];
  /** Ids the daemon reported already bound (idempotent re-bind / memoized). */
  alreadyBound: string[];
  /** Ids that failed, with the structured data-plane code. */
  failed: WorkspaceRegistryBackfillFailure[];
}

export interface WorkspaceRegistryBackfillerDeps {
  workspaces: Pick<WorkspaceRepo, 'updateWorkspacePathCache'>;
  outboundFrameAdapter: () => OutboundFrameAdapter | null;
}

/**
 * #task:1529 — the redacted server-log summary the hydrate-time migration
 * AUDIT emits (no paths / names — only counts + the distinct failure codes).
 * `migration_complete` is the per-host migration-complete evidence the fleet
 * delete decision reads: the delete gate is "every supported, attached host
 * shows migration_complete=true at least once", NOT a provisioned_count decay.
 */
export interface WorkspaceRegistryMigrationAuditSummary {
  workspace_count: number;
  /** Rows the daemon bound for the FIRST time this run. Informational only —
   *  NOT the delete signal: a warm audit memoizes prior daemon ACKs so this
   *  reads 0 regardless of hot-path use. `migration_complete` is the evidence. */
  provisioned_count: number;
  already_bound_count: number;
  failed_count: number;
  /** Distinct failure codes, sorted for stable aggregation. */
  failure_codes: DataPlaneFailureCode[];
  /** True iff every enumerated workspace bound (freshly or from a prior daemon
   *  ACK this backend lifetime) — no failure left. The per-host completion. */
  migration_complete: boolean;
}

/**
 * Reduce a backfill `ensure()` result to the audit summary. Pure: every row
 * lands in exactly one of provisioned / alreadyBound / failed, so their sum is
 * the candidate count. `migration_complete` is a clean `failed === 0`, matching
 * `ensure()`'s `ok` / `noop` statuses.
 */
export function summarizeMigrationAudit(
  result: WorkspaceRegistryBackfillResult,
): WorkspaceRegistryMigrationAuditSummary {
  return {
    workspace_count:
      result.provisioned.length +
      result.alreadyBound.length +
      result.failed.length,
    provisioned_count: result.provisioned.length,
    already_bound_count: result.alreadyBound.length,
    failed_count: result.failed.length,
    failure_codes: [...new Set(result.failed.map(f => f.code))].sort(),
    migration_complete: result.failed.length === 0,
  };
}


type PerIdOutcome =
  | { kind: 'provisioned' }
  | { kind: 'alreadyBound' }
  | { kind: 'failed'; failure: WorkspaceRegistryBackfillFailure };

export class WorkspaceRegistryBackfiller {
  /** Per-(host,id) provision — concurrent callers collapse. */
  private readonly inFlight = new Map<string, Promise<PerIdOutcome>>();
  /** Bindings already confirmed in this backend's stable registry namespace. */
  private readonly settled = new Set<string>();

  constructor(private readonly deps: WorkspaceRegistryBackfillerDeps) {}

  /** Plain-text composite key. JSON encoding prevents separator collisions. */
  private key(hostId: string, id: string): string {
    return JSON.stringify([hostId, id]);
  }

  /**
   * Ensure every passed `rows` workspace is bound in `hostId`'s daemon
   * registry. Idempotent + concurrency-safe: a memoized (host,id) returns
   * immediately, an in-flight dispatch for the same row is shared, and a
   * failed id is left un-memoized so the next call retries. Reconnecting the
   * same host does not change its persistent registry namespace. Only the rows
   * the caller passes are touched — an unrelated host row never enters here.
   */
  async ensure(
    hostId: string,
    rows: WorkspaceRegistryBackfillRow[],
  ): Promise<WorkspaceRegistryBackfillResult> {
    const result: WorkspaceRegistryBackfillResult = {
      hostId,
      status: 'noop',
      provisioned: [],
      alreadyBound: [],
      failed: [],
    };
    if (rows.length === 0) return result;

    // Process sequentially for deterministic cache-write order; each row goes
    // through the per-(host,id) in-flight guard so a concurrent ensure() for
    // the same row collapses onto one dispatch.
    for (const row of rows) {
      const outcome = await this.ensureOne(hostId, row);
      if (outcome.kind === 'provisioned') result.provisioned.push(row.id);
      else if (outcome.kind === 'alreadyBound') result.alreadyBound.push(row.id);
      else result.failed.push(outcome.failure);
    }

    const bound = result.provisioned.length + result.alreadyBound.length;
    if (result.failed.length === 0) result.status = bound === 0 ? 'noop' : 'ok';
    else result.status = bound === 0 ? 'failed' : 'partial';
    return result;
  }

  private ensureOne(
    hostId: string,
    row: WorkspaceRegistryBackfillRow,
  ): Promise<PerIdOutcome> {
    const key = this.key(hostId, row.id);
    if (this.settled.has(key)) {
      return Promise.resolve({ kind: 'alreadyBound' });
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = this.provisionOne(hostId, row).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async provisionOne(
    hostId: string,
    row: WorkspaceRegistryBackfillRow,
  ): Promise<PerIdOutcome> {
    const outbound = resolveOutboundForHost(
      this.deps.outboundFrameAdapter(),
      hostId,
    );
    if (outbound.kind === 'failed') {
      return {
        kind: 'failed',
        failure: {
          id: row.id,
          code: outbound.code,
          message: outbound.message,
          retriable: outbound.retriable,
        },
      };
    }
    const provision = await dispatchWorkspaceProvision(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      {
        workspace_id: row.id,
        kind: 'regular',
        ...(row.workspace_path === null
          ? {}
          : { requested_path: row.workspace_path }),
      },
    );
    if (provision.kind === 'failed') {
      return {
        kind: 'failed',
        failure: {
          id: row.id,
          code: provision.code,
          message: provision.message,
          retriable: provision.retriable,
        },
      };
    }
    // Refresh the legacy cache from the daemon's authoritative ack. For a
    // managed-default row this rewrites the same value (no-op); for a
    // re-validated requested path it pins the resolved form. A guest bind
    // (null requested path) is a DIFFERENT computer's root — never write it
    // into the home-path column.
    if (row.workspace_path !== null) {
      this.deps.workspaces.updateWorkspacePathCache(
        row.id,
        provision.result.bound_workspace_path,
      );
    }
    this.settled.add(this.key(hostId, row.id));
    return provision.result.provisioned
      ? { kind: 'provisioned' }
      : { kind: 'alreadyBound' };
  }
}

export interface AgentL2SeedEnsureFailure {
  code: DataPlaneFailureCode;
  message: string;
  retriable: boolean;
}

export type AgentL2SeedEnsureResult =
  | { ok: true }
  | { ok: false; failure: AgentL2SeedEnsureFailure };

/**
 * Cross-computer slice 1 (#task:1596) — pre-spawn L2 seed on the DISPATCH
 * host. The membership-time seed (`seedMemberAgentL2`) runs on the workspace's
 * home computer; when an agent lives on a different computer, its L2 for this
 * workspace must exist under that computer's local root before the first
 * spawn. This ensurer dispatches the idempotent `agent_l2_seed` intent to the
 * agent's daemon (which resolves the workspace via ITS registry — so the
 * workspace must be provisioned there first; callers order provision → seed).
 *
 * Same discipline as {@link WorkspaceRegistryBackfiller}: per-(host, workspace,
 * agent) success memo for this backend lifetime (the daemon-side seed is
 * `writeIfMissing`-idempotent, so a repeat after backend restart is safe),
 * in-flight collapse for concurrent spawns, and failures are NOT memoized so
 * the next spawn retries.
 */
export class AgentL2SeedEnsurer {
  private readonly inFlight = new Map<string, Promise<AgentL2SeedEnsureResult>>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly deps: { outboundFrameAdapter: () => OutboundFrameAdapter | null },
  ) {}

  private key(hostId: string, workspaceId: string, agentId: string): string {
    return JSON.stringify([hostId, workspaceId, agentId]);
  }

  async ensure(
    hostId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<AgentL2SeedEnsureResult> {
    const key = this.key(hostId, workspaceId, agentId);
    if (this.settled.has(key)) return { ok: true };
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = this.seedOne(hostId, workspaceId, agentId, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async seedOne(
    hostId: string,
    workspaceId: string,
    agentId: string,
    key: string,
  ): Promise<AgentL2SeedEnsureResult> {
    const outbound = resolveOutboundForHost(
      this.deps.outboundFrameAdapter(),
      hostId,
    );
    if (outbound.kind === 'failed') {
      return {
        ok: false,
        failure: {
          code: outbound.code,
          message: outbound.message,
          retriable: outbound.retriable,
        },
      };
    }
    const seed = await dispatchAgentL2Seed(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
    );
    if (seed.kind === 'failed') {
      return {
        ok: false,
        failure: {
          code: seed.code,
          message: seed.message,
          retriable: seed.retriable,
        },
      };
    }
    this.settled.add(key);
    return { ok: true };
  }
}
