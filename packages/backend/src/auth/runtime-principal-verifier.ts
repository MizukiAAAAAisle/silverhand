import type { AgentTokenStore } from './agent-token-store.js';
import type { RuntimePrincipal } from './runtime-principal.js';

export type RuntimePrincipalDenial =
  | 'missing'
  | 'unknown'
  | 'revoked'
  | 'agent_mismatch'
  | 'custody_stale';

export type RuntimePrincipalVerifyResult =
  | {
      ok: true;
      principal: RuntimePrincipal;
    }
  | { ok: false; reason: RuntimePrincipalDenial };

export interface RuntimeCustodyReadPort {
  getConversation(
    conversationId: string,
    agentId: string,
  ): {
    generation: number;
    claimed_by_daemon_instance_id: string | null;
  } | null;
  getAgent(agentId: string): {
    generation: number;
    claimed_by_daemon_instance_id: string | null;
  } | null;
}

/**
 * The single runtime bearer + live-custody authority.
 *
 * A runtime bearer authenticates the executing agent and the exact live slot;
 * it does not carry a destination. Address resolution, participation, and the
 * C″ per-operation reach policy run after this boundary.
 */
export class RuntimePrincipalVerifier {
  constructor(
    private readonly tokens: AgentTokenStore,
    private readonly slots: RuntimeCustodyReadPort,
  ) {}

  verify(input: {
    token: string | null | undefined;
    routeAgentId: string;
  }): RuntimePrincipalVerifyResult {
    const bearer = this.tokens.verify(input.token);
    if (!bearer.ok) return bearer;
    const principal = bearer.principal;
    if (principal.agentId !== input.routeAgentId) {
      return { ok: false, reason: 'agent_mismatch' };
    }

    const slot = principal.kind === 'agent_slot'
      ? this.slots.getAgent(principal.agentId)
      : this.slots.getConversation(
          principal.conversationId,
          principal.agentId,
        );
    if (
      !slot
      || slot.generation !== principal.custody.generation
      || slot.claimed_by_daemon_instance_id
        !== principal.custody.daemonInstanceId
    ) {
      return { ok: false, reason: 'custody_stale' };
    }

    return { ok: true, principal };
  }
}
