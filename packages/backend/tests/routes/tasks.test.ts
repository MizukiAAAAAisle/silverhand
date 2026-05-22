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
  const h = http(t);
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

describe('Tasks (PR-T1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('create_tasks allocates monotonic per-workspace task_numbers', async () => {
    t = buildTestApp();
    const { conversationId, agentIds, workspaceId } = await setup(t);
    const h = http(t);

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
    const h2 = http(t);
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
    const h = http(t);

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
      await http(t).get('/api/tasks')
    ).json() as any;
    expect(listed.tasks[0].status).toBe('in_progress');
    expect(listed.tasks[0].assignee?.type).toBe('agent');
    expect(listed.tasks[0].assignee?.id).toBe(agentIds.alice);
  });

  it('claim by message_id promotes a regular message to a task', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    // User posts a normal message; alice promotes it.
    const viewer = http(t, { 'x-silverhand-user-id': 'teammate' });
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
      await http(t).get('/api/tasks')
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

  it('cross-conversation claim within same workspace succeeds (#task:530)', async () => {
    t = buildTestApp();
    const s1 = await setup(t);
    // Second session in same channel.
    const ses2 = (await (
      await http(t).post(`/api/workspaces/${s1.channelId}/channels`, {
        title: 'parallel',
        member_agent_ids: Object.values(s1.agentIds),
      })
    ).json()) as any;
    const sessionId2 = ses2.channel.id;

    const h = http(t);
    // Create in session 1, claim from session 2 — new cross-channel
    // semantics: same workspace, so the lookup resolves via the
    // actor's current workspace and succeeds.
    await h.post(
      `/internal/conversations/${s1.sessionId}/agents/${s1.agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'in session 1' }] },
    );
    const crossClaim = await (
      await h.post(
        `/internal/conversations/${sessionId2}/agents/${s1.agentIds.bob}/tasks/claim`,
        { task_numbers: [1] },
      )
    ).json() as any;
    expect(crossClaim.results[0].success).toBe(true);

    // It IS visible in list_tasks from session 2 (workspace-level
    // aggregation).
    const listed = await (
      await h.get(
        `/internal/conversations/${sessionId2}/agents/${s1.agentIds.bob}/tasks`,
      )
    ).json() as any;
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].conversation.id).toBe(s1.sessionId);
    expect(listed.tasks[0].assignee?.id).toBe(s1.agentIds.bob);
  });

  it('update_status: assignee-only + transition rules', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

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
    const h = http(t);

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
      await http(t).post(`/api/tasks/${messageId}/status`, { status: 'done' })
    ).json() as any;
    expect(approve.success).toBe(true);

    const listed = await (
      await http(t).get('/api/tasks')
    ).json() as any;
    expect(listed.tasks[0].status).toBe('done');
  });

  it('publishes task_changed realtime events on claim', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
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
    const h = http(t);

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
    const h = http(t);

    // create one task by agent
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { tasks: [{ title: 'numbered task' }] },
    );
    // post a regular message for promote-and-claim
    const viewer = http(t, { 'x-silverhand-user-id': 'teammate' });
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
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'plain' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;

    const claim = (await (
      await http(t).post(`/api/tasks/${messageId}/claim`, {})
    ).json()) as any;
    expect(claim.success).toBe(true);

    const listed = (await (await http(t).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('in_progress');
    expect(listed.tasks[0].assignee).toBeNull();
  });

  it('human POST /api/tasks/:messageId/unclaim forces status=todo even from in_review', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

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
      await http(t).post(`/api/tasks/${messageId}/unclaim`)
    ).json()) as any;
    expect(unclaim.success).toBe(true);

    const listed = (await (await http(t).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('todo');
    expect(listed.tasks[0].assignee).toBeNull();
  });

  it('human POST /api/tasks/:messageId/status can jump to any non-current status', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { tasks: [{ title: 'shortcut' }] },
      )
    ).json()) as any;
    const messageId = created.tasks[0].message_id;

    const direct = (await (
      await http(t).post(`/api/tasks/${messageId}/status`, { status: 'done' })
    ).json()) as any;
    expect(direct.success).toBe(true);
    const listed = (await (await http(t).get('/api/tasks')).json()) as any;
    expect(listed.tasks[0].status).toBe('done');
  });

  it('agent task list filters by repeated --task-number / --status / --assignee + --limit', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    // Seed 5 tasks created by alice. Claim #2 + #3 (alice in_progress),
    // claim+in_review #4 (alice).
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      {
        tasks: [
          { title: 't1' },
          { title: 't2' },
          { title: 't3' },
          { title: 't4' },
          { title: 't5' },
        ],
      },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [2, 3, 4] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
      { task_number: 4, status: 'in_review' },
    );

    const listPath = `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks`;

    // Repeated task_number (the regression we are fixing).
    const byNumbers = (await (
      await h.get(`${listPath}?task_number=2&task_number=4`)
    ).json()) as any;
    expect(byNumbers.tasks.map((x: any) => x.task_number).sort()).toEqual([2, 4]);

    // Repeated status: in_progress OR in_review picks #2, #3, #4.
    const byStatuses = (await (
      await h.get(`${listPath}?status=in_progress&status=in_review`)
    ).json()) as any;
    expect(byStatuses.tasks.map((x: any) => x.task_number).sort()).toEqual([
      2,
      3,
      4,
    ]);

    // assignee_id narrows to alice (which is everyone we just claimed),
    // status=todo narrows to #1, #5 (unclaimed).
    const todos = (await (await h.get(`${listPath}?status=todo`)).json()) as any;
    expect(todos.tasks.map((x: any) => x.task_number).sort()).toEqual([1, 5]);

    const aliceClaimed = (await (
      await h.get(`${listPath}?assignee_id=${agentIds.alice}`)
    ).json()) as any;
    expect(aliceClaimed.tasks.map((x: any) => x.task_number).sort()).toEqual([
      2,
      3,
      4,
    ]);

    // limit caps the row count without changing the ORDER (task_number ASC).
    const limited = (await (await h.get(`${listPath}?limit=2`)).json()) as any;
    expect(limited.tasks.map((x: any) => x.task_number)).toEqual([1, 2]);

    // Legacy single-value status query continues to work.
    const onlyDone = (await (
      await h.get(`${listPath}?status=in_review`)
    ).json()) as any;
    expect(onlyDone.tasks.map((x: any) => x.task_number)).toEqual([4]);

    // Legacy 'all' alias is treated as no-filter on the route side.
    const allViaLegacy = (await (
      await h.get(`${listPath}?status=all`)
    ).json()) as any;
    expect(allViaLegacy.tasks.length).toBe(5);
  });

  it('agent task list with --workspace-id of non-member workspace → 403 (#task:530)', async () => {
    // Cindy `8SGSccsFirCbsuTN` Blocker 2: the route must enforce
    // workspace existence + agent membership BEFORE handing
    // workspace_id to taskService.list, otherwise an agent can
    // silently read sister workspaces.
    t = buildTestApp();
    const s1 = await setup(t);
    const h = http(t);

    // Create a second regular workspace whose only member is bob.
    // alice does NOT belong to ws2.
    const ws2Resp = await h.post('/api/workspaces', {
      name: 'platform',
      member_agent_ids: [s1.agentIds.bob],
    });
    expect(ws2Resp.status).toBe(201);
    const ws2 = (await ws2Resp.json()) as any;
    expect(ws2.workspace?.id).toBeDefined();

    // Alice (current conv = s1.sessionId, ws=eng) tries to list ws2.
    const listPath = `/internal/conversations/${s1.sessionId}/agents/${s1.agentIds.alice}/tasks`;
    const denied = await h.get(`${listPath}?workspace_id=${ws2.workspace.id}`);
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as any;
    expect(deniedBody.code).toBe('workspace_membership_required');

    // Same call with a non-existent workspace_id → 404 unknown.
    const missing = await h.get(`${listPath}?workspace_id=ws-not-found`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as any;
    expect(missingBody.code).toBe('unknown_workspace');

    // Without selector (default = current ws) → 200 with no tasks.
    const ok = await h.get(listPath);
    expect(ok.status).toBe(200);
  });
});
