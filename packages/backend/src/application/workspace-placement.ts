import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';

/**
 * D4.c C3 — preflight that rejects any workspace-level mutation (PATCH metadata,
 * DELETE) when one of the workspace's existing agent-backed conversations carries
 * an agent that no longer matches `expectedHostId`. Throws the placement layer's
 * `host_mismatch` error (typed 409 via `placementErrorResponse`) BEFORE the route
 * runs any side effect — metadata write, rename system message insert, runtime
 * stop, attachment sweep, or workspaces.delete.
 *
 * Coverage MUST match the downstream side-effect loop. DELETE iterates
 * `conversations.list().filter(workspace_id === id)` which scans EVERY
 * conversation kind (channel, dm_channel, thread). The preflight does the same —
 * using `conversations.listAllChannelsForWorkspace` (channels only) would
 * silently miss a cross-host agent attached to a thread or dm_channel and let
 * DELETE walk the runtime stop / sweep / delete path on a workspace that should
 * fail-closed (Cindy round-1 P1).
 *
 * NOTE: This is a control-plane placement check. As of D4.e-5 the backend carries
 * NO agent-host filesystem code at all — workspace skeleton, L1 materialization,
 * and L2 seeding are all daemon-mediated (`workspace_provision` /
 * `agent_materialize` / `agent_l2_seed`), and the old `initWorkspaceDir` /
 * `ensureAgentL1Dir` / `seedAgentL2` helpers were removed (invariant I6). The
 * fail-closed contract here is "rejected path leaks no fs / DB / message side
 * effect", which is true because the call sits before every write.
 *
 * Relocated verbatim from the routes.ts-local closure (P13a) into a neutral leaf
 * so PATCH `/api/workspaces/:id` (still in routes.ts) and the `deleteWorkspace`
 * use case share a single definition with no use-case→routes.ts back-edge.
 */
export function assertWorkspaceAgentsMatchHost(
  deps: { ctx: BackendContext; conversations: ConversationRepo },
  workspaceId: string,
  expectedHostId: string,
): void {
  const { ctx, conversations } = deps;
  const workspaceConversations = conversations
    .list()
    .filter(conversation => conversation.workspace_id === workspaceId);
  for (const conversation of workspaceConversations) {
    for (const ca of conversations.listAgents(conversation.id)) {
      ctx.placement.assertAgentMatchesHost(ca.agent_id, expectedHostId);
    }
  }
}
