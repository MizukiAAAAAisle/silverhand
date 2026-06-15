import type {
  AgentL2SeedParams,
  AgentL2SeedResult,
  AgentFilesPurgeParams,
  AgentFilesPurgeResult,
  AgentProfileMcpReadParams,
  AgentProfileMcpReadResult,
  AgentProfileMcpWriteParams,
  AgentProfileMcpWriteResult,
  McpProbeParams,
  McpProbeResult,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
  AgentWorkspaceTreeParams,
  AgentWorkspaceTreeResult,
  AgentWorkspaceFileReadParams,
  AgentWorkspaceFileReadResult,
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
 * (`workspace_provision`, `agent_workspace_index`,
 * `agent_l2_seed`, `agent_files_purge`).
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
  // typed wire code (agent_files_purge)
  | 'partial_purge'
  // typed wire code (agent_profile_mcp_write)
  | 'invalid_config'
  // typed wire codes (agent_workspace_tree / agent_workspace_file_read)
  | 'forbidden_path'
  | 'not_found'
  // typed wire code (multiple)
  | 'registry_unavailable';

export type DataPlaneHttpStatus = 400 | 403 | 404 | 409 | 502 | 503 | 504 | 507;

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
const PURGE_TIMEOUT_MS = 30_000;
const PROFILE_MCP_TIMEOUT_MS = 30_000;
// #task:1137 — probe walks connect+initialize (≤10s) then optional tools/list
// (≤10s) host-side; the data-plane wait must exceed that sum plus transport
// slack so a slow-but-valid server isn't cut off before the host's own timeout.
const MCP_PROBE_TIMEOUT_MS = 45_000;

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
      case 'partial_purge':
        // agent_files_purge: one or more host-local target dirs could not be
        // removed (hard fs error). Fail-closed (§3.3): the DELETE route keeps
        // the DB row so a later retry has its routing anchor. Retriable — the
        // operator can clear the fs condition (perm/space) and re-issue.
        return fail('partial_purge', err.message, 503, true);
      case 'forbidden_path':
        // #task:811 — agent_workspace_tree / agent_workspace_file_read: the
        // caller-supplied virtual path is shape-rejected (`.` / `..` /
        // dotfile / NUL / backslash / leading or trailing slash) OR its
        // resolution would escape the agent home base (symlink in chain,
        // realpath crossed the boundary). 400 — the renderer must show the
        // failure as a UI-level reject, not a transient retry. Not retriable.
        return fail('forbidden_path', err.message, 400, false);
      case 'not_found':
        // #task:811: graceful missing along the walk OR the path resolves to
        // a directory when the read endpoint asked for a file. 404 — same
        // semantics as a renderer asking for a non-existent agent.
        return fail('not_found', err.message, 404, false);
      case 'invalid_config':
        // #task:1135 — agent_profile_mcp_write: the raw MCP payload failed the
        // canonical schema on host-side re-validation. The route validates
        // first, so this is belt-and-suspenders; 400, not retriable.
        return fail('invalid_config', err.message, 400, false);
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
 * #task:811 — dispatch `agent_workspace_tree` to the owning daemon. The
 * daemon walks the agent home dir and returns a flat list of every visible
 * entry; the backend relays it verbatim — no fs read, no path derivation.
 * Hard host-local fs failure (perm/IO/EROFS) → `fs_unavailable` (503), the
 * backend never falls back to its own disk.
 */
export async function dispatchAgentWorkspaceTree(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentWorkspaceTreeParams,
): Promise<DataPlaneOutcome<AgentWorkspaceTreeResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'agent_workspace_tree', params, {
      timeoutMs: READ_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * #task:811 — dispatch `agent_workspace_file_read` to the owning daemon.
 * The daemon enforces the path security rules (segment shape, per-segment
 * lstat, realpath boundary) before returning the file bytes; the backend
 * forwards `path` opaquely and surfaces the daemon's typed error verdict
 * directly. The 64KB cap is daemon-side; the backend just relays
 * `truncated`.
 */
export async function dispatchAgentWorkspaceFileRead(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentWorkspaceFileReadParams,
): Promise<DataPlaneOutcome<AgentWorkspaceFileReadResult>> {
  try {
    const result = await adapter.sendCommand(
      hostId,
      'agent_workspace_file_read',
      params,
      {
        timeoutMs: READ_TIMEOUT_MS,
        expectedConnectionId: connectionId,
      },
    );
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

/**
 * D4.e-4 — dispatch `agent_files_purge` to the owning daemon: remove an
 * agent's host-local L1/L2 files on the host that owns them. Replaces the
 * backend `DELETE /api/agents/:id` `fs.rm(l1_path / l2_paths)` block (gap
 * G3). The daemon resolves L1 (its homedir) and each L2 (workspace path from
 * its registry) itself; the backend forwards only `{ agent_id, scope,
 * workspace_ids }`. Per the §3.3 commit boundary, the route MUST treat any
 * failure as fail-closed: keep the DB row (do NOT delete) so a later retry
 * has its routing anchor — never fall back to a server-side `fs.rm`.
 */
export async function dispatchAgentFilesPurge(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentFilesPurgeParams,
): Promise<DataPlaneOutcome<AgentFilesPurgeResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'agent_files_purge', params, {
      timeoutMs: PURGE_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * #task:1135 — dispatch `agent_profile_mcp_read` to the owning daemon: read
 * the agent's L1 `mcp.json` (the host-local truth behind `silverhand profile
 * mcp get` and the agent-pane "Profile MCP" view). The daemon resolves the L1
 * dir from `agent_id` (I1) and returns the raw text or `null` (absent = the
 * normal "no MCP configured" case, not an error).
 */
export async function dispatchAgentProfileMcpRead(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentProfileMcpReadParams,
): Promise<DataPlaneOutcome<AgentProfileMcpReadResult>> {
  try {
    const result = await adapter.sendCommand(
      hostId,
      'agent_profile_mcp_read',
      params,
      {
        timeoutMs: PROFILE_MCP_TIMEOUT_MS,
        expectedConnectionId: connectionId,
      },
    );
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * #task:1135 — dispatch `agent_profile_mcp_write` to the owning daemon: replace
 * the agent's L1 `mcp.json` (behind `silverhand profile mcp set`). The backend
 * route is the primary validation authority (rejects `invalid_config` before
 * dispatch); the daemon re-validates fail-loud then writes ATOMICALLY. Effect
 * is next-spawn (no hot reload).
 */
export async function dispatchAgentProfileMcpWrite(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: AgentProfileMcpWriteParams,
): Promise<DataPlaneOutcome<AgentProfileMcpWriteResult>> {
  try {
    const result = await adapter.sendCommand(
      hostId,
      'agent_profile_mcp_write',
      params,
      {
        timeoutMs: PROFILE_MCP_TIMEOUT_MS,
        expectedConnectionId: connectionId,
      },
    );
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

/**
 * #task:1137 — dispatch `mcp_probe` to the owning daemon: open a one-shot live
 * MCP connection to one of the agent's profile servers (initialize + optional
 * tools/list) and close it. The daemon resolves the server config from the
 * source (v1 `profile` → the agent's L1 `mcp.json`) and connects to the RAW
 * endpoint. Connection/handshake/tools failures come back INSIDE the result
 * (`ok:false` + phase); only a host fault maps to a failed outcome here.
 */
export async function dispatchMcpProbe(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
  params: McpProbeParams,
): Promise<DataPlaneOutcome<McpProbeResult>> {
  try {
    const result = await adapter.sendCommand(hostId, 'mcp_probe', params, {
      timeoutMs: MCP_PROBE_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}
