import type { AgentRuntimeConversation, WorkspaceKind } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';

/**
 * Read-model for the agent delete impact summary (#task:982 — P11a).
 *
 * This is an INTERNAL delete orchestration read model, not a public API DTO.
 * The old GET `/api/agents/:id/delete-impact` preview endpoint was removed
 * when the product copy stopped surfacing detailed impact counts, but the
 * DELETE flow still needs one computed target set for stop / purge / teardown.
 * Pure read — DB-derived counts only, no mutation.
 */
export interface AgentDeleteImpact {
  agent_id: string;
  agent_name: string;
  agent_display_name: string;
  dm_channel: {
    id: string;
    name: string;
    conversation_count: number;
    message_count: number;
  } | null;
  regular_workspaces: Array<{ id: string; name: string }>;
  regular_memberships: Array<{ id: string; name: string }>;
  owned_home: {
    id: string;
    name: string;
    workspace_kind: WorkspaceKind;
    owner_agent_id: string | null;
  } | null;
  attachments_count: number;
  running_conversation_agents: AgentRuntimeConversation[];
  pending_inbox_count: number;
}

export interface DeleteImpactDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
}

/**
 * Build the delete target set from current DB state. Pure read — used by the
 * DELETE handler so stop / purge / teardown share one target set.
 */
export function computeDeleteImpact(
  deps: DeleteImpactDeps,
  agentId: string,
): AgentDeleteImpact {
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

  let dmChannel: AgentDeleteImpact['dm_channel'] = null;
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
