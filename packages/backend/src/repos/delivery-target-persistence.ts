// Where the delivery-target resolver gets its FOUR authorities (#task:2021 P4-4).
//
// The CONCRETE side, and it lives here for that reason: it names repositories,
// so it belongs under `repos/` next to `observation-persistence.ts` rather than
// in `application/`, whose `*-ports.ts` modules are port DECLARATIONS and are
// gated driver-free across their whole import closure. The declarations this
// file fills are in `application/delivery-target-resolution.ts`.
//
// `delivery-target-resolution.ts` states the rules against ports and knows no
// repository; this module is the one place those ports are filled from the real
// persistence, so every P4 surface — send, history, search, file, schedule,
// member, task — resolves an address through the SAME lookups. A surface that
// assembled its own bag would be free to substitute a wider participation query
// or a workspace lookup that includes `agent_home`, and the resolver's rules
// would then mean something different per surface while still reading identically.
//
// EVERY MEMBER IS A NARROWING, not a pass-through of a repo. The ports were
// written as questions (`isAgentParticipant`, `findWorkspaceTitle`) precisely so
// the resolver cannot reach the rest of a repo's surface, and handing it the repo
// itself — which is structurally assignable, since `ConversationIdentity` is a
// supertype of `DeliveryTargetConversation` — would give that reach back for free.
// So each member is spelled out, even where a direct reference would compile.
//
// The workspace root is the exception, and deliberately: its adapter lives with
// its own authority in `workspace-address-resolution.ts`, because that authority
// owns the "ambiguous is not unresolved" distinction and its log line.
import type { BackendLogger } from '../context.js';
import type { AgentRepo } from './agent-repo.js';
import type { ConversationRepo } from './conversation-repo.js';
import type { MessageRepo } from './message-repo.js';
import type { UserRepo } from './user-repo.js';
import type { WorkspaceRepo } from './workspace-repo.js';
import { deliveryTargetObserver } from '../observability/delivery-target-log.js';
import type { DeliveryTargetPorts } from '../application/delivery-target-resolution.js';
import { deliveryTargetWorkspacesPort } from '../application/workspace-address-resolution.js';

export interface DeliveryTargetPortsDeps {
  agents: AgentRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  logger: BackendLogger;
}

/**
 * Assemble the resolver's ports from the composed persistence.
 *
 * Built PER REQUEST at each surface rather than once at composition time: the
 * bag is four closures over already-constructed repos, so it costs nothing, and
 * the alternative — a long-lived instance in the dependency bag — would have to
 * capture a logger that outlives the request it is reporting on.
 */
export function deliveryTargetPorts(
  deps: DeliveryTargetPortsDeps,
): DeliveryTargetPorts {
  const { agents, conversations, messages, users, workspaces, logger } = deps;
  return {
    conversations: {
      getIdentity: id => conversations.getIdentity(id),
      findWorkspaceTitle: (workspaceId, titleKey) =>
        conversations.findWorkspaceTitle(workspaceId, titleKey),
      isAgentParticipant: (conversationId, agentId) =>
        conversations.isAgentParticipant(conversationId, agentId),
      findDirectPair: (x, y) => conversations.findDirectPair(x, y),
      getOrCreateDirectPair: (x, y, now) =>
        conversations.getOrCreateDirectPair(x, y, now),
    },
    workspaces: deliveryTargetWorkspacesPort({ workspaces, logger }),
    messages: {
      getInConversation: (conversationId, messageId) =>
        messages.getInConversation(conversationId, messageId),
    },
    // Two registries, one namespace: v21's cross-namespace triggers make a handle
    // unique across `users.name` ⊕ `agents.name`, which is why the resolver may
    // try both and treat the FIRST hit as the answer rather than a tie-break.
    agents: { getByName: name => agents.getByName(name) },
    users: { getByName: name => users.getByName(name) },
    observer: deliveryTargetObserver(logger),
  };
}
