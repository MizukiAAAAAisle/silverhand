/**
 * The `viewer_workspaces_changed` emit (#task:1987) — one owner for the event
 * name, its payload shape and the scope it rides.
 *
 * It is a CONTRACT, not a convenience: the renderer treats the payload as a hint
 * and refetches `['workspaces']` as the authority
 * (`docs/viewer-visibility-sync-v1.md`), which only works while every producer
 * agrees on `change` and on the per-viewer scope. There were three copies before
 * this module (channel add, workspace roster, workspace delete) and the workspace
 * human-add use case would have made a fourth.
 */
import type { WorkspaceRoleDto } from '@silverhand/shared';
import type { BackendContext } from '../context.js';

// `added` / `role_changed` / `removed` are membership-set deltas (the viewer's
// relationship to the workspace changed). `metadata_changed` is orthogonal: the
// viewer's role is unchanged, but a mutable workspace field the read model
// projects (today: `name`, #task:2050 §4-B) moved, so any surface that renders a
// workspace label is now stale. Same per-viewer scope and same hint-then-refetch
// contract — the renderer refetches `['workspaces']` regardless of `change`.
export type ViewerWorkspaceChange =
  | 'added'
  | 'role_changed'
  | 'removed'
  | 'metadata_changed';

export function publishViewerWorkspacesChanged(
  ctx: BackendContext,
  userId: string,
  payload: {
    change: ViewerWorkspaceChange;
    workspace_id: string;
    // Absent for `removed` (the viewer no longer has a role here) and for
    // `metadata_changed` (the role did not move); the renderer treats the
    // payload as a hint and refetches `['workspaces']` as the authority
    // regardless. See `docs/viewer-visibility-sync-v1.md`.
    role?: WorkspaceRoleDto;
  },
): void {
  ctx.events.publishToScope(`viewer:${userId}`, 'viewer_workspaces_changed', payload);
}
