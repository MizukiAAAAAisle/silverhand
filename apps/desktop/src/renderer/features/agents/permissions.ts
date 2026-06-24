import type { AgentDto, MeResponse, WorkspaceRole } from '@silverhand/shared';
import { isRegistrationRequired } from '@/features/me/hooks';

/**
 * Renderer-side mirror of `canEditAgent` (creator branch only).
 *
 * The canonical authority is the backend predicate at
 * `packages/backend/src/permissions.ts::canEditAgent`. PR-1 made it
 * the source of truth for `PATCH /api/agents/:id` and PR-2 reused it
 * for the avatar routes; backend always returns 403 when the gate
 * fails. This helper is a *hint* used to drive UI affordances —
 * hide the editor for non-creators, swap to a read-only summary,
 * skip the "Edit profile" link in `AgentInfoPopover` — so the user
 * doesn't click a button that would just toast a 403 back at them.
 *
 * Why we model only the creator branch (and not the agent-self or
 * system branches the backend predicate also has):
 *
 * - The renderer principal is always a registered human viewer
 *   (or the unregistered/null pre-registration state). Agent-self
 *   principals only exist server-side, on internal agent token
 *   routes; they never reach this code path. Surfacing an
 *   "agent self can edit" affordance would lie about what PR-2
 *   actually shipped (avatar self-edit only, no profile field
 *   self-edit) — Cindy's PR-2/PR-3 scope guardrail.
 * - The system branch is server-only by definition.
 *
 * Tri-state input semantics:
 *
 * - `viewer = undefined` — the `/api/me` query hasn't resolved yet;
 *   render conservatively (read-only). Once the query lands a real
 *   `UserDto`, the helper re-evaluates and the editor unlocks if
 *   the viewer is the creator.
 * - `viewer` = `RegistrationRequired` — pre-registration shell;
 *   no editing permitted (the registration gate covers the whole
 *   app, but we still default-deny).
 * - `viewer` = `UserDto` — compare `viewer.id` against
 *   `agent.created_by_user_id`.
 *
 * Backend 403 remains the real gate: if `created_by_user_id` is
 * stale (manual DB edit, future re-assignment flow), the PATCH
 * still rejects. The UI's job is to avoid offering controls that
 * are guaranteed to fail.
 */
export function canEditAgentProfile(
  viewer: MeResponse | undefined,
  agent: Pick<AgentDto, 'created_by_user_id'>,
): boolean {
  if (!viewer) return false;
  if (isRegistrationRequired(viewer)) return false;
  return viewer.id === agent.created_by_user_id;
}

/**
 * Human-facing schedule management for `/api/agents/:id/schedules` is gated
 * by the same backend `canEditAgent` predicate as profile editing. Keep this
 * as a named alias so schedules don't accidentally look like a profile-only
 * policy, and so a future read-only schedule surface has a single call site to
 * split from the owner-only management gate.
 */
export function canManageAgentSchedules(
  viewer: MeResponse | undefined,
  agent: Pick<AgentDto, 'created_by_user_id'>,
): boolean {
  return canEditAgentProfile(viewer, agent);
}

/**
 * Agent workspace files (L1 agent-home `system_prompt.md` / `MEMORY.md` /
 * `notes/`, and L2 workspace-scoped memory) are owner-private (shiki
 * 2026-06-24): the agent's persistent identity + memory are at least as
 * sensitive as its raw MCP config / schedules, which are already owner-gated.
 *
 * The canonical authority is the backend owner gate (`canViewAgentFiles` =
 * `canEditAgent`) on `/api/agents/:id/workspace/{tree,file}` — it returns
 * 403/404 for non-owners (#task:1219). This renderer mirror exists so a
 * non-owner is shown a neutral private state and the doomed tree/file requests
 * are never fired (mirror-the-gate). A named alias rather than an inline
 * `canEditAgentProfile` call so a future explicit per-(agent, workspace) L2
 * share grant has a single call site to widen.
 */
export function canViewAgentFiles(
  viewer: MeResponse | undefined,
  agent: Pick<AgentDto, 'created_by_user_id'>,
): boolean {
  return canEditAgentProfile(viewer, agent);
}

/**
 * Renderer-side mirror of the backend remove-from-conversation gate
 * (#task:957). The canonical authority is the backend route
 * `DELETE /api/conversations/:id/members/agents/:agentId`, which enforces
 * `canEditAgent(targetAgent) || canGovernWorkspace(ws, 'admin')` and
 * returns 403 otherwise. This helper only decides whether the UI surfaces
 * the "remove from channel" control, so the viewer is never offered a
 * button guaranteed to 403.
 *
 * Permission (shiki 2026-06-09, plan A): the agent's owner (creator) OR a
 * workspace owner/admin may remove it from a conversation. "channel owner"
 * is intentionally NOT a concept — conversations carry no human-owner
 * column, so there is no per-channel ownership to honor; channel-member
 * governance rides the workspace role, matching the add-member route.
 *
 * `viewerWorkspaceRole` is the viewer's role in the conversation's
 * workspace (`useWorkspaceMemberLists(ws).viewerRole`). It is
 * `null` / `undefined` while it resolves (or for non-members), in which
 * case only the creator branch grants the control — the wider owner/admin
 * affordance appears once the role lands.
 */
export function canRemoveAgentFromChannel(
  viewer: MeResponse | undefined,
  agent: Pick<AgentDto, 'created_by_user_id'>,
  viewerWorkspaceRole: WorkspaceRole | null | undefined,
): boolean {
  if (!viewer) return false;
  if (isRegistrationRequired(viewer)) return false;
  if (viewer.id === agent.created_by_user_id) return true;
  return viewerWorkspaceRole === 'owner' || viewerWorkspaceRole === 'admin';
}
