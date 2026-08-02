import type { WorkspaceRole } from '@silverhand/shared';

/**
 * Renderer mirror of the backend agent-capability EDIT gate (#task:1778,
 * approved #task:1775 option A). Mirrors the #task:1777 composite gate
 * `canEditAgentCapabilities(ctx, principal, ws, agent)` =
 * `admin(ws) ∨ (member(ws) ∧ creator(agent))` applied to `PUT …/capabilities`:
 * a workspace governor (owner | admin) edits any agent; a plain member edits
 * ONLY the agent they created. Everyone else views the capabilities read-only.
 * Authorization itself stays server-side — hiding the Save affordance is never
 * the boundary (invariant #4); this only decides what the editor renders as
 * editable.
 *
 * Unlike workspace governance (`workspace-permissions.ts`), the creator half is
 * NOT a role threshold — it is identity equality against THIS agent's
 * `created_by_user_id`, so editability is per selected agent, not panel-wide: a
 * member who created agent A edits A but still views agent B read-only.
 *
 * The creator branch carries the backend's `member(ws)` FLOOR: a creator who is
 * no longer a workspace member (viewerRole null) does NOT get edit — else a
 * removed creator's stale UI would show a Save that 403s. Since viewerRole is
 * null for both a non-member AND an unresolved query, that floor doubles as the
 * fail-closed guard.
 *
 * FAIL-CLOSED by construction: an unresolved `viewerRole` (query not settled →
 * null/undefined) is neither a governor nor a confirmed member, and an
 * unresolved `viewerUserId` (boot hydration not finished → null) never matches
 * a creator id, so the editor defaults to read-only and never flashes a Save it
 * then retracts.
 */
export function canEditAgentCapabilities(args: {
  viewerRole: WorkspaceRole | null | undefined;
  viewerUserId: string | null;
  agentCreatedByUserId: string;
}): boolean {
  // Governor: the admin threshold (owner outranks admin) — edits any agent.
  const isGovernor = args.viewerRole === 'owner' || args.viewerRole === 'admin';
  // Confirmed workspace member (the creator branch's floor). null = non-member
  // OR unresolved query → not a member → creator branch closed (fail-closed).
  const isMember = args.viewerRole != null;
  const isCreator =
    args.viewerUserId !== null && args.viewerUserId === args.agentCreatedByUserId;
  return isGovernor || (isMember && isCreator);
}
