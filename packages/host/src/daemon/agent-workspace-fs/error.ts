import { DaemonTypedError } from '../typed-error.js';
import type { AgentWorkspaceFsErrorCode } from '../../protocol.js';

/**
 * Typed daemon-side error for the new `agent_workspace_tree` and
 * `agent_workspace_file_read` intents (#task:811). Both intents share
 * the same error taxonomy:
 *
 *  - `forbidden_path` — caller-supplied path is shape-rejected (empty,
 *    `.` / `..`, dotfile, NUL/backslash) or its resolution would
 *    escape the agent home base (symlink in chain, realpath crossed
 *    the boundary). Maps to HTTP 400 / 403 at the route layer; the
 *    daemon never distinguishes shape vs escape on the wire.
 *  - `not_found` — graceful missing along the walk (ENOENT / ENOTDIR
 *    on a non-leaf, leaf is a directory when the read endpoint asked
 *    for a file, etc). Maps to HTTP 404. A regular workspace whose
 *    deterministic bundle coordinate has not been materialized yet is
 *    just an ordinary filesystem absence here — relocation-v1 §7 task 4
 *    removed the registry establishment gate, so there is no
 *    `workspace_not_provisioned` refusal in this taxonomy anymore.
 *  - `registry_unavailable` — the daemon could not resolve an AGENTS
 *    ROOT for these two intents (`agentsRootFor` in `daemon/run.ts`),
 *    so there is no base dir to resolve anything under. Two members:
 *    the pre-registration window in slot mode (a `computersRootDir` is
 *    configured, no computer slot registered yet), and a bare daemon
 *    with neither a slot root nor an explicit root — that one can hold
 *    an accepted binding and still have no durable coordinate, and
 *    since #task:1813 it no longer falls back to a home-relative
 *    default. So binding/attach state is NOT the predicate and
 *    attaching is not the recovery for the second half: recovery is a
 *    root (a registered computer slot, or explicit configuration).
 *    Despite the legacy code name this is NOT a workspace-registry
 *    consult (relocation-v1 §3.4 left the registry a migration-only
 *    reader). Note the scope: an unsafe `workspace_id` segment is
 *    `forbidden_path` in THIS taxonomy (`source.ts`), unlike
 *    `runtime_start` where it shares this code. Maps to HTTP 503.
 *  - `fs_unavailable` — host-local fs read failed HARD (perm/IO/EROFS
 *    etc). Maps to HTTP 503.
 *  - `internal_error` — anything else; collapses to HTTP 500.
 */
export class AgentWorkspaceFsError extends DaemonTypedError {
  constructor(
    readonly code: AgentWorkspaceFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWorkspaceFsError';
  }
}
