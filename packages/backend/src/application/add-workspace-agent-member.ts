import type { BackendContext } from '../context.js';
import type { WorkspaceMemberDto } from '@silverhand/shared';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';
import type { DataPlaneFailure } from '../runtime/workspace-data-plane.js';
import { seedMemberAgentL2 } from './agent-l2-seed.js';

/**
 * Add an agent as a member of a regular workspace
 * (`docs/use-case-layer-p0-spec.md` §4 — the load-bearing target).
 *
 * Owns the cross-context orchestration that previously leaked into the route
 * AND sank into `WorkspaceRepo.addMember`:
 *
 *  - host/placement is a workspace-placement policy, not a table-level
 *    persistence precondition (spec §4, constraint ②): asserted here as a
 *    pre-commit precondition via `ctx.placement`, NOT inside the repo.
 *  - L2 seed is a pre-commit external precondition (spec §2.1): it must
 *    succeed BEFORE the membership row is written, so a crash leaves only a
 *    benign orphan L2 dir, never a "member without L2" half-state.
 *  - the unit-of-work is explicit and visible here: one `db.transaction`
 *    wraps the pure `insertMembership` persistence fact and the capability
 *    default-seed POLICY decision. `seedDefaults` runs only when the row was
 *    genuinely created (`created`), preserving cut2's no-silent-re-widen and
 *    "a member always has a cap set" invariants.
 *
 * `WorkspaceRepo` no longer references `AgentCapabilityRepo` or placement —
 * the policy lives in this application layer, the repo stays pure persistence.
 */
export type AddWorkspaceAgentMemberError =
  | { code: 'agent_not_found' }
  | { code: 'seed_failed'; failure: DataPlaneFailure };

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
    workspace: { id: string; workspace_path: string; workspace_host_id: string };
    agentId: string;
  },
): Promise<AddWorkspaceAgentMemberResult> {
  const { ctx, agents, workspaces } = deps;
  const agent = agents.get(input.agentId);
  if (!agent) return { ok: false, error: { code: 'agent_not_found' } };

  // #task:1600 final piece — the cross-computer PRODUCT ENTRY GATE is
  // lifted: an agent on any computer may join. The internal paths were
  // already reclassified to per-agent host axes (perimeter, fanout,
  // list-workspaces, delete), the agent `computer=` header + prompt
  // behavior contract ship in the same tree, and the seed below plans
  // its ensure row by the agent's own computer, so no host-equality
  // precondition remains.

  // ② pre-commit: L2 seed must succeed before we write the row (spec §2.1).
  // Cross-computer slice 2 (#task:1600): the seed targets the AGENT's own
  // daemon (`agent.host_id`) — L2 memory lives on the computer the agent
  // runs on. #task:1612: a GUEST member (agent on another computer than
  // the workspace's home) first establishes a pathless local realization
  // on its computer; a same-host member seeds directly — the workspace was
  // realized at creation, and a missing binding fails closed via the
  // seed's typed workspace_not_provisioned (no path ever crosses
  // machines, no DB-path recovery exists).
  const seed = await seedMemberAgentL2(
    ctx,
    agent.host_id,
    input.workspace.id,
    agent.id,
    { guestRealization: input.workspace.workspace_host_id !== agent.host_id },
  );
  if (seed.kind === 'failed') {
    return { ok: false, error: { code: 'seed_failed', failure: seed } };
  }

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
