import type {
  AgentL2SeedParams,
  AgentL2SeedResult,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
  AgentWorkspaceReadParams,
  AgentWorkspaceReadResult,
  WorkspaceProvisionParams,
  WorkspaceProvisionResult,
} from '@silverhand/host';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';

/**
 * D4.e — backend dispatch layer for the host data-plane intents
 * (`workspace_provision`, `agent_workspace_index`, `agent_workspace_read`,
 * `agent_l2_seed`).
 * The daemon is the sole authority for host-local path resolution (I1); the
 * backend only speaks `workspace_id` / `agent_id` and forwards an optional
 * caller-PROPOSED `requested_path` at provision time. This module owns ONE
 * thing: send a data-plane command over the deployment-neutral
 * {@link OutboundFrameAdapter} and normalize every failure (transport or
 * typed wire error) into a single structured outcome so each route can
 * decide how to render it — create → HTTP status; backfill / list / read /
 * seed → fail-closed with a diagnostic code (never a `workspace_path` /
 * server-fs fallback).
 */

export type DataPlaneFailureCode =
  // transport / liveness
  | 'host_attach_pending'
  | 'daemon_timeout'
  | 'daemon_internal_error'
  // typed wire codes (provision)
  | 'invalid_workspace_path'
  | 'workspace_path_conflict'
  | 'unsupported_workspace_kind'
  | 'fs_quota_exceeded'
  | 'fs_unavailable'
  // typed wire codes (agent_l2_seed)
  | 'workspace_not_provisioned'
  | 'unsupported_template'
  // typed wire code (multiple)
  | 'registry_unavailable';

export type DataPlaneHttpStatus = 400 | 409 | 502 | 503 | 504 | 507;

export interface DataPlaneFailure {
  kind: 'failed';
  /** Stable, caller-visible failure code (NOT the raw wire code). */
  code: DataPlaneFailureCode;
  message: string;
  /** Suggested HTTP status if a route renders this directly. */
  status: DataPlaneHttpStatus;
  /**
   * True when the condition is transient (daemon offline / timeout /
   * registry temporarily unavailable) so a later retry — next attach, next
   * boot, next management call — can succeed. Drives backfill retry + lets
   * the read path distinguish "retry later" from "genuinely missing".
   */
  retriable: boolean;
}

export type DataPlaneOutcome<T> = { kind: 'ok'; result: T } | DataPlaneFailure;

const PROVISION_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const SEED_TIMEOUT_MS = 30_000;

/**
 * Resolve the live outbound adapter + connection id for `hostId`, or a
 * `host_attach_pending` failure when the daemon is not currently attached.
 * Capturing the `connectionId` here and passing it as `expectedConnectionId`
 * to the subsequent `sendCommand` locks the check→dispatch window against a
 * reattach race (same guard `agent_materialize` uses).
 */
export function resolveOutboundForHost(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
):
  | { kind: 'ok'; adapter: OutboundFrameAdapter; connectionId: string }
  | DataPlaneFailure {
  const connectionId = adapter?.connectionIdForHost(hostId) ?? null;
  if (!adapter || !connectionId) {
    return {
      kind: 'failed',
      code: 'host_attach_pending',
      message: 'host runtime is not currently attached',
      status: 503,
      retriable: true,
    };
  }
  return { kind: 'ok', adapter, connectionId };
}

/**
 * Normalize any dispatch error into a {@link DataPlaneFailure}. Transport
 * errors map to liveness codes; typed daemon wire codes map to their stable
 * caller-visible code + HTTP status; anything unrecognized degrades to
 * `daemon_internal_error` (502).
 */
