import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ConversationAgentDto } from '@silverhand/shared';
import {
  applyAgentStatusToCache,
  clearPendingAgentStatusPatches,
  mergePendingAgentStatusPatches,
  releaseAgentStatusBuffer,
  retainAgentStatusBuffer,
} from './hooks';

// #task:1255 Stage-2 P1c — the `agent_status` cache write + the in-flight patch
// buffer move out of `useChannelAgents.onEvent` into a module-level per-channel
// buffer written by the ingestor and drained by the hook's queryFn. P1 = prep:
// behavior preserved exactly (patch-in-place + replay-onto-snapshot + invalidate
// when the agent isn't a known row yet).

const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;

afterEach(() => {
  clearPendingAgentStatusPatches('c1');
  clearPendingAgentStatusPatches('c2');
});

describe('applyAgentStatusToCache', () => {
  it('patches a cached agent row in place', () => {
    const qc = new QueryClient();
    qc.setQueryData(agentsKey('c1'), [agent('a1', 'idle')]);

    applyAgentStatusToCache(qc, 'c1', { agent_id: 'a1', status: 'active' });

    const rows = qc.getQueryData<ConversationAgentDto[]>(agentsKey('c1'));
    expect(rows?.find(a => a.agent_id === 'a1')?.status).toBe('active');
  });

  it('buffers the patch so a concurrent snapshot replays it (live-before-merge)', () => {
    const qc = new QueryClient();
    // No cache yet — the snapshot GET is still in flight.
    applyAgentStatusToCache(qc, 'c1', { agent_id: 'a1', status: 'active' });

    // The snapshot returns the agent as `idle` (stale); the buffer replay must
    // win so the fresh snapshot doesn't clobber the newer live status.
    const merged = mergePendingAgentStatusPatches('c1', [agent('a1', 'idle')]);
    expect(merged.find(a => a.agent_id === 'a1')?.status).toBe('active');
  });
});

describe('pending agent-status buffer — channel isolation / clear', () => {
  it('does not leak a c1 patch into c2 merge', () => {
    const qc = new QueryClient();
    applyAgentStatusToCache(qc, 'c1', { agent_id: 'a1', status: 'active' });

    const merged = mergePendingAgentStatusPatches('c2', [agent('a1', 'idle')]);
    expect(merged.find(a => a.agent_id === 'a1')?.status).toBe('idle');
  });

  it('clearing a channel drops its buffer (unmount hygiene)', () => {
    const qc = new QueryClient();
    applyAgentStatusToCache(qc, 'c1', { agent_id: 'a1', status: 'active' });
    clearPendingAgentStatusPatches('c1');

    const merged = mergePendingAgentStatusPatches('c1', [agent('a1', 'idle')]);
    expect(merged.find(a => a.agent_id === 'a1')?.status).toBe('idle');
  });

  it('keeps the buffer until the LAST reader leaves (multi-reader, P1c #1)', () => {
    const qc = new QueryClient();
    // Two readers for the same channel (e.g. ChannelView + an AgentInfoPopover).
    retainAgentStatusBuffer('c1');
    retainAgentStatusBuffer('c1');

    // A live patch lands while a snapshot GET is in flight.
    applyAgentStatusToCache(qc, 'c1', { agent_id: 'a1', status: 'active' });

    // One reader unmounts — the other is still alive, so the buffer must survive
    // and still win over a stale snapshot.
    releaseAgentStatusBuffer('c1');
    expect(
      mergePendingAgentStatusPatches('c1', [agent('a1', 'idle')]).find(
        a => a.agent_id === 'a1',
      )?.status,
    ).toBe('active');

    // The last reader leaves — now the buffer is cleared.
    releaseAgentStatusBuffer('c1');
    expect(
      mergePendingAgentStatusPatches('c1', [agent('a1', 'idle')]).find(
        a => a.agent_id === 'a1',
      )?.status,
    ).toBe('idle');
  });
});

function agent(
  agentId: string,
  status: ConversationAgentDto['status'],
): ConversationAgentDto {
  return {
    conversation_id: 'c1',
    agent_id: agentId,
    cli_session_id: null,
    pid: null,
    status,
    joined_at: 0,
  };
}
