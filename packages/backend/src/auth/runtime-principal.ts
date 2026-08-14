export interface RuntimeCustody {
  readonly generation: number;
  readonly daemonInstanceId: string;
}

/**
 * Bearer identity for one live runtime custody generation.
 *
 * Scope identity and custody are deliberately separate. A conversation slot
 * must carry its conversation coordinate because the same agent can have many
 * conversation slots at the same generation; an agent slot intentionally has
 * no ambient conversation and is authorized against a request target later.
 */
export type RuntimePrincipal =
  | {
      readonly kind: 'conversation_slot';
      readonly conversationId: string;
      readonly agentId: string;
      readonly custody: RuntimeCustody;
    }
  | {
      readonly kind: 'agent_slot';
      readonly agentId: string;
      readonly custody: RuntimeCustody;
    };

export type ConversationRuntimePrincipal = Extract<
  RuntimePrincipal,
  { kind: 'conversation_slot' }
>;
export type AgentRuntimePrincipal = Extract<
  RuntimePrincipal,
  { kind: 'agent_slot' }
>;

export type RuntimePrincipalScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'conversation'; conversationId: string; agentId: string };

export function runtimePrincipalScope(
  principal: RuntimePrincipal,
): RuntimePrincipalScope {
  return principal.kind === 'agent_slot'
    ? { kind: 'agent', agentId: principal.agentId }
    : {
        kind: 'conversation',
        conversationId: principal.conversationId,
        agentId: principal.agentId,
      };
}

export function runtimePrincipalKey(principal: RuntimePrincipal): string {
  const scope = principal.kind === 'agent_slot'
    ? `agent:${principal.agentId}`
    : `conversation:${principal.conversationId}:${principal.agentId}`;
  return `${scope}:${principal.custody.generation}:${principal.custody.daemonInstanceId}`;
}

export function copyRuntimePrincipal(principal: RuntimePrincipal): RuntimePrincipal {
  return principal.kind === 'agent_slot'
    ? agentRuntimePrincipal({
        agentId: principal.agentId,
        generation: principal.custody.generation,
        daemonInstanceId: principal.custody.daemonInstanceId,
      })
    : conversationRuntimePrincipal({
        conversationId: principal.conversationId,
        agentId: principal.agentId,
        generation: principal.custody.generation,
        daemonInstanceId: principal.custody.daemonInstanceId,
      });
}

export function conversationRuntimePrincipal(input: {
  conversationId: string;
  agentId: string;
  generation: number;
  daemonInstanceId: string;
}): ConversationRuntimePrincipal {
  return {
    kind: 'conversation_slot',
    conversationId: input.conversationId,
    agentId: input.agentId,
    custody: {
      generation: input.generation,
      daemonInstanceId: input.daemonInstanceId,
    },
  };
}

export function agentRuntimePrincipal(input: {
  agentId: string;
  generation: number;
  daemonInstanceId: string;
}): AgentRuntimePrincipal {
  return {
    kind: 'agent_slot',
    agentId: input.agentId,
    custody: {
      generation: input.generation,
      daemonInstanceId: input.daemonInstanceId,
    },
  };
}

export function runtimePrincipalForScope(input: {
  scope: RuntimePrincipalScope;
  generation: number;
  daemonInstanceId: string;
}): RuntimePrincipal {
  return input.scope.kind === 'agent'
    ? agentRuntimePrincipal({
        agentId: input.scope.agentId,
        generation: input.generation,
        daemonInstanceId: input.daemonInstanceId,
      })
    : conversationRuntimePrincipal({
        conversationId: input.scope.conversationId,
        agentId: input.scope.agentId,
        generation: input.generation,
        daemonInstanceId: input.daemonInstanceId,
      });
}
