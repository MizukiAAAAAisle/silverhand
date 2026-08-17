import { randomUUID } from 'node:crypto';
import { AGENT_AVAILABILITY_CHANGED_EVENT, fixedWorkspaceName } from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type AgentAvailabilityChangedDeps,
  publishAgentAvailabilityChangedForHost,
} from '../../src/application/agent-availability-changed.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { canViewAgent } from '../../src/permissions.js';
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
    const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
    // Create the agent PENDING and never activate it — the sanctioned way to
    // hold a non-`active` row (there is no active→pending transition; that is a
    // deliberate lifecycle invariant). `listByHost` is status-agnostic, so the
    // producer still ENUMERATES this agent — the audience empties only because
    // `canViewAgent` (default `includeStatuses: ['active']`) rejects it, and
    // `agentViewerUserIds` applies that SAME active-only widener, which is
    // precisely the status gate under test. A raw-SQL demotion would trip the
    // db-boundary ledger AND fake a transition production cannot make.
    const agentId = new AgentRepo(t.ctx.db).reserveForMaterialize(
      { name: 'pending-agent', runtime: 'claude', session_scope: 'agent' },
      hostId,
      'local',
      `idem-${randomUUID().slice(0, 8)}`,
    ).id;
    new ConversationRepo(t.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'teammate' },
      Date.now(),
    );

    const cap = capture(t, ['local', 'teammate']);
    publishAgentAvailabilityChangedForHost(t.ctx, depsFor(t), hostId);
    cap.stop();

    // Creator and the DirectPair human endpoint both hit an ACL arm, yet a
    // non-`active` agent is a 404 for everyone, so the audience collapses to
    // empty via the status gate. The arm union is never trusted on its own.
    expect(cap.of('local')).toEqual([]);
    expect(cap.of('teammate')).toEqual([]);
  });

  it('fans through the workspace arm and dedupes a viewer who qualifies via two arms', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
    const agents = new AgentRepo(t.ctx.db);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    // A workspace-associated agent (creator `local`), visible to the workspace's
    // human members via `canViewAgent`'s shared-workspace arm.
    const agentId = agents.create(
      { name: 'ws-agent', runtime: 'claude' },
      hostId,
      'local',
    ).id;
    const workspace = workspaces.insert({
      name: fixedWorkspaceName(`ws-${randomUUID().slice(0, 8)}`),
      description: null,
    });
    workspaces.insertMembership(workspace.id, agentId);
    // `local` hits TWO arms (creator ∪ workspace member); `teammate` hits ONLY
    // the workspace arm; `other` hits none.
    workspaces.addUserMember(workspace.id, 'local');
    workspaces.addUserMember(workspace.id, 'teammate');

    const cap = capture(t, ['local', 'teammate', 'other']);
    publishAgentAvailabilityChangedForHost(t.ctx, depsFor(t), hostId);
    cap.stop();

    const one = [
      { kind: AGENT_AVAILABILITY_CHANGED_EVENT, payload: { agent_id: agentId } },
    ];
    // `teammate` proves the workspace arm carries the fan-out on its own —
    // delete the producer's workspace-candidate loop and this expectation fails.
    expect(cap.of('teammate')).toEqual(one);
    // `local` qualifies as creator AND workspace member but still gets exactly
    // ONE frame — pins the `Set`-based candidate dedupe.
    expect(cap.of('local')).toEqual(one);
    expect(cap.of('other')).toEqual([]);
  });

  it('the fan-out audience is EXACTLY the canViewAgent-true set over a population spanning every arm (dual by construction — no arm can drift)', async () => {
    // Seed one agent reachable through ALL THREE human ACL arms plus a stranger,
    // then assert the set of users who RECEIVE the invalidation equals the set
    // `canViewAgent` admits — the structural/sensitivity proof (#task:2043 B,
    // Cindy `oOQkk0fQfYxuSW_U`). Both directions read the ONE shared arm builder
    // (`agentHumanViewerUserIds`), so this equality holds by construction: it
    // breaks the moment a future edit teaches `canViewAgent` to admit a user the
    // audience does not enumerate (under-send — the leak the contract forbids)
    // or the reverse — a drift a single arm list, filtered post-hoc, would hide.
    // Bind a non-null handle: the module-level `let t` is narrowed to TestApp
    // here, but that narrowing does NOT flow into the `.filter()` callbacks
    // below (nested closures), so read `app.ctx` — not `t.ctx` — inside them.
    const app = (t = buildTestApp({ seedAllFixtureMemberships: false }));
    const hostId = new HostRepo(app.ctx.db).ensureLocal().id;
    const agents = new AgentRepo(app.ctx.db);
    const workspaces = new WorkspaceRepo(app.ctx.db);
    // Creator = `local`.
    const agentId = agents.create(
      { name: 'all-arms-agent', runtime: 'claude' },
      hostId,
      'local',
    ).id;
    // Workspace arm: `other` is a co-member of a workspace the agent is in.
    const workspace = workspaces.insert({
      name: fixedWorkspaceName(`ws-${randomUUID().slice(0, 8)}`),
      description: null,
    });
    workspaces.insertMembership(workspace.id, agentId);
    workspaces.addUserMember(workspace.id, 'other');
    // DirectPair arm: `teammate` is the human endpoint of a human↔agent pair.
    new ConversationRepo(app.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'teammate' },
      Date.now(),
    );

    // `someone` hits no arm — the stranger.
    const population = ['local', 'teammate', 'other', 'someone'];
    const cap = capture(app, population);
    publishAgentAvailabilityChangedForHost(app.ctx, depsFor(app), hostId);
    cap.stop();

    const received = population.filter(u => cap.of(u).length > 0).sort();
    const canView = population
      .filter(u => canViewAgent(app.ctx, { kind: 'user', userId: u }, agentId))
      .sort();
    // The audience IS the predicate's positive set — no more, no less.
    expect(received).toEqual(canView);
    // And concretely: all three arms in, the stranger out.
    expect(received).toEqual(['local', 'other', 'teammate']);
  });
});
