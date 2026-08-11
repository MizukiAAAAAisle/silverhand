import { describe, expect, it } from 'vitest';
import { MembershipService } from '../../src/services/membership-service.js';
import { makeTestContext } from '../utils/test-context.js';

function bootstrap() {
  // Each test controls exactly which users / agents are members of the
  // conversation it builds, so the fixture membership autoseed is off.
  const ctx = makeTestContext({ seedAllFixtureMemberships: false });
  const service = new MembershipService({
    agents: ctx.repos.agents,
    users: ctx.repos.users,
    conversations: ctx.repos.conversations,
  });
  const workspace = ctx.createWorkspace('eng');
  const channel = ctx.createChannel(workspace, 'general');
  return { ctx, service, workspace, channel };
}

function withContext(run: (t: ReturnType<typeof bootstrap>) => void): void {
  const t = bootstrap();
  try {
    run(t);
  } finally {
    t.ctx.cleanup();
  }
}

describe('MembershipService.listMembers', () => {
  it('returns agents (joined-order) followed by humans (joined-order)', () => {
    withContext(t => {
      const alice = t.ctx.createAgent('alice');
      const bob = t.ctx.createAgent('bob', { runtime: 'codex' });
      // Add bob first to verify joined-order ASC vs name-order or
      // creation-order: the resulting list must be [bob, alice], not
      // [alice, bob]. Pin distinct joined_at values so the test isn't
      // flaky when two membership adds land in the same millisecond.
      t.ctx.addAgentMember(t.channel, bob, { joinedAt: 1000 });
      t.ctx.addAgentMember(t.channel, alice, { joinedAt: 2000 });
      t.ctx.addUserMember(t.channel, 'teammate', { joinedAt: 1500 });
      t.ctx.addUserMember(t.channel, 'local', { joinedAt: 2500 });

      const members = t.service.listMembers(t.channel.id);
      expect(members.map(m => ({ kind: m.kind, name: m.name }))).toEqual([
        { kind: 'agent', name: 'bob' },
        { kind: 'agent', name: 'alice' },
        { kind: 'human', name: 'teammate-test' },
        { kind: 'human', name: 'local-test' },
      ]);
    });
  });

  it('returns the full DTO shape per member kind', () => {
    withContext(t => {
      const alice = t.ctx.createAgent('alice', { displayName: 'Alice (lead)' });
      t.ctx.addAgentMember(t.channel, alice);
      t.ctx.addUserMember(t.channel, 'local');

      const members = t.service.listMembers(t.channel.id);
      expect(members).toEqual([
        {
          kind: 'agent',
          agent_id: alice.id,
          name: 'alice',
          display_name: 'Alice (lead)',
          runtime: 'claude',
        },
        {
          kind: 'human',
          user_id: 'local',
          name: 'local-test',
          display_name: 'Local Test User',
          avatar_url: null,
        },
      ]);
    });
  });

  it('returns [] for a conversation with no members', () => {
    withContext(t => {
      const empty = t.ctx.createChannel(t.workspace, 'empty');
      expect(t.service.listMembers(empty.id)).toEqual([]);
    });
  });

  it('drops orphaned agent / user rows whose primary record is gone', () => {
    // Defensive case: if a conversation_agents row references a
    // deleted agent, listMembers should silently skip rather than
    // surface a half-resolved row. Same for users. Production should
    // never let this state happen (FK CASCADE is set), but the
    // service should be robust to it.
    withContext(t => {
      const ghost = t.ctx.createAgent('ghost');
      t.ctx.addAgentMember(t.channel, ghost);
      t.ctx.forceDeleteAgentRowKeepingMemberships(ghost.id);
      t.ctx.forceInsertDanglingUserMember(t.channel, 'phantom');

      // Add one real human so we can prove the live row survives
      // alongside the dropped phantom.
      t.ctx.addUserMember(t.channel, 'local');

      const members = t.service.listMembers(t.channel.id);
      expect(members).toEqual([
        {
          kind: 'human',
          user_id: 'local',
          name: 'local-test',
          display_name: 'Local Test User',
          avatar_url: null,
        },
      ]);
    });
  });
});
