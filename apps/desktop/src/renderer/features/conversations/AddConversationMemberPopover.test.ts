/**
 * #task:1600 — cross-computer membership falsifiers for the add-member
 * picker: a governance viewer sees EVERY non-member agent from the global
 * directory, regardless of which computer it lives on (the old
 * `a.host_id === workspaceHostId` filter was the desktop-side entry gate;
 * it is gone with the backend gates). Non-governance viewers still see
 * only current workspace agents.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDto } from '@silverhand/shared';
import { computePickableAgents } from './AddConversationMemberPopover';

function agent(id: string, hostId: string): AgentDto {
  return { id, name: id, runtime: 'claude', host_id: hostId } as AgentDto;
}

describe('computePickableAgents (#task:1600)', () => {
  const wsAgents = [agent('member-1', 'host-home')];
  const globalAgents = [
    agent('member-1', 'host-home'), // already a member — deduped
    agent('ext-same-host', 'host-home'),
    agent('ext-guest-a', 'host-other-a'),
    agent('ext-guest-b', 'host-other-b'),
  ];

  it('admin view: every non-member agent is pickable across ALL computers — no host filter', () => {
    const pickable = computePickableAgents(true, wsAgents, globalAgents);
    expect(pickable.map(a => a.id)).toEqual([
      'member-1',
      'ext-same-host',
      'ext-guest-a',
      'ext-guest-b',
    ]);
  });

  it('only membership narrows the list — never the host axis', () => {
    const pickable = computePickableAgents(true, wsAgents, globalAgents);
    const hosts = new Set(pickable.map(a => a.host_id));
    expect(hosts.size).toBeGreaterThan(1);
    // No workspace-host argument exists to filter by.
    expect(computePickableAgents.length).toBe(3);
  });

  it('non-governance viewers still see only current workspace agents', () => {
    expect(computePickableAgents(false, wsAgents, globalAgents)).toEqual(
      wsAgents,
    );
  });
});
