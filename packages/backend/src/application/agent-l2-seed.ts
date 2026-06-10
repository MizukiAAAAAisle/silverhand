import type { BackendContext } from '../context.js';
import {
  dispatchAgentL2Seed,
  resolveOutboundForHost,
  type DataPlaneFailure,
} from '../runtime/workspace-data-plane.js';

/**
 * D4.e-3 — seed a member agent's L2 (per-workspace) memory on the host that
 * owns `workspace`, via the daemon (`agent_l2_seed`). Shared by
 * create-with-members and the member-add use case. The daemon is the sole
 * authority for the host-local L2 path (I1): the backend forwards only
 * `workspace_id` / `agent_id` and never writes the L2 itself.
 *
 * Returns `{ kind: 'ok' }` on success, or a fail-closed {@link DataPlaneFailure}.
 * Cindy ordering red line (spec §2.1): the CALLER must NOT insert the
 * `workspace_members` row when this fails — no "member added but L2 not
 * seeded" half-state. A crash AFTER seed but BEFORE the row leaves only a
 * benign orphan L2 dir (idempotent, reused on retry).
 *
 * This is HTTP-agnostic by design (spec §1.1, Cindy review constraint ③) —
 * it lives outside `routes.ts` and returns a typed result so the use case can
 * import it without dragging in the Hono adapter; callers map the failure to
 * their own transport.
 *
 * `ensureProvisioned` controls the lazy registry backfill: the member-add
 * use case passes `true` (a pre-D4.e legacy workspace may have no registry
 * binding yet), while create-with-members passes `false` because the
 * workspace was already provisioned earlier in the SAME request — re-binding
 * it per member would be a redundant daemon round-trip.
 */
export async function seedMemberAgentL2(
  ctx: BackendContext,
  hostId: string,
  workspace: { id: string; workspace_path: string },
  agentId: string,
  opts: { ensureProvisioned: boolean },
): Promise<{ kind: 'ok' } | DataPlaneFailure> {
  // 1) Ensure the workspace is bound in the owning daemon's registry. Legacy
  //    rows are lazily re-provisioned here; the create-with-members path
  //    already provisioned in-request, so it skips this.
  if (opts.ensureProvisioned) {
    const backfill = await ctx.workspaceRegistryBackfiller?.ensure(hostId, [
      { id: workspace.id, workspace_path: workspace.workspace_path },
    ]);
    if (backfill && backfill.status === 'failed') {
      const f = backfill.failed[0];
      return {
        kind: 'failed',
        code: f?.code ?? 'host_attach_pending',
        message:
          f?.message ?? 'workspace registry backfill failed; cannot seed agent L2',
        status: f && !f.retriable ? 502 : 503,
        retriable: f?.retriable ?? true,
      };
    }
  }
  // 2) Seed L2 on the owning daemon (fail-closed; never a server-side write).
  const outbound = resolveOutboundForHost(
    ctx.outboundFrameAdapter?.() ?? null,
    hostId,
  );
  if (outbound.kind === 'failed') return outbound;
  const seed = await dispatchAgentL2Seed(
    outbound.adapter,
    hostId,
    outbound.connectionId,
    { agent_id: agentId, workspace_id: workspace.id, template_choice: 'default' },
  );
  if (seed.kind === 'failed') return seed;
  return { kind: 'ok' };
}
