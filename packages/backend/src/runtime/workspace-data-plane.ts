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
} from '@silverhand/host';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import { AgentDeletionPendingError } from './deletion-aware-outbound-frame-adapter.js';

/**
 * D4.e — backend dispatch layer for the host data-plane intents
 * (`agent_workspace_index`, `agent_l2_seed`, `agent_files_purge`, and the
 * agent workspace tree/file/profile-MCP reads).
 *
 * relocation-v1 §3.4 / §7-4 — registry demotion: the workspace-registry is no
 * longer a runtime path authority, so this module no longer carries
 * `workspace_provision` / `workspace_path_index` / `workspace_unbind` /
 * `workspace_registry_ids`. The daemon remains the sole authority for
 * host-local path resolution (I1); the backend only speaks
 * `workspace_id` / `agent_id`. This module owns ONE thing: send a data-plane
 * command over the deployment-neutral {@link OutboundFrameAdapter} and
 * normalize every failure (transport or typed wire error) into a single
 * structured outcome. It NEVER falls back to server-side fs. What a caller
 * does with that outcome is the CALLER's policy, and the two are deliberately
 * different (shiki + Cindy 2026-08-04 pivot): the workspace/file reads render
 * a diagnostic code (or degrade a single entry to `agent_dir: null`), while
 * first-spawn L2 seeding is best-effort enrichment — its failure is logged and
 * the spawn continues, because only the session cwd is a hard runtime
 * precondition.
 */

/**
 * Every code this mapper can actually produce, grouped by the surviving wire
 * producer (relocation-v1 §7-4 U5). The retired `workspace_provision` intent's
 * codes (`invalid_workspace_path` / `workspace_path_conflict` /
 * `unsupported_workspace_kind`) are gone with it: no daemon handler emits
 * `invalid_path` / `path_conflict` / `unsupported_kind` on any wire enum, so an
 * arm for them would be an authoritative-but-wrong taxonomy entry.
 * `workspace_not_provisioned` is likewise not a data-plane code any more — its
 * one surviving producer is the `runtime_start` resolver's agent-home ownership
 * boundary, mapped by `runtimeStartErrorResponse`, never by this module.
 */
export type DataPlaneFailureCode =
  // transport / liveness
  | 'host_attach_pending'
  | 'daemon_timeout'
  | 'daemon_internal_error'
  // hard host-local fs failure (every fs-touching intent)
  | 'fs_unavailable'
  // typed wire code (agent_l2_seed)
  | 'unsupported_template'
  // typed wire code (agent_files_purge)
  | 'partial_purge'
  | 'quiesce_failed'
  | 'agent_deleting'
  // typed wire code (agent_profile_mcp_write)
  | 'invalid_config'
  // typed wire codes (agent_workspace_tree / agent_workspace_file_read)
  | 'forbidden_path'
  | 'not_found'
  // typed wire code (agent_workspace_index / _tree / _file_read / agent_l2_seed)
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
   * True when the condition is transient (daemon offline / timeout / the
   * computer has not attached to a control plane yet) so a later retry — next
   * attach, next boot, next management call — can succeed. Lets the read path
   * distinguish "retry later" from "genuinely missing".
   */
  retriable: boolean;
}

export type DataPlaneOutcome<T> = { kind: 'ok'; result: T } | DataPlaneFailure;

const INDEX_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const SEED_TIMEOUT_MS = 30_000;
const PURGE_TIMEOUT_MS = 60_000;
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
  if (err instanceof AgentDeletionPendingError) {
    return fail('agent_deleting', err.message, 409, false);
  }
  if (err instanceof HostWsCommandResponseError) {
    // `err.code` is statically the narrow transport-level union, but a typed
    // per-intent wire code (e.g. `forbidden_path`) arrives here at runtime —
    // the daemon scopes it per command and the envelope preserves it. Read
    // it as a string to switch over the data-plane taxonomy (same cast the
    // `agent_materialize` mapper uses).
    const wireCode = err.code as string;
    switch (wireCode) {
      case 'fs_unavailable':
        // A hard host-local fs failure (perm/IO/EROFS/ENOSPC) under the
        // resolved bundle or L1 dir. Retriable: the operator can clear the
        // condition and re-issue; the backend never falls back to its own disk.
        return fail('fs_unavailable', err.message, 503, true);
      case 'registry_unavailable':
        // Despite the legacy name, this is NOT a registry consult
        // (relocation-v1 §7-4 demoted it). Two producers, both fail-closed:
        // the daemon has no attached computer yet, so it has no agents root to
        // resolve anything under (`agentsRootFor`) — by far the reachable one;
        // or a workspace id segment that could never form a bundle coordinate
        // (path-safety refusal, unreachable from DB-minted ids). 503 retriable
        // for the attach case, which is the only one a user can clear.
        return fail('registry_unavailable', err.message, 503, true);
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
      case 'quiesce_failed':
        return fail('quiesce_failed', err.message, 503, true);
      case 'agent_deleting':
        return fail('agent_deleting', err.message, 409, false);
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
 * Dispatch `agent_workspace_index` to the owning daemon: the route-time
 * `agent_dir` resolver. Returns daemon-stamped `agent_dir` per workspace + an
 * `unresolved` list (regular workspaces whose deterministic bundle coordinate
 * is not materialized on that computer yet — a lazy-seed window, not a
 * refusal). The caller MUST NOT synthesize a path for an unresolved id: only
 * the daemon may name a host-local path (I1).
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
 * #task:811/#1190 — dispatch `agent_workspace_tree` to the owning daemon.
 * The daemon walks either the agent home dir (no `workspace_id`) or the
 * daemon-resolved per-workspace memory dir (`workspace_id`) and returns a flat
 * list of every visible entry; the backend relays it verbatim — no fs read, no
 * path derivation. Hard host-local fs failure (perm/IO/EROFS) →
 * `fs_unavailable` (503), the backend never falls back to its own disk.
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
 * #task:811/#1190 — dispatch `agent_workspace_file_read` to the owning daemon.
 * The daemon enforces the path security rules (segment shape, per-segment
 * lstat, realpath boundary) under the selected semantic source before
 * returning the file bytes; the backend forwards `path` opaquely and surfaces
 * the daemon's typed error verdict directly. The read cap is daemon-side (it is
 * a frame-size bound, not a UI one); the backend just relays `truncated`.
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
 * D4.e-3 — dispatch `agent_l2_seed` to the owning daemon: materialize a member
 * agent's L2 (per-workspace) memory bundle on that agent's own computer.
 * Replaces backend `seedAgentL2` (gap G1). The daemon resolves the target from
 * `{ agent_id, workspace_id }` alone — the deterministic agent-centric bundle
 * coordinate (relocation-v1 §7-4: no registry, no provision gate; seeding IS
 * what materializes the coordinate) — and writes `MEMORY.md` + `notes/` (NEVER
 * L1 `system_prompt.md`) idempotently.
 *
 * Callers must NOT treat a failure as a gate: L2 memory is best-effort
 * enrichment (see `AgentL2SeedEnsurer`). Membership is a pure DB write that no
 * longer waits on a seed, and the session cwd — the one hard-ensured runtime
 * base — is enforced separately host-side.
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
 * G3). relocation-v1 §7 task 4: the agent's whole managed footprint is a
 * single home tree, so the daemon removes it in one rm and consults NO
 * registry; the backend forwards only `{ agent_id }`. Per the §3.3 commit
 * boundary, the route MUST treat any failure as fail-closed: keep the DB row
 * (do NOT delete) so a later retry has its routing anchor — never fall back
 * to a server-side `fs.rm`.
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
