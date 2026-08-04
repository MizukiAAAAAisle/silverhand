import type { BackendContext } from '../context.js';
import type { WorkspaceMemberDto } from '@silverhand/shared';
import type { Principal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';
import { canEnrollAgent } from '../permissions.js';

/**
 * Add an agent as a member of a regular workspace
 * (`docs/use-case-layer-p0-spec.md` §4 — the load-bearing target).
 *
 * Owns the cross-context orchestration that previously leaked into the route
 * AND sank into `WorkspaceRepo.addMember`:
 *
 *  - enrollment authority (#task:1681) is an agent-ownership rule, not a
 *    workspace-roster rule: only the agent's creator may place it. It lives
 *    here because this use case is the ONLY writer of agent workspace
 *    membership on the request paths, so both doors (workspace member-add and
 *    the conversation member-add auto-provision) inherit the gate.
 *  - the unit-of-work is explicit and visible here: one `db.transaction`
 *    wraps the pure `insertMembership` persistence fact and the capability
 *    default-seed POLICY decision. `seedDefaults` runs only when the row was
 *    genuinely created (`created`), preserving cut2's no-silent-re-widen and
 *    "a member always has a cap set" invariants.
 *
 * relocation-v1 §7 task 4 — provisioning collapse: adding a member is now a
 * PURE DB write. There is no placement precondition (a workspace is not rooted
 * on a computer, so any agent on any computer may join) and L2 memory is NO
 * LONGER seeded here (the former pre-commit "seed-before-row" red line is
 * gone): each member's L2 is materialized lazily at that member's first spawn
 * by the `AgentL2SeedEnsurer`, against the deterministic agent-centric bundle
 * coordinate. A member added but never spawned is a legal no-dir/no-L2 state; a
 * guest member (on another computer) gets nothing on their daemon until first
 * spawn — no eager guest realization, no `workspace_provision` on this path.
 *
 * `WorkspaceRepo` no longer references `AgentCapabilityRepo` or placement —
 * the policy lives in this application layer, the repo stays pure persistence.
 */
export type AddWorkspaceAgentMemberError =
  | { code: 'agent_not_found' }
  | { code: 'agent_not_owned' };

export type AddWorkspaceAgentMemberResult =
  | { ok: true; member: WorkspaceMemberDto }
  | { ok: false; error: AddWorkspaceAgentMemberError };

export async function addWorkspaceAgentMember(
  deps: {
    ctx: BackendContext;
    agents: AgentRepo;
    workspaces: WorkspaceRepo;
  },
  input: {
    /**
     * WHO is enrolling. This use case is the single writer of agent workspace
     * membership for both public doors (workspace member-add and the
     * conversation member-add auto-provision), so the ownership gate below has
     * to live here — a route-level check would leave the other door open.
     */
    principal: Principal;
    workspace: { id: string };
    agentId: string;
  },
): Promise<AddWorkspaceAgentMemberResult> {
  const { ctx, agents, workspaces } = deps;
  const agent = agents.get(input.agentId);
  if (!agent) return { ok: false, error: { code: 'agent_not_found' } };

  // ⓪ pre-commit: enrollment authority (#task:1681). The caller's workspace-admin
  // role is checked by the caller; what it does NOT grant is the right to place
  // SOMEONE ELSE's agent. `canEnrollAgent` = the agent's creator (or system).
  //
  // This gate is the authorization boundary, not the candidate dropdown: the
  // renderer narrows its list to `/api/agents?scope=owned`, but a hand-rolled
  // request carrying a teammate's agent id must be refused here (CLAUDE.md
  // invariant #4 — hiding an option is not a boundary). A co-membership-visible
  // agent is the exact population this rejects: it is legitimately readable and
  // still not enrollable.
  //
  // The distinct code (vs. folding into `agent_not_found`) is deliberate: the
  // 403 is what lets the surface state the actual rule — invite the human, and
  // they bring their own agents. It reveals only that the id exists, to a caller
  // who is already a workspace admin and must have obtained the opaque id
  // somewhere; no agent attribute is disclosed.
  if (!canEnrollAgent(ctx, input.principal, agent.id)) {
    return { ok: false, error: { code: 'agent_not_owned' } };
  }

  // #task:1600 / relocation-v1 §7 task 4 — adding a member is a PURE DB write:
  // an agent on any computer may join, and L2 memory is materialized lazily at
  // the member's first spawn (`AgentL2SeedEnsurer`), not eagerly here. There is
  // no daemon dispatch, no guest realization, and no "seed-before-row" ordering
  // precondition; a member added but never spawned is a legal no-dir/no-L2
  // state.

  // ① in-tx: explicit unit-of-work. Pure persistence + capability policy in
  // one transaction so a member always has a cap set, and the no-silent
  // re-widen rule holds (seed only when the row was genuinely created).
  const member = ctx.db.transaction(() => {
    const inserted = workspaces.insertMembership(input.workspace.id, agent.id);
    if (inserted.created) {
      new AgentCapabilityRepo(ctx.db).seedDefaults(input.workspace.id, agent.id);
    }
    return inserted.member;
  })();

  // This path emits no post-commit event today; keep it that way (spec §4 —
  // no new outward side-effect this cut).
  return { ok: true, member };
}
