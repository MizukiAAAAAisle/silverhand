/**
 * Graded-permissions Layer A — the human governance ROLE AXIS, as a pure rule.
 *
 * `owner` ⊇ `admin` ⊇ `member`. A higher role can do everything a lower one can;
 * callers pass the MINIMUM role an op requires. This axis is deliberately
 * separate from the agent capability axis: workspace roles never reference agent
 * capabilities and vice-versa (orthogonality, doc §6.3/§6.4).
 *
 * Why it lives here and not in `permissions.ts` (#task:1987). The rank is a
 * DOMAIN rule — it decides nothing about how a role is fetched — while
 * `permissions.ts` is the ctx/repo-backed gate surface. Keeping the two together
 * meant an in-lock revalidation could not reuse the rule without importing a
 * module that news up repos, so every recomputing writer either dragged
 * infrastructure into a driver-free service or restated the rank itself. One
 * rule, one home: the role axis is stated once and consulted by the pre-lock
 * gates (`canGovernWorkspace`) and the in-lock re-derivations alike.
 */
import type { WorkspaceRole } from '@silverhand/shared';

const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

/** Rank comparison on the human role axis, for the actor↔target questions the
 *  `minRole` floors cannot express. A missing role ranks below every real one. */
export function workspaceRoleOutranks(
  higher: WorkspaceRole | null,
  lower: WorkspaceRole | null,
): boolean {
  return roleRankOrNegative(higher) > roleRankOrNegative(lower);
}

/** The `minRole` FLOOR: does this role satisfy an op requiring `minRole`? */
export function workspaceRoleMeetsFloor(
  role: WorkspaceRole,
  minRole: WorkspaceRole,
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * The governance predicate itself: may the holder of this role write the things
 * `canGovernWorkspace(…, 'admin')` guards?
 *
 * Stated once so the pre-lock route gates and the in-lock re-derivations cannot
 * drift: a `null` role is not workspace membership either, so it fails this and
 * every floor built on it.
 */
export function roleGovernsWorkspace(role: WorkspaceRole | null): boolean {
  return role !== null && workspaceRoleOutranks(role, 'member');
}

function roleRankOrNegative(role: WorkspaceRole | null): number {
  return role === null ? -1 : ROLE_RANK[role];
}
