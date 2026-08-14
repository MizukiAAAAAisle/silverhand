import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import {
  agentRuntimePrincipal,
  conversationRuntimePrincipal,
} from '../../src/auth/runtime-principal.js';
import {
  RuntimePrincipalVerifier,
  type RuntimeCustodyReadPort,
  type RuntimeTargetParticipantPort,
} from '../../src/auth/runtime-principal-verifier.js';

function fixture() {
  const tokens = new AgentTokenStore();
  const conversationSlots = new Map<string, {
    generation: number;
    claimed_by_daemon_instance_id: string | null;
  }>();
  const agentSlots = new Map<string, {
    generation: number;
    claimed_by_daemon_instance_id: string | null;
  }>();
  const memberships = new Set<string>();
  const slots: RuntimeCustodyReadPort = {
    getConversation: (conversationId, agentId) =>
      conversationSlots.get(`${conversationId}|${agentId}`) ?? null,
    getAgent: agentId => agentSlots.get(agentId) ?? null,
  };
  const participantPort: RuntimeTargetParticipantPort = {
    isAgentParticipant: (conversationId, agentId) =>
      memberships.has(`${conversationId}|${agentId}`),
  };
  return {
    tokens,
    conversationSlots,
    agentSlots,
    memberships,
    verifier: new RuntimePrincipalVerifier(tokens, slots, participantPort),
  };
}

const BACKEND_SRC = fileURLToPath(new URL('../../src', import.meta.url));

function productionTypeScriptFiles(dir = BACKEND_SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? productionTypeScriptFiles(path)
      : entry.isFile() && path.endsWith('.ts')
        ? [path]
        : [];
  });
}

describe('RuntimePrincipalVerifier', () => {
  it('keeps the bearer store verifier unary so target coordinates cannot become a second auth API', () => {
    expect(AgentTokenStore.prototype.verify.length).toBe(1);
  });

  it('has one production bearer/custody/target verifier and no facet-local authority', () => {
    const files = productionTypeScriptFiles();
    const bearerVerifyCallers = files.filter(path =>
      /(?:agentTokens|tokens)\.verify\(/.test(readFileSync(path, 'utf8')),
    );
    expect(bearerVerifyCallers.map(path => relative(BACKEND_SRC, path))).toEqual([
      'auth/runtime-principal-verifier.ts',
    ]);

    const verifierConstructors = files.reduce(
      (count, path) =>
        count
        + (readFileSync(path, 'utf8').match(/new RuntimePrincipalVerifier\(/g)
          ?.length ?? 0),
      0,
    );
    expect(verifierConstructors).toBe(1);

    const facetAuthority = files
      .filter(path => relative(BACKEND_SRC, path).startsWith('routes/internal-agent/'))
      .filter(path =>
        /RuntimePrincipalVerifier|agentTokens\.verify\(/.test(
          readFileSync(path, 'utf8'),
        ),
      );
    expect(facetAuthority).toEqual([]);
  });

  it('ConversationSlot can target only its own conversation, even when the agent is a member elsewhere', () => {
    const f = fixture();
    const principal = conversationRuntimePrincipal({
      conversationId: 'A',
      agentId: 'agent',
      generation: 7,
      daemonInstanceId: 'daemon-1',
    });
    f.conversationSlots.set('A|agent', {
      generation: 7,
      claimed_by_daemon_instance_id: 'daemon-1',
    });
    f.memberships.add('A|agent');
    f.memberships.add('B|agent');
    const token = f.tokens.issue(principal);

    expect(f.verifier.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'A',
    })).toMatchObject({ ok: true, principal });
    expect(f.verifier.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'B',
    })).toEqual({ ok: false, reason: 'target_unauthorized' });
  });

  it('AgentSlot resolves each request target through live membership without changing runtime custody', () => {
    const f = fixture();
    const principal = agentRuntimePrincipal({
      agentId: 'agent',
      generation: 3,
      daemonInstanceId: 'daemon-agent',
    });
    f.agentSlots.set('agent', {
      generation: 3,
      claimed_by_daemon_instance_id: 'daemon-agent',
    });
    f.memberships.add('A|agent');
    f.memberships.add('B|agent');
    const token = f.tokens.issue(principal);

    for (const targetConversationId of ['A', 'B']) {
      expect(f.verifier.verify({
        token,
        routeAgentId: 'agent',
        targetConversationId,
      }).ok).toBe(true);
    }
    f.memberships.delete('A|agent');
    expect(f.verifier.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'A',
    })).toEqual({ ok: false, reason: 'target_unauthorized' });
    expect(f.verifier.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'B',
    }).ok).toBe(true);
    expect(f.agentSlots.get('agent')).toEqual({
      generation: 3,
      claimed_by_daemon_instance_id: 'daemon-agent',
    });
  });

  it('rejects an old generation, a finalized generation, and the wrong daemon without an in-memory revoke', () => {
    const f = fixture();
    const principal = conversationRuntimePrincipal({
      conversationId: 'A',
      agentId: 'agent',
      generation: 1,
      daemonInstanceId: 'daemon-1',
    });
    const slot = {
      generation: 1,
      claimed_by_daemon_instance_id: 'daemon-1' as string | null,
    };
    f.conversationSlots.set('A|agent', slot);
    f.memberships.add('A|agent');
    const token = f.tokens.issue(principal);
    const verify = () => f.verifier.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'A',
    });

    expect(verify().ok).toBe(true);
    slot.generation = 2;
    expect(verify()).toEqual({ ok: false, reason: 'custody_stale' });
    slot.generation = 1;
    slot.claimed_by_daemon_instance_id = null;
    expect(verify()).toEqual({ ok: false, reason: 'custody_stale' });
    slot.claimed_by_daemon_instance_id = 'daemon-2';
    expect(verify()).toEqual({ ok: false, reason: 'custody_stale' });
  });

  it('does not restore bearer knowledge across token-store restart', () => {
    const f = fixture();
    const principal = agentRuntimePrincipal({
      agentId: 'agent',
      generation: 1,
      daemonInstanceId: 'daemon-1',
    });
    f.agentSlots.set('agent', {
      generation: 1,
      claimed_by_daemon_instance_id: 'daemon-1',
    });
    f.memberships.add('A|agent');
    const token = f.tokens.issue(principal);
    const restarted = new RuntimePrincipalVerifier(
      new AgentTokenStore(),
      {
        getAgent: () => f.agentSlots.get('agent') ?? null,
        getConversation: () => null,
      },
      { isAgentParticipant: () => true },
    );
    expect(restarted.verify({
      token,
      routeAgentId: 'agent',
      targetConversationId: 'A',
    })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('binds the executing agent coordinate independently of target policy', () => {
    const f = fixture();
    const principal = agentRuntimePrincipal({
      agentId: 'agent',
      generation: 1,
      daemonInstanceId: 'daemon-1',
    });
    f.agentSlots.set('agent', {
      generation: 1,
      claimed_by_daemon_instance_id: 'daemon-1',
    });
    f.memberships.add('A|agent');
    expect(f.verifier.verify({
      token: f.tokens.issue(principal),
      routeAgentId: 'other-agent',
      targetConversationId: 'A',
    })).toEqual({ ok: false, reason: 'agent_mismatch' });
  });
});
