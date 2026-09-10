// The `GET /api/workspaces` cold-read envelope, composed as ONE pure value
// (#task:2190). This is the join point of two bounded contexts — the viewer's
// visible workspaces and their workspace-rail sort state — over a single
// database snapshot. It lives outside the HTTP handler so the route and the
// cross-language parity oracle (`tests/workspace-cold-read-parity.test.ts`) call
// the SAME composition: there is no second place the envelope can be assembled,
// so the two cannot drift.
import type { ViewerWorkspaceDto, Workspace, WorkspaceColdReadResponse } from '@silverhand/shared';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { SortRepo } from '../repos/sort-repo.js';

/** The stored list key for the workspace rail's per-viewer sort state. */
const WORKSPACE_SORT_LIST_KEY = 'workspaces';

/**
 * Domain `Workspace` → the human viewer's published face (#task:2069).
 *
 * THIS is the boundary the workspace context never had: before it, the repo's
 * domain object was handed to `c.json` verbatim, so the stored container word
 * reached the desktop and the renderer decoded it locally
 * (`features/workspaces/hooks.ts`). There was no seam to convert the word at —
 * hence the debt, not a decision.
 *
 * Every field is copied explicitly. A spread would republish whatever the domain
 * shape gains next, which is how the two jobs got fused in the first place.
 */
export function toViewerWorkspace(workspace: Workspace): ViewerWorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    // Every remaining field is a COPY. The one projection this function used to
    // perform — stored container kind → published word — went out with the word
    // itself (#task:2075): the wire carries `owner_agent_id`, the relation the
    // word restated, and the renderer asks `isAgentHomeWorkspace*`.
    owner_agent_id: workspace.owner_agent_id,
    owner_user_id: workspace.owner_user_id,
    dm_channel_id: workspace.dm_channel_id,
    dm_channel_ids: workspace.dm_channel_ids,
    archived_at: workspace.archived_at,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

export interface WorkspaceColdReadDeps {
  readonly workspaces: Pick<WorkspaceRepo, 'list'>;
  readonly sort: Pick<SortRepo, 'getState'>;
  /**
   * The viewer-visibility decision, injected rather than reached for: the route
   * passes the real `canViewWorkspace(ctx, principal, id)` (existence +
   * `workspace_users` membership for a user principal), and the parity test
   * passes that same predicate over real repositories. Keeping it a capability
   * rather than a `BackendContext` is what lets this function be pure and lets
   * the oracle exercise the exact production visibility rule.
   */
  readonly canViewWorkspace: (workspaceId: string) => boolean;
}

/**
 * Build the whole `{ workspaces, viewer_sort }` envelope for `viewerUserId`.
 *
 * The sort state is filtered to the live SORTABLE set — visible AND
 * non-archived — so neither a stale entity_id (removed / non-member) nor an
 * out-of-scope archived workspace leaks on the wire; archived workspaces stay in
 * the `workspaces` list (their own rail group) but are not sorted.
 */
export function buildWorkspaceColdReadEnvelope(
  deps: WorkspaceColdReadDeps,
  viewerUserId: string,
): WorkspaceColdReadResponse {
  const visible = deps.workspaces.list().filter((workspace) => deps.canViewWorkspace(workspace.id));
  return {
    workspaces: visible.map(toViewerWorkspace),
    // Retained required response field; old ordering is no longer read.
    viewer_sort: { list_key: WORKSPACE_SORT_LIST_KEY, modes: {}, entries: [] },
  };
}
