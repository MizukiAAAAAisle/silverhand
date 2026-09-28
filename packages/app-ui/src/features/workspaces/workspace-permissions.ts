import type { WorkspaceRole } from "@silverhand/shared";

/**
 * Renderer mirror of the backend workspace-governance gate (`canGovernWorkspace`
 * in `packages/backend/src/permissions.ts`, applied by
 * `routes/workspaces.ts` + `application/delete-workspace.ts`). Authorization
 * itself stays server-side — hiding a control is never the boundary (invariant
 * #4); these predicates only decide which affordances the Workspace Settings UI
 * renders.
 *
 * FAIL-CLOSED by construction: a `null` role — the viewer is not a member, OR
 * the members query has not resolved yet — gets the least privilege, so the UI
 * never renders a writable control it then has to retract once the real role
 * arrives (#task:1772, Cindy's pin).
 *
 * The role → capability map mirrors the routes EXACTLY; if either backend gate
 * moves, change these together:
 *   - rename  (PATCH  /api/workspaces/:id)          → `canGovernWorkspace(…, 'admin')` → owner | admin
 *   - archive (PATCH  /api/workspaces/:id/archive)  → `canGovernWorkspace(…, 'owner')` → owner
 *   - delete  (DELETE /api/workspaces/:id)          → `canGovernWorkspace(…, 'owner')` → owner
 *   - leave   (POST   /api/workspaces/:id/leave)    → member-floor, owner rejected → member | admin
 */

/** Rename is admin-or-owner (the `'admin'` threshold — owner outranks admin). */
export function canRenameWorkspace(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin";
}

/** Archive and Delete are both owner-only — the two lifecycle writes share one
 *  backend gate, so they share one predicate here. */
export function canManageWorkspaceLifecycle(role: WorkspaceRole | null): boolean {
  return role === "owner";
}

/** Leave is SELF-removal: any non-owner member removes themselves (member ∨
 *  admin). The owner is never a candidate — there must always be an owner and
 *  ownership transfer is unsupported, so the owner's exit is Delete, not Leave.
 *  Mirrors the backend self-leave gate (member floor, owner rejected). Null —
 *  non-member or still-loading — is fail-closed, same as the others. Leave and
 *  lifecycle-manage are complementary over any non-null role: owner deletes,
 *  everyone else leaves. */
export function canLeaveWorkspace(role: WorkspaceRole | null): boolean {
  return role === "member" || role === "admin";
}
