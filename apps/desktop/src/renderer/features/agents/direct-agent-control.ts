import type { AgentAvailability, AgentDto, AgentRuntimeStateDto, DirectPairListItem, MeResponse } from '@silverhand/shared';
import { canEditAgentProfile } from './permissions';

/** The viewer-owned pair list proves endpoint membership; runtime readability does not. */
export function canControlDirectAgent(
  viewer: MeResponse | undefined,
  agent: Pick<AgentDto, 'id' | 'created_by_user_id' | 'session_scope'>,
  pair: DirectPairListItem | undefined,
): boolean {
  return canEditAgentProfile(viewer, agent)
    && agent.session_scope === 'agent'
    && !!pair && !pair.read_only
    && pair.counterpart.status === 'active'
    && pair.counterpart.kind === 'agent'
    && pair.counterpart.id === agent.id;
}

export function directAgentControlState(runtime: AgentRuntimeStateDto | undefined, availability: AgentAvailability | 'unknown') {
  const seat = runtime?.seats.find(seat => seat.scope.kind === 'agent');
  return {
    ready: runtime !== undefined && availability === 'online',
    startable: !seat || seat.status === 'idle' || seat.status === 'crashed',
    stoppable: !!seat && seat.status !== 'idle',
  };
}