export function mapDataPlaneError(err: unknown): DataPlaneFailure {
  if (err instanceof HostWsCommandResponseError) {
    // `err.code` is statically the narrow transport-level union, but a typed
    // per-intent wire code (e.g. `invalid_path`) arrives here at runtime —
    // the daemon scopes it per command and the envelope preserves it. Read
    // it as a string to switch over the data-plane taxonomy (same cast the
    // `agent_materialize` mapper uses).
    const wireCode = err.code as string;
    switch (wireCode) {
      case 'invalid_path':
        return fail('invalid_workspace_path', err.message, 400, false);
      case 'path_conflict':
        return fail('workspace_path_conflict', err.message, 409, false);
      case 'unsupported_kind':
        return fail('unsupported_workspace_kind', err.message, 400, false);
      case 'fs_quota_exceeded':
        return fail('fs_quota_exceeded', err.message, 507, false);
      case 'fs_unavailable':
        // A caller-proposed path that is momentarily unusable on the host
        // (perm/parent-not-a-dir/ENOENT race) — retriable after the user
        // fixes the path or the transient condition clears.
        return fail('fs_unavailable', err.message, 503, true);
      case 'registry_unavailable':
        return fail('registry_unavailable', err.message, 503, true);
      case 'workspace_not_provisioned':
        // agent_l2_seed: the workspace has no registry binding on the owning
        // host. The seed routes ensure provisioning (backfill) BEFORE
        // dispatch, so this is a genuine precondition conflict, not a path
        // the caller can fix by retrying as-is.
        return fail('workspace_not_provisioned', err.message, 409, false);
      case 'unsupported_template':
        // agent_l2_seed: the template_choice has no host-side L2 entry. The
        // backend only ever sends a supported choice, so this is a 400-class
        // request rejection, not a transient condition.
        return fail('unsupported_template', err.message, 400, false);
      case 'internal_error':
      default:
        return fail('daemon_internal_error', err.message, 502, false);
    }
  }
  if (err instanceof HostWsCommandTransportError) {
    if (
      err.code === 'transport_no_connection' ||
      err.code === 'transport_disconnected'
    ) {
      return fail('host_attach_pending', err.message, 503, true);
    }
    if (err.code === 'transport_timeout') {
      return fail('daemon_timeout', err.message, 504, true);
    }
    return fail('daemon_internal_error', err.message, 502, false);
  }
  return fail(
    'daemon_internal_error',
    err instanceof Error ? err.message : String(err),
    502,
    false,
  );
}

function fail(
  code: DataPlaneFailureCode,
  message: string,
  status: DataPlaneHttpStatus,
  retriable: boolean,
): DataPlaneFailure {
  return { kind: 'failed', code, message, status, retriable };
}

/**
 * Dispatch `workspace_provision` to the owning daemon. The daemon binds the
 * registry entry (managed default when `requested_path` is absent, or the
 * re-validated caller path when present) and creates the `.silverhand/`
 * skeleton, returning the authoritative `bound_workspace_path`.
 */
export async function dispatchWorkspaceProvision(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: WorkspaceProvisionParams,
): Promise<DataPlaneOutcome<WorkspaceProvisionResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'workspace_provision', params, {
      timeoutMs: PROVISION_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * Dispatch `agent_workspace_index` to the owning daemon: the route-time
 * `agent_dir` resolver. Returns daemon-stamped `agent_dir` per workspace +
 * an `unresolved` list (regular workspaces with no registry binding). The
 * caller MUST NOT fall back to a `workspace_path`-derived path for
 * unresolved ids — that would re-pierce I1.
 */
export async function dispatchAgentWorkspaceIndex(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentWorkspaceIndexParams,
): Promise<DataPlaneOutcome<AgentWorkspaceIndexResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'agent_workspace_index', params, {
      timeoutMs: INDEX_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * D4.e-2 — dispatch `agent_workspace_read` to the owning daemon: the
 * host-local L1/agent-home read for `GET /api/agents/:id/workspace`. The
 * daemon resolves the agent-home dir from its own homedir and reads
 * `system_prompt.md` / `MEMORY.md` / `notes/`, returning the
 * `AgentWorkspaceDto` the backend relays verbatim — no server-side fs read,
 * no path derivation. A hard host-local fs failure maps fail-closed to
 * `fs_unavailable` (503); the backend never falls back to its own disk.
 */
export async function dispatchAgentWorkspaceRead(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentWorkspaceReadParams,
): Promise<DataPlaneOutcome<AgentWorkspaceReadResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'agent_workspace_read', params, {
      timeoutMs: READ_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * D4.e-3 — dispatch `agent_l2_seed` to the owning daemon: seed a member
 * agent's L2 (per-workspace) memory dir on the host that owns the workspace.
 * Replaces backend `seedAgentL2` (gap G1). The daemon resolves the
 * workspace's host-local path from its own registry and writes
 * `MEMORY.md` + `notes/` (NEVER L1 `system_prompt.md`) idempotently. The
 * backend forwards only `{ agent_id, workspace_id, template_choice }`; the
 * route MUST treat a failure as fail-closed (do NOT insert the
 * `workspace_members` row, do NOT write any server-side L2) — no
 * "member added but L2 not seeded" half-state.
 */
export async function dispatchAgentL2Seed(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentL2SeedParams,
): Promise<DataPlaneOutcome<AgentL2SeedResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'agent_l2_seed', params, {
      timeoutMs: SEED_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}
