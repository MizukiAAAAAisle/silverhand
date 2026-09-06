import { describe, expect, it } from 'vitest';
import { AgentStreamActivityListResponseSchema, apiPaths } from '../src/api/index.js';
import { agentActivityScope, parseAgentActivityScope } from '../src/ws-frames.js';

describe('agent activity stream read contract', () => {
  it('has an agent identity independent of conversation focus', () => {
    expect(apiPaths.agentActivity('agent/one')).toBe('/api/agents/agent%2Fone/activity');
    expect(parseAgentActivityScope(agentActivityScope('agent-one'))).toBe('agent-one');
    expect(parseAgentActivityScope('conversation-side:agent-one')).toBeNull();
    expect(parseAgentActivityScope('agent:')).toBeNull();
    const page = { agent_id: 'agent-one', runtime_scope: 'agent', events: [{ id: 12, agent_id: 'agent-one', kind: 'tool_output', payload: { output: { content: 'result' } }, created_at: 4 }], next_before_id: null };
    expect(AgentStreamActivityListResponseSchema.parse(page)).toEqual(page);
    expect(AgentStreamActivityListResponseSchema.safeParse({ ...page, runtime_scope: 'conversation' }).success).toBe(false);
  });
});
