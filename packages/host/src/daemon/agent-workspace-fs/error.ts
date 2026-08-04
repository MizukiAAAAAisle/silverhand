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
 *  - `registry_unavailable` — the daemon has no attached computer yet
 *    (the machine has not bound to a server) so its agents root is
 *    unavailable; despite the legacy code name this is NOT a
 *    workspace-registry consult. Maps to HTTP 503 (retriable once
 *    attached).
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
