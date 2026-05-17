import type { AgentDto, MeResponse } from '@silverhand/shared';
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
