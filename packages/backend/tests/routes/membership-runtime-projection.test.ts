import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { DbRuntimeStatusProjector } from '../../src/runtime/status-projector.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('membership and runtime projection authority (#task:2026)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('keeps membership stable while ConversationSlot and AgentSlot project independently', async () => {
    t = buildTestApp();
    const conversationScoped = await (
      await http(t).post('/api/agents', {
        name: 'projection-conversation',
        runtime: 'claude',
      })
    ).json() as any;
    const agentScoped = await (
      await http(t).post('/api/agents', {
        name: 'projection-agent',
        runtime: 'claude',
        session_scope: 'agent',
      })
    ).json() as any;
    const agentIds = [conversationScoped.agent.id, agentScoped.agent.id];
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'projection-authority',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const channel = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'projection-main',
        member_agent_ids: agentIds,
      })
    ).json() as any;

    const membership = await (
      await http(t).get(`/api/channels/${channel.channel.id}/agents`)
    ).json() as any;
    expect(membership.agents).toHaveLength(2);
    for (const row of membership.agents) {
      expect(Object.keys(row).sort()).toEqual([
        'agent_id',
        'conversation_id',
        'joined_at',
      ]);
    }

    const runtime = await (
      await http(t).get(`/api/channels/${channel.channel.id}/agent-runtime`)
    ).json() as any;
    expect(runtime.runtime).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: conversationScoped.agent.id,
        scope_kind: 'conversation',
      }),
      expect.objectContaining({
        agent_id: agentScoped.agent.id,
        scope_kind: 'agent',
      }),
    ]));

    const second = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'projection-second',
        member_agent_ids: [agentScoped.agent.id],
      })
    ).json() as any;
    expect(second.channel.id).not.toBe(channel.channel.id);
    expect(new RuntimeSlotRepo(t.ctx.db).listSeats(agentScoped.agent.id)).toEqual([
      expect.objectContaining({ scope: { kind: 'agent', agentId: agentScoped.agent.id } }),
    ]);

    t.ctx.db.prepare(
      `DELETE FROM agent_runtime_slots
        WHERE agent_id = ? AND conversation_id = ?`,
    ).run(conversationScoped.agent.id, channel.channel.id);

    const membershipAfterSlotDelete = await (
      await http(t).get(`/api/channels/${channel.channel.id}/agents`)
    ).json() as any;
    expect(membershipAfterSlotDelete.agents.map((row: any) => row.agent_id).sort())
      .toEqual([...agentIds].sort());
    const runtimeAfterSlotDelete = await (
      await http(t).get(`/api/channels/${channel.channel.id}/agent-runtime`)
    ).json() as any;
    expect(runtimeAfterSlotDelete.runtime.map((row: any) => row.agent_id))
      .toEqual([agentScoped.agent.id]);
  });

  it('redacts AgentSlot focus without multiplying or hiding the aggregate seat', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', {
        name: 'projection-focus',
        runtime: 'claude',
        session_scope: 'agent',
      })
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'projection-focus-space',
        member_agent_ids: [created.agent.id],
      })
    ).json() as any;
    const channel = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'projection-focus-channel',
        member_agent_ids: [created.agent.id],
      })
    ).json() as any;
    t.fake.clearSessionResult.focusConversationId = channel.channel.id;

    const visible = await (
      await http(t).get(`/api/agents/${created.agent.id}/runtime-state`)
    ).json() as any;
    expect(visible.seats).toHaveLength(1);
    expect(visible.seats[0]).toMatchObject({
      scope: { kind: 'agent' },
      focus: { kind: 'conversation', conversation_id: channel.channel.id },
    });

    new ConversationRepo(t.ctx.db).removeUser(channel.channel.id, t.viewerUserId);
    const redacted = await (
      await http(t).get(`/api/agents/${created.agent.id}/runtime-state`)
    ).json() as any;
    expect(redacted.participations.map((row: any) => row.conversation_id))
      .not.toContain(channel.channel.id);
    expect(redacted.seats).toHaveLength(1);
    expect(redacted.seats[0]).toMatchObject({
      scope: { kind: 'agent' },
      focus: { kind: 'other' },
    });
  });

  it('fans one AgentSlot status mutation out to every authorized conversation projection', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', {
        name: 'projection-fanout',
        runtime: 'claude',
        session_scope: 'agent',
      })
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'projection-fanout-space',
        member_agent_ids: [created.agent.id],
      })
    ).json() as any;
    const makeChannel = async (title: string) => (
      await http(t!).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title,
        member_agent_ids: [created.agent.id],
      })
    ).json() as Promise<any>;
    const a = await makeChannel('projection-fanout-a');
    const b = await makeChannel('projection-fanout-b');

    const runtimeSlots = new RuntimeSlotRepo(t.ctx.db);
    const claimed = runtimeSlots.claimGeneration({
      scope: { kind: 'agent', agentId: created.agent.id },
      daemonInstanceId: 'daemon-projection-fanout',
      status: 'active',
    });
    expect(claimed).not.toBeNull();

    const snapshot = async (conversationId: string) => (
      await http(t!).get(`/api/channels/${conversationId}/agent-runtime`)
    ).json() as Promise<any>;
    expect((await snapshot(a.channel.id)).runtime).toEqual([
      expect.objectContaining({ agent_id: created.agent.id, status: 'active' }),
    ]);
    expect((await snapshot(b.channel.id)).runtime).toEqual([
      expect.objectContaining({ agent_id: created.agent.id, status: 'active' }),
    ]);

    const events: Array<{ conversationId: string; payload: unknown }> = [];
    const publisher: EventPublisher = {
      publish: () => {},
      publishSide: (conversationId, event) => {
        events.push({ conversationId, payload: event.payload });
      },
    };
    const agents = new AgentRepo(t.ctx.db);
    const projector = new DbRuntimeStatusProjector(runtimeSlots, publisher, {
      listProjectionConversationIds: agentId =>
        agents.listRuntimeParticipations(agentId).map(row => row.conversation_id),
    });
    const secretSnippet = 'secret-from-a';
    projector.runtimeExit({
      scope: { kind: 'agent', agentId: created.agent.id },
      conversationId: a.channel.id,
      agentId: created.agent.id,
      custody: {
        generation: claimed!.generation,
        daemonInstanceId: 'daemon-projection-fanout',
      },
      intentional: false,
      code: 137,
      initTimedOut: false,
      fatalError: false,
      runState: {
        runId: 'run-a',
        agentId: created.agent.id,
        conversationId: a.channel.id,
        status: 'thinking',
        startedAt: 1,
        updatedAt: 2,
        lastActivityAt: 2,
        activitySnippet: secretSnippet,
      },
    });

    const audiences = events.map(event => event.conversationId);
    expect(new Set(audiences).size).toBe(audiences.length);
    expect(audiences).toEqual(expect.arrayContaining([a.channel.id, b.channel.id]));
    expect(events.every(event =>
      (event.payload as { status?: string }).status === 'crashed'
    )).toBe(true);
    const eventA = events.find(event => event.conversationId === a.channel.id)!;
    const eventB = events.find(event => event.conversationId === b.channel.id)!;
    expect(eventA.payload).toMatchObject({
      run_state: {
        conversationId: a.channel.id,
        activitySnippet: secretSnippet,
      },
    });
    expect(JSON.stringify(eventB.payload)).not.toContain(a.channel.id);
    expect(JSON.stringify(eventB.payload)).not.toContain(secretSnippet);
    expect((await snapshot(a.channel.id)).runtime).toEqual([
      expect.objectContaining({ agent_id: created.agent.id, status: 'crashed' }),
    ]);
    expect((await snapshot(b.channel.id)).runtime).toEqual([
      expect.objectContaining({ agent_id: created.agent.id, status: 'crashed' }),
    ]);
  });
});
