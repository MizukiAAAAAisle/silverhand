import type { BackendContext } from '../../context.js';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import type { MessageRepo } from '../../repos/message-repo.js';
import type { MessageReactionRepo } from '../../repos/message-reaction-repo.js';
import type { WorkspaceRepo } from '../../repos/workspace-repo.js';
import type { AgentReadModel } from '../../read-model/agent-read.js';

/**
 * Shared dependency bag for the internal-agent route facets. Repos are
 * constructed once in `createInternalRouter` and threaded to each
 * `register<Facet>Routes` so the composition root stays wiring-only and no
 * facet reconstructs a repo. Carries exactly what the facet handlers touch;
 * the membership sub-app's extra deps (`users`, `membership`) stay local to
 * the composition root that mounts it.
 */
export interface InternalRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  /** The agent-facing projections (history / channel list / search), handle
   *  bound at composition time (#task:1983 W2). */
  agentReads: AgentReadModel;
  conversations: ConversationRepo;
  messages: MessageRepo;
  reactions: MessageReactionRepo;
  workspaces: WorkspaceRepo;
}
