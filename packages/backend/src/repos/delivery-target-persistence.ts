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
//
// TWO OF THE PORTS ARE EFFECTS, not lookups: the refusal `observer` and the
// `allocations` announcement. They are wired HERE for the same reason as the
// lookups — so that no surface can assemble a resolver that is missing one. A bag
// built anywhere else could hand the resolver a silent sink and a mint that
// nobody hears about (#task:2035 @Cindy B4), which is why the fence
// `guard-direct-pair-open-announced.test.ts` closes the set of files that may
// name the allocation port's member at all.
import type { BackendLogger } from '../context.js';
import type { AgentRepo } from './agent-repo.js';
import type { ConversationRepo } from './conversation-repo.js';
import type { MessageRepo } from './message-repo.js';
import type { UserRepo } from './user-repo.js';
import type { WorkspaceRepo } from './workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { conversationViewerUserIds } from '../viewer-scope.js';
import { deliveryTargetObserver } from '../observability/delivery-target-log.js';
import { directPairAllocationPort } from '../application/direct-pairs-changed.js';
import type { DeliveryTargetPorts } from '../application/delivery-target-resolution.js';
import type { OpenDirectPairPorts } from '../application/open-direct-pair.js';
import type { ConversationIdentity } from './conversation-repo.js';
import { deliveryTargetWorkspacesPort } from '../application/workspace-address-resolution.js';

export interface DeliveryTargetPortsDeps {
  agents: AgentRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  logger: BackendLogger;
  /** For the one allocating arm's announcement. Required, like `logger`: a
   *  resolver assembled without it could open a DM nobody's client hears about. */
  events: ScopeEventBus;
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
  const { agents, conversations, messages, users, workspaces, logger, events } = deps;
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
    // The announcement's audience is the PLACEMENT authority's human
    // participants, never `conversation_users` — for a `direct_pair` the roster
    // table is empty, which is the bug #task:2035 started as.
    allocations: directPairAllocationPort(events, conversationId =>
      conversationViewerUserIds(conversations, conversationId),
    ),
  };
}

export interface OpenDirectPairPortsDeps {
  conversations: ConversationRepo;
  /** For the mint's announcement — same requirement as the resolver's `events`. */
  events: ScopeEventBus;
}

/**
 * The mint's two ports, for the HUMAN door (#task:2036).
 *
 * The person pressing "Message" resolves no address — a human client posts where
 * the person is looking, so there is nothing for `resolveDeliveryTarget` to parse —
 * and therefore reaches the mint through {@link openDirectPair} directly rather
 * than through the full resolver. It gets exactly the two ports that operation
 * needs, assembled HERE for the same reason the resolver's whole bag is: so the
 * announcement's audience is the placement authority (`conversationViewerUserIds`),
 * never a roster read, and no route can assemble a mint that is missing the
 * announcement. This is deliberately NOT the whole `DeliveryTargetPorts` — the
 * human door does no address resolution, so handing it the lookups would be reach
 * it never uses.
 */
export function openDirectPairPorts(
  deps: OpenDirectPairPortsDeps,
): OpenDirectPairPorts<ConversationIdentity> {
  const { conversations, events } = deps;
  return {
    conversations: {
      getOrCreateDirectPair: (x, y, now) =>
        conversations.getOrCreateDirectPair(x, y, now),
    },
    allocations: directPairAllocationPort(events, conversationId =>
      conversationViewerUserIds(conversations, conversationId),
    ),
  };
}

