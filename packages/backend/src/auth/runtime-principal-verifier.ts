import type { AgentTokenStore } from './agent-token-store.js';
import type { RuntimePrincipal } from './runtime-principal.js';

export type RuntimePrincipalDenial =
  | 'missing'
  | 'unknown'
  | 'revoked'
  | 'agent_mismatch'
  | 'custody_stale'
  | 'target_unauthorized';

export type RuntimePrincipalVerifyResult =
  | {
      ok: true;
      principal: RuntimePrincipal;
      targetConversationId: string;
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

export interface RuntimeTargetParticipantPort {
  isAgentParticipant(
    conversationId: string,
    agentId: string,
  ): boolean;
}

/**
 * The single runtime bearer + live-custody + target-policy authority.
 * Unknown and unauthorized targets intentionally collapse to one denial.
 */
export class RuntimePrincipalVerifier {
  constructor(
    private readonly tokens: AgentTokenStore,
    private readonly slots: RuntimeCustodyReadPort,
    private readonly participants: RuntimeTargetParticipantPort,
  ) {}

  verify(input: {
    token: string | null | undefined;
    routeAgentId: string;
    targetConversationId: string;
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

    if (
      principal.kind === 'conversation_slot'
      && principal.conversationId !== input.targetConversationId
    ) {
      return { ok: false, reason: 'target_unauthorized' };
    }
    if (
      !this.participants.isAgentParticipant(
        input.targetConversationId,
        principal.agentId,
      )
    ) {
      return { ok: false, reason: 'target_unauthorized' };
    }

    return {
      ok: true,
      principal,
      targetConversationId: input.targetConversationId,
    };
  }
}
