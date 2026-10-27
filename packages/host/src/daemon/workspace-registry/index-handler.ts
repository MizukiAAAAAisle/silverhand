import { isAgentHomeWorkspaceId } from '@silverhand/shared';
import type {
  AgentWorkspaceIndexErrorCode,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
} from '../../protocol.js';
import { DaemonTypedError } from '../typed-error.js';
import {
  bundleCwdUsable,
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from '../agent-materialize/index.js';
import { WorkspaceIdSegmentError } from '../workspace-path-authority.js';

/**
 * D4.e-1 daemon handler for `agent_workspace_index` — the route-time
 * `agent_dir` resolver (design §3.4). `list_workspaces` stays a backend
 * route that does ACL/DB list, then dispatches this to stamp each
 * `agent_dir` daemon-side, so the backend never assembles a host-local path
 * itself (I1) — and since relocation-v1 §7 there is no stored path it could
 * assemble one from.
 *
 * agent-home detection is structural (the pinned `wsah_<agent_id>`
 * convention, via the shared `isAgentHomeWorkspaceId` single source) — so
 * the backend sends only `{ agent_id, workspace_ids }`: no path AND no
 * kind crosses from the backend.
 *
 * relocation-v1 §7 task 4 — the registry is no longer the establishment gate.
 * Each `agent_dir` is the deterministic agent-centric bundle COORDINATE
 * (`resolveAgentWorkspaceBundleDir`); an entry resolves to a non-null
 * `agent_dir` iff that coordinate is a USABLE working directory RIGHT NOW —
 * the exact same `bundleCwdUsable` predicate the supervisor's pre-spawn
 * cwd-ensure uses (existing directory the process can enter), so list never
 * reports a dir usable that a spawn would then choke on (Cindy 2026-08-04).
 *
 * `agent_dir` is a CWD fact, NOT a memory fact: it deliberately does NOT key
 * on MEMORY.md. A never-spawned member workspace (the legal lazy window after
 * a pure-DB membership add) has no dir yet → `agent_dir: null`; a half-seeded
 * dir (mkdir done, MEMORY.md not written) is a usable cwd → non-null. Whether
 * that workspace's L2 MEMORY is materialized is a SEPARATE fact the prompt's
 * Workspace Memory Index reports via `bundleL2Present` — the two are not
 * conflated.
 */

export class AgentWorkspaceIndexError extends DaemonTypedError {
  constructor(
    readonly code: AgentWorkspaceIndexErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWorkspaceIndexError';
  }
}

export interface IndexAgentWorkspacesDeps {
  /**
   * The EXACT agents root agent-home resolution joins onto, from the
   * composition root. Required — no implicit default (#task:1813).
   */
  agentHomeRootDir: string;
}

export async function indexAgentWorkspaces(
  params: AgentWorkspaceIndexParams,
  deps: IndexAgentWorkspacesDeps,
): Promise<AgentWorkspaceIndexResult> {
  const entries: AgentWorkspaceIndexResult['entries'] = [];
  const unresolved: string[] = [];

  for (const workspaceId of params.workspace_ids) {
    // Agent-home (DM): the L1 dir, derived from the daemon's own agents root
    // — materialized by `agent_materialize`. Structural match on the canonical
    // id. Still a CWD fact: report it ONLY if the L1 dir is a usable cwd right
    // now (the SAME `bundleCwdUsable` predicate as regular workspaces), so we
    // never fabricate an `agent_dir` for a dir that is missing / not enterable
    // and that a spawn would then choke on.
    if (isAgentHomeWorkspaceId(workspaceId, params.agent_id)) {
      const agentDir = resolveAgentDir(params.agent_id, deps);
      if (await bundleCwdUsable(agentDir)) {
        entries.push({ workspace_id: workspaceId, agent_dir: agentDir });
      } else {
        unresolved.push(workspaceId);
      }
      continue;
    }

    // Regular workspace: derive the deterministic bundle coordinate, then
    // report it ONLY if it is a usable cwd on this computer right now.
    let bundleDir: string;
    try {
      bundleDir = resolveAgentWorkspaceBundleDir(params.agent_id, workspaceId, deps);
    } catch (err) {
      // An unsafe id segment cannot form a bundle coordinate. Degrade this
      // entry to unresolved (→ agent_dir null); never fabricate a path. Any
      // other error is a genuine bug → fail the call typed.
      if (err instanceof WorkspaceIdSegmentError) {
        unresolved.push(workspaceId);
        continue;
      }
      throw new AgentWorkspaceIndexError(
        'internal_error',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (await bundleCwdUsable(bundleDir)) {
      entries.push({ workspace_id: workspaceId, agent_dir: bundleDir });
    } else {
      // Valid coordinate, no usable working dir yet (lazy window: never
      // spawned here) → unavailable. The backend surfaces this as
      // `agent_dir: null`. This is a CWD fact; whether L2 MEMORY exists is a
      // separate concern the prompt's memory index reports independently.
      unresolved.push(workspaceId);
    }
  }

  return { ok: true, entries, unresolved };
}
