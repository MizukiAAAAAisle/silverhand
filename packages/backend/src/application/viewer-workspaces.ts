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

export type ViewerWorkspaceChange = 'added' | 'role_changed' | 'removed';

export function publishViewerWorkspacesChanged(
  ctx: BackendContext,
  userId: string,
  payload: {
    change: ViewerWorkspaceChange;
    workspace_id: string;
    // Absent for `removed` (the viewer no longer has a role here); the
    // renderer treats the payload as a hint and refetches `['workspaces']`
    // as the authority regardless. See `docs/viewer-visibility-sync-v1.md`.
    role?: WorkspaceRoleDto;
  },
): void {
  ctx.events.publishToScope(`viewer:${userId}`, 'viewer_workspaces_changed', payload);
}
