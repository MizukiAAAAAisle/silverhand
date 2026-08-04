/**
 * Neutral path-authority for the agent-centric bundle layout.
 *
 * relocation-v1 §7-4 — the workspace-registry was demoted from a runtime path
 * authority to a marker-absent migration/preflight inventory reader. The one
 * path-security invariant that OUTLIVES that demotion — "a server-supplied
 * workspace id may become a filesystem path SEGMENT only after structural
 * validation" — lives here, deliberately OUTSIDE the registry so the runtime
 * resolvers (agent-materialize, runtime-start-resolve, agent-workspace-fs) and
 * the relocation reader can depend on it WITHOUT importing the demoted
 * registry. This is the sole authority that turns a semantic workspace id into
 * a safe path component; nothing downstream re-derives or "repairs" an id.
 */

/**
 * An unsafe workspace id can never become a path segment under the agent home.
 * A dedicated typed error (not the registry's error) so every consumer catches
 * this ONE concern by class — `code` stays `'invalid_path'` for wire/log
 * continuity with the pre-demotion taxonomy.
 */
export class WorkspaceIdSegmentError extends Error {
  readonly code = 'invalid_path' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceIdSegmentError';
  }
}

/**
 * A server-supplied semantic id may become a path component ONLY after
 * structural validation: fs-safe charset (no separators, no dots — `.`/`..`
 * traversal is impossible by construction), non-empty, bounded length.
 * Anything else fails closed as {@link WorkspaceIdSegmentError}; we never
 * "repair" an id by hashing, because an unverifiable id is a contract
 * violation, not an encoding problem.
 */
const SAFE_WORKSPACE_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSafeWorkspaceIdSegment(workspaceId: string): string {
  if (!SAFE_WORKSPACE_ID_SEGMENT.test(workspaceId)) {
    throw new WorkspaceIdSegmentError(
      `workspace id ${JSON.stringify(workspaceId)} is not a safe path segment`,
    );
  }
  return workspaceId;
}
