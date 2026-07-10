import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
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
 * - Per-(host,id,connection) in-flight guard collapses concurrent callers onto
 *   one dispatch per row. A successfully-bound (host,id) is memoized ONLY for
 *   the daemon connection that acknowledged it. A reconnect may attach a fresh
 *   registry namespace, so the next connection must provision again. A failed
 *   id is NOT memoized — backfill is not one-shot.
 */

export interface WorkspaceRegistryBackfillRow {
  /** The registry key (workspace id). */
  id: string;
  /** Legacy cached path, forwarded verbatim as `requested_path`. */
  workspace_path: string;
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

type PerIdOutcome =
  | { kind: 'provisioned' }
  | { kind: 'alreadyBound' }
  | { kind: 'failed'; failure: WorkspaceRegistryBackfillFailure };

export class WorkspaceRegistryBackfiller {
  /** Per-(host,id,connection) provision — concurrent callers collapse. */
  private readonly inFlight = new Map<string, Promise<PerIdOutcome>>();
  /** Latest connection that acknowledged each (host,id) binding. */
  private readonly settledConnection = new Map<string, string>();

  constructor(private readonly deps: WorkspaceRegistryBackfillerDeps) {}

  /** Plain-text composite keys. JSON encoding prevents separator collisions. */
  private workspaceKey(hostId: string, id: string): string {
    return JSON.stringify([hostId, id]);
  }

  private connectionKey(
    hostId: string,
    id: string,
    connectionId: string,
  ): string {
    return JSON.stringify([hostId, id, connectionId]);
  }

  /**
   * Ensure every passed `rows` workspace is bound in `hostId`'s daemon
   * registry. Idempotent + concurrency-safe: a memoized (host,id) returns
   * immediately within the SAME daemon connection, an in-flight dispatch for
   * the same row + connection is shared, and a failed id is left un-memoized
   * so the next call retries. A new connection always re-provisions because
   * reconnecting can change the daemon's registry binding/namespace. Only the
   * rows the caller passes are touched — an unrelated host row never enters
   * here.
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
    const outbound = resolveOutboundForHost(
      this.deps.outboundFrameAdapter(),
      hostId,
    );
    if (outbound.kind === 'failed') {
      return Promise.resolve({
        kind: 'failed',
        failure: {
          id: row.id,
          code: outbound.code,
          message: outbound.message,
          retriable: outbound.retriable,
        },
      });
    }

    const workspaceKey = this.workspaceKey(hostId, row.id);
    if (this.settledConnection.get(workspaceKey) === outbound.connectionId) {
      return Promise.resolve({ kind: 'alreadyBound' });
    }
    const connectionKey = this.connectionKey(
      hostId,
      row.id,
      outbound.connectionId,
    );
    const running = this.inFlight.get(connectionKey);
    if (running) return running;
    const run = this.provisionOne(hostId, row, outbound).finally(() => {
      this.inFlight.delete(connectionKey);
    });
    this.inFlight.set(connectionKey, run);
    return run;
  }

  private async provisionOne(
    hostId: string,
    row: WorkspaceRegistryBackfillRow,
    outbound: Extract<
      ReturnType<typeof resolveOutboundForHost>,
      { kind: 'ok' }
    >,
  ): Promise<PerIdOutcome> {
    const provision = await dispatchWorkspaceProvision(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      {
        workspace_id: row.id,
        kind: 'regular',
        requested_path: row.workspace_path,
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
    // re-validated requested path it pins the resolved form.
    this.deps.workspaces.updateWorkspacePathCache(
      row.id,
      provision.result.bound_workspace_path,
    );
    this.settledConnection.set(
      this.workspaceKey(hostId, row.id),
      outbound.connectionId,
    );
    return provision.result.provisioned
      ? { kind: 'provisioned' }
      : { kind: 'alreadyBound' };
  }
}
