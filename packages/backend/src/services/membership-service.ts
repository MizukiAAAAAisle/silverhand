import type { MemberDto } from '@silverhand/shared';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { UserRepo } from '../repos/user-repo.js';

/**
 * Resolves a conversation's full participant list (agents + humans) into
 * a single, render-ready `MemberDto[]` — the unified shape consumed by:
 *
 *   - `platform-prompt.ts` (the "Members in this conversation:" block;
 *     the prompt builder applies a `self: true` marker by comparing
 *     each member's `agent_id` against the spawning agent id),
 *   - PR-C's chat header chip strip (forthcoming).
 *
 * Single source of truth: any divergence between what the prompt sees
 * and what the chat header shows would surface as the agent talking
 * about people not in the chip strip (or vice versa). Keeping both
 * surfaces backed by `listMembers` makes that class of bug structural
 * to introduce.
 *
 * Order is deterministic and stable across invocations:
 *   1. agents first, then humans (separate sections so kind-based
 *      rendering doesn't have to scan the whole list);
 *   2. within each kind, joined-order ascending — the natural
 *      "this is who has been here longest" reading order.
 *
 * Membership rows whose agent / user does not exist (a deleted agent
 * still leaving a `conversation_agents` row, or a stale `users`
 * reference) are silently dropped: they are not renderable, and
 * surfacing a half-resolved row would be more confusing than omitting
 * it.
 *
 * Errors are not raised for "missing" — only for IO failures, which
 * propagate from the underlying repos. The system message participant
 * is implicit and never appears here; the prompt addresses system
 * messages separately.
 */
export class MembershipService {
  constructor(
    private readonly deps: {
      agents: AgentRepo;
      users: UserRepo;
      conversations: ConversationRepo;
    },
  ) {}

  listMembers(conversationId: string): MemberDto[] {
    const out: MemberDto[] = [];
    // Agents first, ordered by joined_at via ConversationRepo.listAgents.
    for (const ca of this.deps.conversations.listAgents(conversationId)) {
      const agent = this.deps.agents.get(ca.agent_id);
      if (!agent) continue;
      out.push({
        kind: 'agent',
        agent_id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        runtime: agent.runtime,
      });
    }
    // Humans next, ordered by joined_at via ConversationRepo.listUsers.
    for (const cu of this.deps.conversations.listUsers(conversationId)) {
      const user = this.deps.users.get(cu.user_id);
      if (!user) continue;
      out.push({
        kind: 'human',
        user_id: user.id,
        name: user.name,
        display_name: user.display_name,
      });
    }
    return out;
  }
}
