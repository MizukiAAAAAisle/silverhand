import type {
  AgentDto,
  HostAgentResource,
  HostResourcesResponse,
} from '@silverhand/shared';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { AgentTeardownFacts } from '../application/agent-teardown-ports.js';

/**
 * Read-model for `GET /api/hosts/:id/resources` — what is persistently rooted on
 * one Computer.
 *
 * This is an ordinary Computer-domain query, NOT a delete preview. It answers
 * "which agents are placed here", and it carries resource facts only — no
 * `can_delete`, no "would-succeed" prediction. Deciding what the list means
 * belongs to the caller: the delete dialog reads it as the impact it must show
 * before asking for confirmation, and the DELETE route re-derives its own
 * authoritative set inside its transaction rather than trusting this projection
 * (#task:1617).
 *
 * relocation-v1 §7-4 / §6 — there is no workspace dimension here at all. A
 * `regular` workspace is not rooted on a computer: it has no home computer and
 * keeps no files here (each member agent's bundle lives on that agent's OWN
 * computer, at a deterministic agent-centric coordinate), so no workspace can be
 * reported as this computer's resource. The field, its repo dependency and the
 * principal parameter (the `viewer_role` source) are gone with the projection
 * they fed.
 *
 * Deliberately distinct from `GET /api/hosts/:id/status`, which reports the
 * DYNAMIC availability of the daemon and its live runtimes. Availability and
 * ownership answer different questions and must not be merged into one payload:
 * a lost computer reports every agent `offline` on `/status` while still OWNING
 * all of them here — and it is exactly that computer the delete flow is for.
 */
export interface HostResourcesDeps {
  agents: AgentRepo;
}

export function listHostResources(
  deps: HostResourcesDeps,
  hostId: string,
): HostResourcesResponse {
  const { agents } = deps;
  return {
    agents: agents.listByHost(hostId).map(toHostAgentResource),
  };
}

export function toHostAgentResource(agent: AgentDto): HostAgentResource {
  return {
    id: agent.id,
    name: agent.name,
    display_name: agent.display_name,
    runtime: agent.runtime,
  };
}

/**
 * The same wire projection, from the delete cascade's driver-free facts
 * (`application/agent-teardown-ports.ts`). Both spellings live HERE, next to the
 * response type they serve, so the `has_dependents` refusal in
 * `delete-computer.ts` cannot drift from `GET /api/hosts/:id/resources` — the
 * dialog compares the two lists.
 */
export function teardownFactsToHostAgentResource(
  agent: AgentTeardownFacts,
): HostAgentResource {
  return {
    id: agent.id,
    name: agent.name,
    display_name: agent.displayName,
    runtime: agent.runtime,
  };
}
