import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

interface SetupResult {
  workspaceId: string;
  conversationId: string;
  /** Legacy aliases retained inside this test file while nearby cases are converted. */
  channelId: string;
  sessionId: string;
  agentIds: Record<string, string>;
}

async function setup(t: TestApp, members = ['alice', 'bob']): Promise<SetupResult> {
  const h = http(t.app);
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const r = (await (
      await h.post('/api/agents', { name, runtime: 'claude' })
    ).json()) as any;
    agentIds[name] = r.agent.id;
  }
  const ws = (await (
    await h.post('/api/workspaces', {
      name: 'eng',
      member_agent_ids: Object.values(agentIds),
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: ws.workspace.id,
    conversationId: ws.onboarding_channel_id,
    channelId: ws.workspace.id,
    sessionId: ws.onboarding_channel_id,
    agentIds,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('Tasks (PR-T1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('create_tasks allocates monotonic per-workspace task_numbers', async () => {
    t = buildTestApp();
    const { conversationId, agentIds, workspaceId } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    const r1 = await (
      await h.post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'fix login' }, { title: 'add logout' }] },
      )
    ).json() as any;
    expect(r1.tasks).toHaveLength(2);
    expect(r1.tasks[0].task_number).toBe(1);
    expect(r1.tasks[1].task_number).toBe(2);

    // Human list view picks up both, with correct workspace/channel refs.
    const h2 = http(t.app);
    const all = await (await h2.get('/api/tasks')).json() as any;
    expect(all.tasks).toHaveLength(2);
    expect(all.tasks[0].workspace_id).toBe(workspaceId);
    expect(all.tasks[0].channel_id).toBe(conversationId);
    expect(all.tasks[0].conversation.id).toBe(conversationId);
    expect(all.tasks[0].status).toBe('todo');
    expect(all.tasks[0].assignee).toBeNull();
    expect(all.tasks[0].title).toBe('fix login');
  });

  it('claim_tasks wins the race once + second claimer fails', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'shared work' }] },
    );

    const aliceClaim = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
        { task_numbers: [1] },
      )
    ).json() as any;
    expect(aliceClaim.results[0].success).toBe(true);

    const bobClaim = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.bob}/tasks/claim`,
        { task_numbers: [1] },
      )
    ).json() as any;
    expect(bobClaim.results[0].success).toBe(false);
    expect(bobClaim.results[0].reason).toMatch(/already claimed/);

    // After claim, status has auto-advanced to in_progress.
    const listed = await (
      await http(t.app).get('/api/tasks')
    ).json() as any;
    expect(listed.tasks[0].status).toBe('in_progress');
    expect(listed.tasks[0].assignee?.type).toBe('agent');
    expect(listed.tasks[0].assignee?.id).toBe(agentIds.alice);
  });

  it('claim by message_id promotes a regular message to a task', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    // User posts a normal message; alice promotes it.
    const viewer = http(t.app, { 'x-silverhand-user-id': 'teammate' });
    const userMsg = await (
      await viewer.post(`/api/channels/${sessionId}/messages`, {
        content: 'please refactor auth module',
      })
    ).json() as any;

    const claim = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
        { message_ids: [userMsg.message.id] },
      )
    ).json() as any;
    expect(claim.results[0].success).toBe(true);
    expect(claim.results[0].task_number).toBe(1);

    // The promoted message now lists as a task, title from first line.
    const listed = await (
      await http(t.app).get('/api/tasks')
    ).json() as any;
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].title).toBe('please refactor auth module');
    expect(listed.tasks[0].creator).toMatchObject({
      type: 'user',
      id: 'teammate',
      name: 'teammate',
    });
    expect(listed.tasks[0].creator.name).not.toBe('you');
  });

  it('rejects cross-conversation claim with owner_conversation in reason', async () => {
    t = buildTestApp();
    const s1 = await setup(t);
    // Second session in same channel.
    const ses2 = (await (
      await http(t.app).post(`/api/workspaces/${s1.channelId}/channels`, {
        title: 'parallel',
        member_agent_ids: Object.values(s1.agentIds),
      })
    ).json()) as any;
    const sessionId2 = ses2.channel.id;

    const h = http(t.app, auth(t.authToken));
    // Create in session 1, try to claim from session 2.
    await h.post(
      `/internal/conversations/${s1.sessionId}/agents/${s1.agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'in session 1' }] },
    );
    const wrongClaim = await (
      await h.post(
        `/internal/conversations/${sessionId2}/agents/${s1.agentIds.bob}/tasks/claim`,
        { task_numbers: [1] },
      )
    ).json() as any;
    expect(wrongClaim.results[0].success).toBe(false);
    expect(wrongClaim.results[0].reason).toMatch(/another conversation/);
    expect(wrongClaim.results[0].owner_conversation?.id).toBe(s1.sessionId);

    // But it IS visible in list_tasks from session 2 (channel-level
    // aggregation).
    const listed = await (
      await h.get(
        `/internal/conversations/${sessionId2}/agents/${s1.agentIds.bob}/tasks`,
      )
    ).json() as any;
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].conversation.id).toBe(s1.sessionId);
  });

  it('update_status: assignee-only + transition rules', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'ship' }] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );

    // bob (not assignee) can't update.
    const bobUpdate = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.bob}/tasks/update-status`,
        { task_number: 1, status: 'in_review' },
      )
    ).json() as any;
    expect(bobUpdate.success).toBe(false);
    expect(bobUpdate.reason).toMatch(/assignee/);

    // alice in_progress → in_review OK.
    const ok = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
        { task_number: 1, status: 'in_review' },
      )
    ).json() as any;
    expect(ok.success).toBe(true);

    // in_review → todo rejected (not in VALID_TRANSITIONS).
    const bad = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
        { task_number: 1, status: 'todo' },
      )
    ).json() as any;
    expect(bad.success).toBe(false);
    expect(bad.reason).toMatch(/invalid transition/);
  });

  it('human can approve in_review → done via /api/tasks/:id/status', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'review me' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
      { task_number: 1, status: 'in_review' },
    );

    // Human approve.
    const approve = await (
      await http(t.app).post(`/api/tasks/${messageId}/status`, { status: 'done' })
    ).json() as any;
    expect(approve.success).toBe(true);

    const listed = await (
      await http(t.app).get('/api/tasks')
    ).json() as any;
    expect(listed.tasks[0].status).toBe('done');
  });

  it('publishes task_changed realtime events on claim', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));
    const received: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribe(sessionId, e => received.push(e));

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'x' }] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );

    unsub();
    const kinds = received.map(e => e.kind);
    // Each mutation publishes BOTH `message` (system msg) and `task_changed`.
    expect(kinds.filter(k => k === 'task_changed')).toHaveLength(2);
    const ev = received.find(e => e.kind === 'task_changed')!.payload as any;
    expect(ev.channel_id).toBeTruthy();
    expect(ev.task_number).toBe(1);
  });

  it('system messages fan out to every session member\'s inbox', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    t.fake.delivered = []; // clear setup noise

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'shared work' }] },
    );
    // Both alice and bob should receive the system message via inbox.
    const recipients = new Set(t.fake.delivered.map(d => d.agentId));
    expect(recipients.has(agentIds.alice!)).toBe(true);
    expect(recipients.has(agentIds.bob!)).toBe(true);
  });

  it('bulk agent claim mixes task_numbers + message_ids into aggregated results', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    // create one task by agent
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'numbered task' }] },
    );
    // post a regular message for promote-and-claim
    const viewer = http(t.app, { 'x-silverhand-user-id': 'teammate' });
    const userMsg = await (
      await viewer.post(`/api/channels/${sessionId}/messages`, {
        content: 'please look into the deadlock',
      })
    ).json() as any;

    const claim = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
        { task_numbers: [1], message_ids: [userMsg.message.id] },
      )
    ).json() as any;
    expect(claim.results).toHaveLength(2);
    expect(claim.results[0].success).toBe(true);
    expect(claim.results[0].task_number).toBe(1);
    expect(claim.results[1].success).toBe(true);
    expect(claim.results[1].task_number).toBe(2);
  });

  it('human POST /api/tasks/:messageId/claim with no agent_id lifts todo→in_progress, leaves assignee null', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'plain' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;

    const claim = (await (
      await http(t.app).post(`/api/tasks/${messageId}/claim`, {})
    ).json()) as any;
    expect(claim.success).toBe(true);

    const listed = (await (await http(t.app).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('in_progress');
    expect(listed.tasks[0].assignee).toBeNull();
  });

  it('human POST /api/tasks/:messageId/unclaim forces status=todo even from in_review', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'review me' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
      { task_number: 1, status: 'in_review' },
    );

    const unclaim = (await (
      await http(t.app).post(`/api/tasks/${messageId}/unclaim`)
    ).json()) as any;
    expect(unclaim.success).toBe(true);

    const listed = (await (await http(t.app).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('todo');
    expect(listed.tasks[0].assignee).toBeNull();
  });

  it('human POST /api/tasks/:messageId/status can jump to any non-current status', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t.app, auth(t.authToken));

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'shortcut' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;

    const direct = (await (
      await http(t.app).post(`/api/tasks/${messageId}/status`, { status: 'done' })
    ).json()) as any;
    expect(direct.success).toBe(true);
    const listed = (await (await http(t.app).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('done');
  });
});
