import { AGENT_AVAILABILITY_CHANGED_EVENT } from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type AgentAvailabilityChangedDeps,
  publishAgentAvailabilityChangedForHost,
} from '../../src/application/agent-availability-changed.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// The `agent_availability_changed` producer (#task:2043 B). It fans a pure
// invalidation to the users who may currently READ availability — the audience
// DUAL of `canViewAgent`. The load-bearing property is that a stranger to the
// agent is NEVER told: the fan-out can never leak a bit the read route would
// 404. These tests wire the same injected readers the composition root does.
describe('publishAgentAvailabilityChangedForHost (#task:2043 B)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const depsFor = (app: TestApp): AgentAvailabilityChangedDeps => ({
    listAgentIdsByHost: hostId =>
      new AgentRepo(app.ctx.db).listByHost(hostId).map(agent => agent.id),
    workspaceMemberUserIds: workspaceId =>
      new WorkspaceRepo(app.ctx.db).listUserMemberIds(workspaceId),
  });

  async function createAgentScoped(
    app: TestApp,
  ): Promise<{ agentId: string; hostId: string }> {
    const created = (await (
      await http(app).post('/api/agents', {
        name: 'reach-agent',
        runtime: 'claude',
        session_scope: 'agent',
      })
    ).json()) as { agent: { id: string; host_id: string } };
    return { agentId: created.agent.id, hostId: created.agent.host_id };
  }

  const capture = (app: TestApp, userIds: readonly string[]) => {
    const received = new Map<string, Array<{ kind: string; payload: unknown }>>();
    const offs = userIds.map(userId => {
      const bucket: Array<{ kind: string; payload: unknown }> = [];
      received.set(userId, bucket);
      return app.ctx.events.subscribeScope(`viewer:${userId}`, e =>
        bucket.push({ kind: e.kind, payload: e.payload }),
      );
    });
    return {
      of: (userId: string) => received.get(userId) ?? [],
      stop: () => offs.forEach(off => off()),
    };
  };

  it('fans to exactly the canViewAgent audience — owner + DirectPair human, never a stranger', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId, hostId } = await createAgentScoped(t);
    // A human↔agent DirectPair adds `teammate` to the audience — the same
    // endpoint-ness the read route's 4th ACL arm grants.
    new ConversationRepo(t.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'teammate' },
      Date.now(),
    );

    // `local` is the default fixture viewer ⇒ the agent's creator.
    const cap = capture(t, ['local', 'teammate', 'someone']);
    publishAgentAvailabilityChangedForHost(t.ctx, depsFor(t), hostId);
    cap.stop();

    const one = [
      { kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { agent_id: agentId } },
    ];
    // Creator and the DirectPair human endpoint each get ONE pure invalidation
    // carrying only the agent id (deduped even if a viewer qualifies via more
    // than one ACL arm).
    expect(cap.of('local')).toEqual(one);
    expect(cap.of('teammate')).toEqual(one);
    // A stranger to the agent is never told.
    expect(cap.of('someone')).toEqual([]);
  });

  it('drops a DirectPair human from the audience once the agent can no longer be viewed (audience follows canViewAgent, not a static roster)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId, hostId } = await createAgentScoped(t);
    new ConversationRepo(t.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'teammate' },
      Date.now(),
    );

    // Take the agent out of the `active` materialization set: `canViewAgent`
    // fails its status widener for EVERY principal, so the audience collapses to
    // empty even though the DirectPair edge still exists. This is why the
    // producer filters candidates through `canViewAgent` rather than trusting
    // the union of raw ACL arms.
    t.ctx.db
      .prepare(
        `UPDATE agents SET materialization_status = 'pending_materialization' WHERE id = ?`,
      )
      .run(agentId);

    const cap = capture(t, ['local', 'teammate']);
    publishAgentAvailabilityChangedForHost(t.ctx, depsFor(t), hostId);
    cap.stop();

    expect(cap.of('local')).toEqual([]);
    expect(cap.of('teammate')).toEqual([]);
  });
});
