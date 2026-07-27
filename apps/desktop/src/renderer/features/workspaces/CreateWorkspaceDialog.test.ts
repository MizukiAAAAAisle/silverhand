/**
 * #task:1600 — cross-computer membership falsifiers for the create-workspace
 * dialog: the storage computer decides ONLY the workspace's home root. It
 * must never filter agent candidates and never prune a selection (the old
 * `eligibleAgents` host filter + prune effect were the desktop-side entry
 * gate; they are gone with the backend gates).
 *
 * The pool handed to this helper is the viewer's OWN agents — narrowed by
 * `useAgents({ scope: 'owned' })` at the call site (#task:1681), not here.
 */
import { describe, expect, it } from 'vitest';
import type { AgentDto } from '@silverhand/shared';
import { computeWorkspaceAgentCandidates } from './CreateWorkspaceDialog';

function agent(id: string, hostId: string): AgentDto {
  return { id, name: id, runtime: 'claude', host_id: hostId } as AgentDto;
}

describe('computeWorkspaceAgentCandidates (#task:1600)', () => {
  it('keeps agents from EVERY computer as candidates — no host filtering', () => {
    const agents = [
      agent('a-local', 'host-local'),
      agent('a-guest-1', 'host-other-1'),
      agent('a-guest-2', 'host-other-2'),
    ];
    expect(computeWorkspaceAgentCandidates(agents)).toEqual(agents);
  });

  it('takes no host argument at all — the storage computer cannot influence candidates', () => {
    // A regression re-adding host-based filtering would need a host
    // parameter back; the arity pin makes that a loud change.
    expect(computeWorkspaceAgentCandidates.length).toBe(1);
  });
});
