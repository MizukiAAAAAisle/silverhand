import type { BackendContext } from '../context.js';
import {
  dispatchAgentL2Seed,
  dispatchWorkspaceProvision,
  resolveOutboundForHost,
  type DataPlaneFailure,
} from '../runtime/workspace-data-plane.js';

/**
 * D4.e-3 — seed a member agent's L2 (per-workspace) memory on the AGENT's
 * computer (`hostId` = `agent.host_id`, #task:1600: L2 lives where the agent
 * runs — the workspace's LOCAL REALIZATION on that computer, which is not
 * necessarily the workspace's home computer), via the daemon
 * (`agent_l2_seed`). Shared by create-with-members and the member-add use
 * case. The daemon is the sole authority for the host-local L2 path (I1):
 * the backend forwards only `workspace_id` / `agent_id` and never writes
 * the L2 itself.
 *
 * Returns `{ kind: 'ok' }` on success, or a fail-closed {@link DataPlaneFailure}.
 * Cindy ordering red line (spec §2.1): the CALLER must NOT insert the
 * `workspace_members` row when this fails — no "member added but L2 not
 * seeded" half-state. A crash AFTER seed but BEFORE the row leaves only a
 * benign orphan L2 dir (idempotent, reused on retry).
 *
 * `guestRealization` (#task:1612) marks the ONE remaining provision entry
 * point besides workspace creation: a GUEST agent joining a workspace on
 * another computer first establishes a pathless local realization on ITS
 * computer (the daemon self-picks the managed root — no path parameter
 * exists on this flow, sealing the retired legacy DB-path rebind at the
 * type level), then seeds. A same-host member never provisions here: the
 * workspace was realized at creation, and a missing registry binding is a
 * data inconsistency the seed surfaces as its typed
 * `workspace_not_provisioned` — never healed by minting a fresh root.
 */
export async function seedMemberAgentL2(
  ctx: BackendContext,
  hostId: string,
  workspaceId: string,
  agentId: string,
  opts: { guestRealization: boolean },
): Promise<{ kind: 'ok' } | DataPlaneFailure> {
  const outbound = resolveOutboundForHost(
    ctx.outboundFrameAdapter?.() ?? null,
    hostId,
  );
  if (outbound.kind === 'failed') return outbound;
  if (opts.guestRealization) {
    const provision = await dispatchWorkspaceProvision(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      { workspace_id: workspaceId, kind: 'regular' },
    );
    if (provision.kind === 'failed') return provision;
  }
  const seed = await dispatchAgentL2Seed(
    outbound.adapter,
    hostId,
    outbound.connectionId,
    { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
  );
  if (seed.kind === 'failed') return seed;
  return { kind: 'ok' };
}
