import type { AgentDeleteImpactDto } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';

/**
 * Read-model for the agent delete-impact summary (#task:982 — P11a).
 *
 * Moved verbatim out of `routes.ts` so the GET `/api/agents/:id/delete-impact`
 * preview route and the `deleteAgent` use case call ONE function and can never
 * drift (the DELETE flow must sweep exactly what the preview promised). Pure
 * read — DB + filesystem-derived counts only, no mutation. The dependencies it
 * previously closed over in the route factory are now an explicit deps object.
 */
export interface DeleteImpactDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
}

/**
 * Build the AgentDeleteImpactDto from current DB + filesystem
 * state. Pure read — used both by the GET preview endpoint and by
 * the DELETE handler so the two stay in lock-step.
 */
export function computeDeleteImpact(
  deps: DeleteImpactDeps,
  agentId: string,
): AgentDeleteImpactDto {
  const { ctx, agents, workspaces, conversations, conversationInboxes } = deps;
  const agent = agents.get(agentId);
  if (!agent) throw new Error('agent not found'); // guarded by callers
  const ownedHome = workspaces.getAgentHomeByOwner(agentId);
  const regulars = workspaces
    .listForAgent(agentId)
    .filter(w => w.workspace_kind === 'regular');
  const dmChannels = ownedHome
    ? conversations.listAllDmChannelsForWorkspace(ownedHome.id)
    : conversations.listDmChannelsForAgent(agentId);
  const dm = dmChannels[0] ?? null;

  let dmChannel: AgentDeleteImpactDto['dm_channel'] = null;
  let attachmentsCount = 0;
  if (dm) {
    const rootIds = dmChannels.map(c => c.id);
    const ids = [...rootIds];
    const placeholders = ids.map(() => '?').join(',');
    const messageCount =
      ids.length === 0
        ? 0
        : ctx.db
            .prepare<string[], { c: number }>(
	                `SELECT COUNT(*) AS c
	                   FROM messages
	                  WHERE conversation_id IN (${placeholders})`,
	              )
            .get(...ids)?.c ?? 0;
    attachmentsCount =
      ctx.db
        .prepare<string[], { c: number }>(
          `SELECT COUNT(*) AS c
             FROM attachments
            WHERE channel_id IN (${rootIds.map(() => '?').join(',')})`,
        )
        .get(...rootIds)?.c ?? 0;
    dmChannel = {
      id: dm.id,
      name: dm.title,
      conversation_count: ids.length,
      message_count: messageCount,
    };
  }

  const runtimeConversations = agents.listRuntimeConversations(agentId);
  const running = runtimeConversations
    .filter(s => s.status === 'starting' || s.status === 'active')

  return {
    agent_id: agent.id,
    agent_name: agent.name,
    agent_display_name: agent.display_name,
    dm_channel: dmChannel,
    regular_workspaces: regulars.map(c => ({ id: c.id, name: c.name })),
    regular_memberships: regulars.map(c => ({ id: c.id, name: c.name })),
    // P1-2: explicitly map the owned-home window — NEVER spread the repo
    // WorkspaceDto, which carries `workspace_path` (a host-local path that
    // must not cross into the control-plane payload, I6).
    owned_home: ownedHome
      ? {
          id: ownedHome.id,
          name: ownedHome.name,
          workspace_kind: ownedHome.workspace_kind,
          owner_agent_id: ownedHome.owner_agent_id,
        }
      : null,
    attachments_count: attachmentsCount,
    running_conversation_agents: running,
    pending_inbox_count: conversationInboxes.countPendingForAgent(agentId),
  };
}
