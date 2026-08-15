// "Does the principal a `direct_pair` endpoint names still exist?" — the one
// LOOKUP behind shared's `directPairIsReadOnlyForSurvivor`, composed here so both
// faces of that rule answer it identically (#task:2021 P4-4): the request-layer
// ACL through `AuthorizationReadPort`, and the send transaction through
// `MessageTxScope`.
//
// KIND-DIRECTED, and that is the whole content of it: the endpoint's `_kind` says
// which namespace its id belongs to, so asking the wrong table would report a
// live principal as gone — and, in the other direction, a `human` endpoint could
// be satisfied by an agent that happens to share the id. Written once because two
// copies of a two-arm dispatch is exactly the kind of duplication that survives
// review and then diverges when a third endpoint kind arrives.
//
// COLLAPSED TO A BOOLEAN. Neither caller may reach a deleted-or-not principal's
// other columns through this; the survivor's gate asks existence and nothing
// else.
import type { ConversationEndpointIdentity } from '@silverhand/shared';
import type { AgentRepo } from './agent-repo.js';
import type { UserRepo } from './user-repo.js';

export interface EndpointPrincipalPresenceDeps {
  readonly agents: AgentRepo;
  readonly users: UserRepo;
}

export function createEndpointPrincipalPresence(
  deps: EndpointPrincipalPresenceDeps,
): (endpoint: ConversationEndpointIdentity) => boolean {
  return endpoint =>
    endpoint.kind === 'agent'
      ? deps.agents.get(endpoint.id) !== null
      : deps.users.get(endpoint.id) !== null;
}
