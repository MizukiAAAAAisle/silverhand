import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { canPostToConversation, canViewConversation } from '../../src/permissions.js';
import type { AgentPrincipal } from '../../src/auth/principal.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { configureDatabaseObservation } from '../../src/observability/observed-statement.js';
import { AGENT_CAPABILITIES } from '@silverhand/shared';

/** A well-formed conversation address that names nothing: 16 chars of the id
 *  domain, so it reaches the RESOLVER (a shorter fixture-shaped id would be
 *  refused earlier as `target_malformed`, which is a different outcome). */
const MISSING_ID = 'zzzzMISSINGzzz01';

interface SetupResult {
  workspaceId: string;
  conversationId: string;
  /** Legacy aliases retained inside this test file while nearby cases are converted. */
  channelId: string;
  sessionId: string;
  agentIds: Record<string, string>;
}

async function setup(
  t: TestApp,
  members = ['alice', 'bob'],
  // Agent names AND workspace names are unique per app, so a case that seeds two
  // workspaces in ONE app passes distinct values for both.
  workspaceName = 'eng',
): Promise<SetupResult> {
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
      name: workspaceName,
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
    const { conversationId, agentIds } = await setup(t);
    const h = http(t);

    const r1 = await (
      await h.post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${conversationId}`, tasks: [{ title: 'fix login' }, { title: 'add logout' }] },
      )
    ).json() as any;
    expect(r1.tasks).toHaveLength(2);
    expect(r1.tasks[0].task_number).toBe(1);
    expect(r1.tasks[1].task_number).toBe(2);
    // The human-side facts this case used to observe through the unbounded
    // `GET /api/tasks` (retired in #task:1891) now live where they belong:
    // `taskJoinedToSummary`'s value wiring in `task-board.test.ts`, the newest-
    // first delivery order in the board column's ordering cases, and the
    // agent-created task's conversation/assignee refs in the cross-conversation
    // claim case below (which reads the agent list face).
  });

  // Count conversation messages by author kind — the falsifier for the
  // "one `task_create` system event, zero fabricated user message" invariant
  // and for "zero write" on a rejected create. Deltas, so onboarding seeds
  // never leak into the assertion.
  const countByKind = (conversationId: string, kind: string): number =>
    (
      t!.ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND from_kind = ?`,
        )
        .get(conversationId, kind) as { n: number }
    ).n;

  // Sibling falsifier for the TASK half of "zero write" on a rejected create.
  // Set-level ABSENCE has no read-face carrier (a rejected POST returns no id,
  // so a single-task read could only assert a tautology) — so it is asserted at
  // the layer that owns the fact. A conversation-scoped count delta is also
  // STRONGER than the title-absence check it replaces: it rejects "a row was
  // written under a different title" too.
  const countTasks = (conversationId: string): number =>
    (
      t!.ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE conversation_id = ?`)
        .get(conversationId) as { n: number }
    ).n;

  // Read ONE task's post-write state through the surviving single-task face.
  // The write-path cases below use it as their observation instrument (they used
  // to read the unbounded list and index `[0]`); a task id is the exact
  // scope those assertions mean, so this is the layer that owns the fact.
  const readTask = async (taskId: string): Promise<any> =>
    ((await (await http(t!).get(`/api/tasks/${taskId}`)).json()) as any).task;

  it('human POST /api/tasks returns only the created identity and never fabricates a user message', async () => {
    t = buildTestApp();
    const { conversationId, workspaceId } = await setup(t);
    const h = http(t);

    const userBefore = countByKind(conversationId, 'user');
    const sysBefore = countByKind(conversationId, 'system');
    const tasksBefore = countTasks(conversationId);

    const res = await h.post('/api/tasks', {
      title: 'panel-created task',
      body: 'from the task panel',
      conversation_id: conversationId,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created.success).toBe(true);
    // SUCCESS is the thin identity the create txn authoritatively produced —
    // the SAME shape agent create returns, NOT a post-commit detail re-read.
    expect(Object.keys(created.task).sort()).toEqual(['id', 'task_number', 'title']);
    expect(created.task.title).toBe('panel-created task');
    expect(typeof created.task.id).toBe('string');
    expect(typeof created.task.task_number).toBe('number');

    // Exactly one row — the positive arm of the same count the rejected-create
    // cases assert a zero delta on, so neither side can pass on a blind counter.
    expect(countTasks(conversationId) - tasksBefore).toBe(1);

    // Product contract: the create emits exactly one `task_create` SYSTEM event
    // and zero user-authored message (it is not a user post).
    expect(countByKind(conversationId, 'user') - userBefore).toBe(0);
    expect(countByKind(conversationId, 'system') - sysBefore).toBe(1);

    // The panel opens the modal by id; full detail comes from the normal read
    // path. Assert the sourceless / unassigned / user-attributed facts there.
    const detail = (
      (await (await http(t).get(`/api/tasks/${created.task.id}`)).json()) as any
    ).task;
    expect(detail.content).toBe('from the task panel');
    expect(detail.status).toBe('todo');
    expect(detail.assignee).toBeNull();
    expect(detail.board).toMatchObject({ kind: 'workspace', workspace_id: workspaceId });
    expect(detail.channel_id).toBe(conversationId);
    expect(detail.source_message_id).toBeNull();
    expect(detail.nav.kind).toBe('created_event');
    expect(detail.creator.type).toBe('user');
    expect(detail.creator.id).toBe(t!.viewerUserId);

    // Shows up on the human board — read through the BOUNDED `todo` column
    // (#task:1884), which is the human board's read face; the unbounded list no
    // longer exists (#task:1891). Narrower than the old check by
    // design: this asserts presence in one status column, not in the whole set.
    const column = (await (
      await http(t).get('/api/tasks/board/column?status=todo')
    ).json()) as any;
    expect(column.items.map((x: any) => x.title)).toContain('panel-created task');
  });

  it('human POST /api/tasks accepts an omitted body (detail content defaults to empty)', async () => {
    t = buildTestApp();
    const { conversationId } = await setup(t);
    const res = await http(t).post('/api/tasks', {
      title: 'no body',
      conversation_id: conversationId,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    const detail = (
      (await (await http(t).get(`/api/tasks/${created.task.id}`)).json()) as any
    ).task;
    expect(detail.content).toBe('');
  });

  it('human POST /api/tasks rejects a blank title or a missing conversation_id (400)', async () => {
    t = buildTestApp();
    const { conversationId } = await setup(t);
    const blankTitle = await http(t).post('/api/tasks', {
      title: '   ',
      conversation_id: conversationId,
    });
    expect(blankTitle.status).toBe(400);
    const noConversation = await http(t).post('/api/tasks', { title: 'ok' });
    expect(noConversation.status).toBe(400);
  });

  it('human POST /api/tasks is fail-closed and leaks no existence: known-non-member == unknown id', async () => {
    t = buildTestApp();
    const { conversationId } = await setup(t);

    // A REAL, existing conversation the viewer is no longer a member of.
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(conversationId, t.viewerUserId);

    const nonMember = await http(t).post('/api/tasks', {
      title: 'x',
      conversation_id: conversationId,
    });
    const unknown = await http(t).post('/api/tasks', {
      title: 'x',
      conversation_id: 'conversation-does-not-exist',
    });

    // Both 403 with the identical code — a caller cannot distinguish "exists but
    // you're not a member" from "does not exist".
    expect(nonMember.status).toBe(403);
    expect(unknown.status).toBe(403);
    const nm = (await nonMember.json()) as any;
    const uk = (await unknown.json()) as any;
    expect(nm).toEqual({ success: false, code: 'not_conversation_member' });
    expect(uk).toEqual({ success: false, code: 'not_conversation_member' });
  });

  it('human POST /api/tasks typed-rejects a closed conversation with zero write', async () => {
    t = buildTestApp();
    const { conversationId } = await setup(t);
    const sysBefore = countByKind(conversationId, 'system');
    const tasksBefore = countTasks(conversationId);
    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
      .run(Date.now(), conversationId);

    const res = await http(t).post('/api/tasks', {
      title: 'closed attempt',
      conversation_id: conversationId,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as any).toEqual({ success: false, code: 'conversation_closed' });
    // Zero task, zero event.
    expect(countTasks(conversationId) - tasksBefore).toBe(0);
    expect(countByKind(conversationId, 'system') - sysBefore).toBe(0);
  });

  it('human POST /api/tasks typed-rejects an ARCHIVED conversation with zero write (shared invariant, not human-only)', async () => {
    t = buildTestApp();
    const { conversationId } = await setup(t);
    const sysBefore = countByKind(conversationId, 'system');
    const tasksBefore = countTasks(conversationId);
    t.ctx.db
      .prepare(`UPDATE conversations SET archived_at = ? WHERE id = ?`)
      .run(Date.now(), conversationId);

    const res = await http(t).post('/api/tasks', {
      title: 'archived attempt',
      conversation_id: conversationId,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as any).toEqual({
      success: false,
      code: 'conversation_archived',
    });
    // Zero task, zero event — the reject happens in the shared service, so the
    // same invariant holds for the agent create path.
    expect(countTasks(conversationId) - tasksBefore).toBe(0);
    expect(countByKind(conversationId, 'system') - sysBefore).toBe(0);
  });

  it('claim_tasks wins the race once + second claimer fails', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'shared work' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;

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
    const claimed = await readTask(taskId);
    expect(claimed.status).toBe('in_progress');
    expect(claimed.assignee?.type).toBe('agent');
    expect(claimed.assignee?.id).toBe(agentIds.alice);
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
      { target: `#conv:${s1.sessionId}`, tasks: [{ title: 'in session 1' }] },
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
    expect(listed.tasks[0].channel_id).toBe(s1.sessionId);
    expect(listed.tasks[0].assignee?.id).toBe(s1.agentIds.bob);
  });

  it('update_status: assignee-only + transition rules', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${sessionId}`, tasks: [{ title: 'ship' }] },
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
        { target: `#conv:${sessionId}`, tasks: [{ title: 'review me' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;
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
      await http(t).post(`/api/tasks/${taskId}/status`, { status: 'done' })
    ).json() as any;
    expect(approve.success).toBe(true);

    expect((await readTask(taskId)).status).toBe('done');
  });

  it('publishes task_changed realtime events on claim', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
    const received: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribe(sessionId, e => received.push(e));

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${sessionId}`, tasks: [{ title: 'x' }] },
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

  it('fans task_changed to member viewer scope (board), not workspace scope (no private leak)', async () => {
    t = buildTestApp();
    const { sessionId, workspaceId, agentIds } = await setup(t);
    const h = http(t);

    const convScope: string[] = [];
    const wsScope: string[] = [];
    const memberViewer: string[] = []; // 'local' is a member (created the ws)
    const unsubConv = t.ctx.events.subscribe(sessionId, e => convScope.push(e.kind));
    const unsubWs = t.ctx.events.subscribeScope(
      `workspace:${workspaceId}`,
      e => wsScope.push(e.kind),
    );
    const unsubMember = t.ctx.events.subscribeScope(
      `viewer:${t.viewerUserId}`,
      e => memberViewer.push(e.kind),
    );

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${sessionId}`, tasks: [{ title: 'task board task' }] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );

    unsubConv();
    unsubWs();
    unsubMember();

    // The cross-conversation board fanout is member-gated, so task_changed goes
    // per-viewer to the channel's human members — NOT workspace-wide (which
    // would leak a private channel's task snapshot to every workspace member).
    expect(convScope.filter(k => k === 'task_changed')).toHaveLength(2);
    expect(wsScope.filter(k => k === 'task_changed')).toHaveLength(0);
    expect(memberViewer.filter(k => k === 'task_changed')).toHaveLength(2);
  });

  it('system messages fan out to every session member\'s inbox', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    t.fake.delivered = []; // clear setup noise

    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${sessionId}`, tasks: [{ title: 'shared work' }] },
    );
    // Both alice and bob should receive the system message via inbox.
    const recipients = new Set(t.fake.delivered.map(d => d.agentId));
    expect(recipients.has(agentIds.alice!)).toBe(true);
    expect(recipients.has(agentIds.bob!)).toBe(true);
  });

  it('human POST /api/tasks/:taskId/claim requires agent_id and DISPATCHES a todo task', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'plain' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;

    // `claim` assigns; it is no longer a second way to clear the assignee.
    const missing = await http(t).post(`/api/tasks/${taskId}/claim`, {});
    expect(missing.status).toBe(400);

    const claim = (await (
      await http(t).post(`/api/tasks/${taskId}/claim`, { agent_id: agentIds.bob })
    ).json()) as any;
    expect(claim.success).toBe(true);

    const dispatched = await readTask(taskId);
    // Assigning a `todo` task hands out the work, so the row leaves `todo` in the
    // same write — `todo + assignee` would have no legal exit for the assignee.
    expect(dispatched.status).toBe('in_progress');
    expect(dispatched.assignee?.id).toBe(agentIds.bob);
  });

  it('human POST /api/tasks/:taskId/unclaim clears the assignee and keeps in_review', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'review me' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/update-status`,
      { task_number: 1, status: 'in_review' },
    );

    const unclaim = (await (
      await http(t).post(`/api/tasks/${taskId}/unclaim`)
    ).json()) as any;
    expect(unclaim.success).toBe(true);

    const unclaimed = await readTask(taskId);
    expect(unclaimed.status).toBe('in_review');
    expect(unclaimed.assignee).toBeNull();
  });

  it('human POST /api/tasks/:taskId/unclaim on a done task → 409 task_done, task untouched', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'finished' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;
    await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1] },
    );
    await http(t).post(`/api/tasks/${taskId}/status`, { status: 'done' });

    const res = await http(t).post(`/api/tasks/${taskId}/unclaim`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('task_done');

    const untouched = await readTask(taskId);
    expect(untouched.status).toBe('done');
    expect(untouched.assignee?.id).toBe(agentIds.alice);
  });

  // Characterization for the P10 internal-agent factory move (#task:981):
  // pin the internal `tasks/unclaim` route (agentUnclaimConversationTask) at
  // the HTTP layer. Before this, only the *public* /api/tasks/:id/unclaim path
  // was covered — the agent-facing internal route (principal resolution →
  // canPostToConversation → UnclaimTaskInputSchema → taskService.unclaimTask)
  // had zero route-level coverage, so a verbatim relocation could break its
  // wiring while still typechecking. Negative arms (non-poster / not-assignee /
  // capability) stay covered at the service layer; this pins only the positive
  // route path that the move must preserve.
  it('internal POST .../tasks/unclaim returns a claimed task to todo (agent path)', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'unclaim me' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;
    const claim = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/claim`,
        { task_numbers: [1] },
      )
    ).json()) as any;
    expect(claim.results[0].success).toBe(true);
    // Sanity: claim auto-advanced to in_progress + assigned to alice.
    const afterClaim = await readTask(taskId);
    expect(afterClaim.status).toBe('in_progress');
    expect(afterClaim.assignee?.id).toBe(agentIds.alice);

    const res = await h.post(
      `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/unclaim`,
      { task_number: 1 },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);

    const afterUnclaim = await readTask(taskId);
    expect(afterUnclaim.status).toBe('todo');
    expect(afterUnclaim.assignee).toBeNull();
  });

  it('human POST /api/tasks/:taskId/status can jump to any non-current status', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'shortcut' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;

    const direct = (await (
      await http(t).post(`/api/tasks/${taskId}/status`, { status: 'done' })
    ).json()) as any;
    expect(direct.success).toBe(true);
    expect((await readTask(taskId)).status).toBe('done');
  });

  it('human POST /api/tasks/:taskId/status can close and reopen tasks', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
    const received: { kind: string; payload: unknown }[] = [];

    const created = (await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'file later' }] },
      )
    ).json()) as any;
    const taskId = created.tasks[0].id;
    const unsub = t.ctx.events.subscribe(sessionId, e => received.push(e));

    const closed = (await (
      await http(t).post(`/api/tasks/${taskId}/status`, { status: 'closed' })
    ).json()) as any;
    unsub();
    expect(closed.success).toBe(true);
    const taskChanged = received.filter(e => e.kind === 'task_changed');
    expect(taskChanged).toHaveLength(1);
    expect((taskChanged[0]!.payload as any)).toMatchObject({
      kind: 'status',
      task_id: taskId,
      status: 'closed',
      closed_at: expect.any(Number),
    });

    // Status + close timestamp are single-task facts, read from the single-task
    // face. Which status BUCKET a task lands in is the board column's contract
    // and is pinned there (task-board.test.ts), not re-derived from a filter here.
    expect(await readTask(taskId)).toMatchObject({
      id: taskId,
      title: 'file later',
      status: 'closed',
      closed_at: expect.any(Number),
    });

    const reopened = (await (
      await http(t).post(`/api/tasks/${taskId}/status`, { status: 'todo' })
    ).json()) as any;
    expect(reopened.success).toBe(true);
    const restored = await readTask(taskId);
    expect(restored.status).toBe('todo');
    expect(restored.closed_at).toBeNull();
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
        target: `#conv:${sessionId}`,
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

    // limit caps the row count without changing the ORDER (task_number DESC,
    // newest-first), so it returns the two highest-numbered tasks.
    const limited = (await (await h.get(`${listPath}?limit=2`)).json()) as any;
    expect(limited.tasks.map((x: any) => x.task_number)).toEqual([5, 4]);

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

describe('Task create/edit/detail routes', () => {
  let t: TestApp;
  afterEach(() => t?.cleanup());

  // Local mirror of the PR-T1 suite's helper (that one closes over its own
  // `t`). Counts conversation messages by author kind — the falsifier for
  // "zero write" on a rejected create and for "no reverse activity in the
  // origin" on a cross-channel create. Deltas, so onboarding seeds never leak.
  const countByKind = (conversationId: string, kind: string): number =>
    (
      t.ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND from_kind = ?`,
        )
        .get(conversationId, kind) as { n: number }
    ).n;

  it('agent create with source_message_id + claim links provenance and self-claims', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
    const src = await (
      await h.post(`/api/channels/${sessionId}/messages`, { content: 'prompt' })
    ).json() as any;

    const created = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        {
          target: `#conv:${sessionId}`,
          tasks: [{ title: 'derived', source_message_id: src.message.id }],
          claim: true,
        },
      )
    ).json() as any;
    const taskNumber = created.tasks[0].task_number;

    const detail = await (
      await h.get(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/detail?task_number=${taskNumber}`,
      )
    ).json() as any;
    expect(detail.task.source_message_id).toBe(src.message.id);
    expect(detail.task.status).toBe('in_progress');
    expect(detail.task.assignee.id).toBe(agentIds.alice);
  });

  it('second create from the same source → 200 typed source_conflict + existing_task', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
    const src = await (
      await h.post(`/api/channels/${sessionId}/messages`, { content: 'prompt' })
    ).json() as any;
    const createPath = `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`;
    const target = `#conv:${sessionId}`;
    const first = await (
      await h.post(createPath, {
        target,
        tasks: [{ title: 'first', source_message_id: src.message.id }],
      })
    ).json() as any;

    const res = await h.post(createPath, {
      target,
      tasks: [{ title: 'second', source_message_id: src.message.id }],
    });
    // The create route returns HTTP 200 with the typed envelope (mirroring
    // claim/status/edit) so the CLI reads the structured error + existing_task
    // from the body; the CLI then maps it to a non-zero exit itself.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBe('source_conflict');
    expect(body.existing_task.task_number).toBe(first.tasks[0].task_number);
  });

  // ── #task:1738 — agent cross-channel task create ──────────────────
  // An agent discussing in conversation A can file the task in another
  // conversation B by ADDRESSING B — since #task:2021 P4-4 there is no separate
  // destination field, so "cross-channel create" is not a mode: it is simply a
  // `target` that names a stream other than the one this session is anchored in.
  // Authorization is judged against the DESTINATION — the resolver answers
  // existence and participation, and the route adds the workspace axis (workspace
  // access + capability) — never the origin-bound global post/view predicates.
  // There is no legacy current-channel default left to omit the field into.

  it('agent create addressing another channel of the same workspace files it there; origin gets no activity', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds, workspaceId } = await setup(t);
    const h = http(t);
    // Destination channel B in the SAME workspace; alice is a member.
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;

    const sysABefore = countByKind(convA, 'system');
    const sysBBefore = countByKind(convB, 'system');

    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, tasks: [{ title: 'file me in B' }] },
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as any;
    expect(created.tasks).toHaveLength(1);

    // Row + number + workflow belong to B — read it back as a B member.
    const listedB = (await (
      await h.get(`/internal/conversations/${convB}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    const row = listedB.tasks.find((x: any) => x.title === 'file me in B');
    expect(row).toBeTruthy();
    expect(row.channel_id).toBe(convB);
    expect(row.board).toMatchObject({ kind: 'workspace', workspace_id: workspaceId });

    // The `task_create` system event lands in B; the origin A sees nothing.
    expect(countByKind(convB, 'system') - sysBBefore).toBe(1);
    expect(countByKind(convA, 'system') - sysABefore).toBe(0);
  });

  it('agent create addressing a DIFFERENT workspace succeeds; capability is judged by the destination workspace', async () => {
    t = buildTestApp();
    const { sessionId: convA, agentIds } = await setup(t);
    const h = http(t);
    // Second workspace where alice is a member; its onboarding channel is B.
    const ws2 = (await (
      await h.post('/api/workspaces', {
        name: 'eng2',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = ws2.onboarding_channel_id;

    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, tasks: [{ title: 'cross-ws' }] },
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as any;

    // Task lives in B's (other) workspace — success itself proves create_tasks
    // was judged against ws2, where alice is a member.
    const detail = (await (
      await h.get(
        `/internal/conversations/${convB}/agents/${agentIds.alice}/tasks/detail?task_number=${created.tasks[0].task_number}`,
      )
    ).json()) as any;
    expect(detail.task.title).toBe('cross-ws');
    const listedB = (await (
      await h.get(`/internal/conversations/${convB}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    expect(listedB.tasks.find((x: any) => x.title === 'cross-ws').board).toMatchObject({
      kind: 'workspace',
      workspace_id: ws2.workspace.id,
    });
  });

  it('agent create judges capability on the DESTINATION workspace: create_tasks held only in the ORIGIN does not authorize a create in B', async () => {
    t = buildTestApp();
    const { sessionId: convA, agentIds } = await setup(t);
    const h = http(t);
    // Second workspace B; alice is a member (default full caps in BOTH A and B).
    const ws2 = (await (
      await h.post('/api/workspaces', { name: 'eng2', member_agent_ids: [agentIds.alice] })
    ).json()) as any;
    const convB = ws2.onboarding_channel_id;
    // Narrow B's caps to everything EXCEPT create_tasks; leave A's full set
    // intact. This is the discriminating falsifier Cindy called out: if the
    // implementation mistakenly judged create_tasks against the ORIGIN (A),
    // alice still holds it there and the create would wrongly succeed.
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      ws2.workspace.id,
      agentIds.alice!,
      AGENT_CAPABILITIES.filter(cap => cap !== 'create_tasks'),
    );
    const sysBBefore = countByKind(convB, 'system');

    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, tasks: [{ title: 'blocked-by-B-caps' }] },
    );
    // Typed capability denial keyed to the missing bucket — never string-stuffed.
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'create_tasks',
      details: { capability: 'create_tasks' },
    });
    // Zero write in B.
    expect(countByKind(convB, 'system') - sysBBefore).toBe(0);
    const listedB = (await (
      await h.get(`/internal/conversations/${convB}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    expect(listedB.tasks.some((x: any) => x.title === 'blocked-by-B-caps')).toBe(false);
  });

  it('same-channel create --claim requires write_tasks: create_tasks without write_tasks rejects the self-claim with zero write', async () => {
    t = buildTestApp();
    const { sessionId: convA, agentIds, workspaceId } = await setup(t);
    const h = http(t);
    // Same-channel create+claim is the ONLY path `--claim` survives to the
    // write_tasks gate — a cross-channel `--claim` is refused earlier as
    // `cross_conversation_claim` (see the next test). Grant create_tasks but NOT
    // write_tasks in the (origin = destination) workspace: the create passes the
    // create_tasks gate, but the self-claim must be refused, with zero write.
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      workspaceId,
      agentIds.alice!,
      AGENT_CAPABILITIES.filter(cap => cap !== 'write_tasks'),
    );
    const sysBefore = countByKind(convA, 'system');

    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convA}`, claim: true, tasks: [{ title: 'claim-blocked' }] },
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'write_tasks',
      details: { capability: 'write_tasks' },
    });
    // The claim gate runs BEFORE createTasks, so nothing is written.
    expect(countByKind(convA, 'system') - sysBefore).toBe(0);
    const listed = (await (
      await h.get(`/internal/conversations/${convA}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    expect(listed.tasks.some((x: any) => x.title === 'claim-blocked')).toBe(false);
  });

  it('agent create addressing another conversation with --claim is refused as cross_conversation_claim: zero write', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds } = await setup(t);
    const h = http(t);
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;

    const sysABefore = countByKind(convA, 'system');
    const sysBBefore = countByKind(convB, 'system');

    // Cross-channel create is a DISPATCH — filed UNCLAIMED so a destination
    // member picks it up — so `--claim` (self-assign to the caller) is refused
    // with the typed op error and writes nothing.
    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, claim: true, tasks: [{ title: 'cross-claim' }] },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ error: 'cross_conversation_claim' });
    expect(countByKind(convB, 'system') - sysBBefore).toBe(0);
    expect(countByKind(convA, 'system') - sysABefore).toBe(0);
    const listedB = (await (
      await h.get(`/internal/conversations/${convB}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    expect(listedB.tasks.some((x: any) => x.title === 'cross-claim')).toBe(false);

    // A destination that does not resolve is answered by the RESOLVER, before the
    // claim conflict is even a question (#task:2021 P4-4 moved the conflict check
    // after resolution, because "another conversation" is a fact about the
    // RESOLVED stream). The old ordering existed to keep the conflict from
    // becoming an existence probe; that property is now structural instead —
    // unknown and unauthorized are byte-identical refusals — so the probe has
    // nothing to report either way. Proven below rather than assumed.
    const resUnknown = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${MISSING_ID}`, claim: true, tasks: [{ title: 'x' }] },
    );
    expect(resUnknown.status).toBe(404);
    expect((await resUnknown.json()) as any).toEqual({
      error: expect.any(String),
      code: 'target_unresolved',
    });
    expect(countByKind(convA, 'system') - sysABefore).toBe(0);
  });

  it('cross-channel create emits a `filed … from another conversation` narration + cross_conversation metadata bit; same-channel emits `created …` without it', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setup(t);
    const h = http(t);
    // Origin carries a uniquely identifiable sentinel title so the privacy
    // falsifier can prove that NO origin coordinate — id OR title — leaks into
    // the destination's narration or metadata.
    const ORIGIN_SENTINEL = 'ORIGIN-SENTINEL-DO-NOT-LEAK';
    const chOrigin = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: ORIGIN_SENTINEL,
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convA = chOrigin.channel.id;
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;

    // Newest system message's content + parsed metadata for a conversation. Both
    // faces (this agent-facing `content` string and the desktop enriched row)
    // derive their wording from the SAME `cross_conversation` metadata bit; the
    // bit carries NO origin id/title, so neither content nor metadata may name A.
    const latestSystem = (conversationId: string) =>
      t.ctx.db
        .prepare(
          `SELECT content, metadata FROM messages
             WHERE conversation_id = ? AND from_kind = 'system'
             ORDER BY seq DESC LIMIT 1`,
        )
        .get(conversationId) as { content: string; metadata: string | null };

    // Cross-channel create (from A into B). The narration is conversation-neutral
    // ("here from another conversation") because the destination may be a DM, not
    // just a channel — the contract is a conversation.
    await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, tasks: [{ title: 'ship it' }] },
    );
    const crossMsg = latestSystem(convB);
    expect(crossMsg.content).toMatch(
      / filed task #\d+ "ship it" here from another conversation$/,
    );
    const crossMeta = JSON.parse(crossMsg.metadata!) as Record<string, unknown>;
    expect(crossMeta.cross_conversation).toBe(true);

    // Privacy invariant — TWO orthogonal layers, each checked against BOTH the
    // agent-facing content string AND the serialized metadata: neither the origin
    // conversation id NOR its (sentinel) title may appear anywhere.
    for (const leak of [convA, ORIGIN_SENTINEL]) {
      expect(crossMsg.content.includes(leak)).toBe(false);
      expect(crossMsg.metadata!.includes(leak)).toBe(false);
    }

    // Same-channel create (in A): classic `created` narration, no cross bit.
    await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convA}`, tasks: [{ title: 'local task' }] },
    );
    const sameMsg = latestSystem(convA);
    expect(sameMsg.content).toMatch(/ created task #\d+ "local task"$/);
    const sameMeta = JSON.parse(sameMsg.metadata!) as Record<string, unknown>;
    expect(sameMeta.cross_conversation).toBeUndefined();

    // Structural falsifier: the ONLY thing the cross-conversation bit adds over an
    // ordinary create's metadata is `cross_conversation` — no origin / source
    // conversation coordinate key sneaks in alongside it, in either direction.
    const addedKeys = Object.keys(crossMeta).filter(k => !(k in sameMeta));
    const removedKeys = Object.keys(sameMeta).filter(k => !(k in crossMeta));
    expect(addedKeys).toEqual(['cross_conversation']);
    expect(removedKeys).toEqual([]);
  });

  it('agent create is fail-closed on the address: unknown id, non-participant channel, and non-workspace conversation all return the SAME refusal with zero write', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds } = await setup(t);
    const h = http(t);
    const createFromA = `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`;

    // (1) An id no conversation has.
    const unknown = await h.post(createFromA, {
      target: `#conv:${MISSING_ID}`,
      tasks: [{ title: 'nope' }],
    });

    // (2) Real channel in alice's OWN workspace that alice is NOT a participant of.
    const chC = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-c',
        member_agent_ids: [agentIds.bob],
      })
    ).json()) as any;
    const convC = chC.channel.id;
    const sysCBefore = countByKind(convC, 'system');
    const nonChannelMember = await h.post(createFromA, {
      target: `#conv:${convC}`,
      tasks: [{ title: 'nope' }],
    });

    // (3) Real conversation in a workspace alice has no access to at all.
    const ws2 = (await (
      await h.post('/api/workspaces', { name: 'eng2', member_agent_ids: [agentIds.bob] })
    ).json()) as any;
    const nonWsMember = await h.post(createFromA, {
      target: `#conv:${ws2.onboarding_channel_id}`,
      tasks: [{ title: 'nope' }],
    });

    // All three collapse to ONE answer, and since #task:2021 P4-4 that collapse is
    // STRUCTURAL rather than three matching branches: participation is the ONE
    // authority the resolver consults, so "unknown" and "exists but not yours"
    // stop being separable questions before the route sees them. Bodies compared
    // as BYTES — an extra key or a different field order would be enough to tell
    // the three apart, and comparing parsed objects would not see it.
    const bodies: string[] = [];
    for (const r of [unknown, nonChannelMember, nonWsMember]) {
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({
      error: expect.any(String),
      code: 'target_unresolved',
    });
    // Zero write in the real-but-unreachable destination.
    expect(countByKind(convC, 'system') - sysCBefore).toBe(0);
  });

  it('a /thread: suffix files the task in that cluster; a mid-cluster reply id is refused, not widened', async () => {
    t = buildTestApp();
    const { sessionId: conv, agentIds } = await setup(t);
    const h = http(t);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: conv,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'cluster root',
    });
    const reply = messages.insertForConversation({
      conversationId: conv,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'a reply inside the cluster',
      threadRootId: root.id,
    });
    const listTasks = async (): Promise<any[]> =>
      (
        (await (
          await h.get(`/internal/conversations/${conv}/agents/${agentIds.alice}/tasks`)
        ).json()) as any
      ).tasks;

    // The ROOT: the suffix survives resolution and reaches the aggregate as the
    // task's cluster.
    const ok = await h.post(
      `/internal/conversations/${conv}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${conv}/thread:${root.id}`, tasks: [{ title: 'in the cluster' }] },
    );
    expect(ok.status).toBe(200);
    expect((await listTasks()).find(x => x.title === 'in the cluster').thread_root_id).toBe(
      root.id,
    );

    const sysBefore = countByKind(conv, 'system');

    // A REPLY inside the same cluster is refused rather than widened to its root.
    // This is the load-bearing half: widening would let two different addresses
    // name the same stream, and the id an agent copied out of a reply's header
    // would silently mean something it does not say. It is the RESOLVER's answer
    // (`thread_not_in_target`) — the task aggregate no longer looks messages up,
    // so there is no second opinion left to disagree with it.
    for (const rootish of [reply.id, MISSING_ID]) {
      const res = await h.post(
        `/internal/conversations/${conv}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${conv}/thread:${rootish}`, tasks: [{ title: 'must not be born' }] },
      );
      expect(res.status, rootish).toBe(404);
      expect((await res.json()) as any).toEqual({
        error: expect.any(String),
        code: 'thread_not_in_target',
      });
    }
    // Zero write: no task row reachable on the board, and no `task_create` event.
    expect((await listTasks()).some(x => x.title === 'must not be born')).toBe(false);
    expect(countByKind(conv, 'system') - sysBefore).toBe(0);
  });

  it('agent create with a source in the ORIGIN and the task addressed to the DESTINATION → source_conversation_mismatch with zero write', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds } = await setup(t);
    const h = http(t);
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;
    // The source message lives in the ORIGIN (A); the task is filed to B.
    const src = (await (
      await h.post(`/api/channels/${convA}/messages`, { content: 'prompt in A' })
    ).json()) as any;
    const sysBBefore = countByKind(convB, 'system');

    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      {
        target: `#conv:${convB}`,
        tasks: [{ title: 'derived', source_message_id: src.message.id }],
      },
    );
    // Typed envelope on 200 (mirrors source_conflict), never an HTTP throw.
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ error: 'source_conversation_mismatch' });
    // Zero task + zero event in the destination.
    expect(countByKind(convB, 'system') - sysBBefore).toBe(0);
    const listedB = (await (
      await h.get(`/internal/conversations/${convB}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    expect(listedB.tasks.some((x: any) => x.title === 'derived')).toBe(false);
  });

  it('cross-channel create emits one task_cross_op audit line; same-conversation (default) create emits none', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds } = await setup(t);
    const h = http(t);
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;
    const createFromA = `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`;
    const isCreateAudit = (call: unknown[]): boolean =>
      (call[0] as any)?.op === 'task_cross_op' && (call[0] as any)?.action === 'create';

    // Cross-channel: exactly one audit line, source = A, owner = B.
    const crossSpy = vi.spyOn(t.ctx.logger, 'warn');
    await h.post(createFromA, { target: `#conv:${convB}`, tasks: [{ title: 'x-audit' }] });
    const crossCalls = crossSpy.mock.calls.filter(isCreateAudit);
    crossSpy.mockRestore();
    expect(crossCalls).toHaveLength(1);
    expect(crossCalls[0]?.[0]).toMatchObject({
      action: 'create',
      source_conversation_id: convA,
      owner_conversation_id: convB,
    });

    // Same-conversation default: no cross-op audit (sourceConv === ownerConv).
    const sameSpy = vi.spyOn(t.ctx.logger, 'warn');
    await h.post(createFromA, { target: `#conv:${convA}`, tasks: [{ title: 'same-audit' }] });
    const sameCalls = sameSpy.mock.calls.filter(isCreateAudit);
    sameSpy.mockRestore();
    expect(sameCalls).toHaveLength(0);
  });

  it('a successful cross-channel create does NOT relax the origin-bound global post/view predicates against the destination', async () => {
    t = buildTestApp();
    const { sessionId: convA, channelId, agentIds } = await setup(t);
    const h = http(t);
    const chB = (await (
      await h.post(`/api/workspaces/${channelId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [agentIds.alice],
      })
    ).json()) as any;
    const convB = chB.channel.id;

    // Cross-channel create succeeds (narrow, create-specific authorization)…
    const res = await h.post(
      `/internal/conversations/${convA}/agents/${agentIds.alice}/tasks/create`,
      { target: `#conv:${convB}`, tasks: [{ title: 'ok' }] },
    );
    expect(res.status).toBe(200);

    // …yet the agent's ORIGIN-A principal still cannot post to / view B through
    // the global predicates the ~90 other call sites share: they remain
    // origin-bound (require principal.conversationId === conversation.id), so
    // even though alice IS a member of B, an A-origin principal is refused. This
    // proves create used a separate narrow check and did NOT widen these.
    const originAPrincipal: AgentPrincipal = {
      kind: 'agent',
      agentId: agentIds.alice!,
      conversationId: convA,
    };
    expect(canPostToConversation(t.ctx, originAPrincipal, convB)).toBe(false);
    expect(canViewConversation(t.ctx, originAPrincipal, convB)).toBe(false);
  });

  it('human edit + detail round-trips', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setup(t);
    const h = http(t);
    const created = await (
      await h.post(
        `/internal/conversations/${sessionId}/agents/${agentIds.alice}/tasks/create`,
        { target: `#conv:${sessionId}`, tasks: [{ title: 'orig', body: 'orig body' }] },
      )
    ).json() as any;
    const taskId = created.tasks[0].id;

    const edited = await h.post(`/api/tasks/${taskId}/edit`, {
      title: 'human title',
    });
    expect(edited.status).toBe(200);

    const detail = await (await h.get(`/api/tasks/${taskId}`)).json() as any;
    expect(detail.task.title).toBe('human title');
    expect(detail.task.content).toBe('orig body');
  });

  // ── GET /api/tasks/by-number (#task:1891) ──────────────────────────
  //
  // The human point lookup by the workspace-scoped BUSINESS key, which the
  // inline `#task:<n>` sigil is the caller for. It is the only human face that
  // can answer `(workspace_id, task_number)`: the board columns are
  // status-partitioned and carry no number axis, and `GET /api/tasks/:taskId`
  // needs an id the sigil does not have.
  describe('GET /api/tasks/by-number', () => {
    /** Create one workspace + one agent task in it, and return the ids/numbers
     *  the assertions need. `member` / `workspaceName` are parameters because
     *  both are unique per app: the two-workspace case seeds twice in ONE app. */
    const seedTask = async (
      app: TestApp,
      title: string,
      member = 'alice',
      workspaceName = 'eng',
    ): Promise<{ workspaceId: string; conversationId: string; taskId: string; taskNumber: number }> => {
      const { workspaceId, conversationId, agentIds } = await setup(app, [member], workspaceName);
      const created = (await (
        await http(app).post(
          `/internal/conversations/${conversationId}/agents/${agentIds[member]}/tasks/create`,
          { target: `#conv:${conversationId}`, tasks: [{ title }] },
        )
      ).json()) as any;
      return {
        workspaceId,
        conversationId,
        taskId: created.tasks[0].id,
        taskNumber: created.tasks[0].task_number,
      };
    };

    it('resolves the business key to that one task', async () => {
      t = buildTestApp();
      const { workspaceId, conversationId, taskId, taskNumber } = await seedTask(t, 'sigil target');

      const res = await http(t).get(
        `/api/tasks/by-number?workspace_id=${workspaceId}&task_number=${taskNumber}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.task).toMatchObject({
        id: taskId,
        task_number: taskNumber,
        title: 'sigil target',
        board: { kind: 'workspace', workspace_id: workspaceId },
        channel_id: conversationId,
        status: 'todo',
      });
      // A summary, not a detail: one message can carry many sigils, so the face
      // deliberately ships neither the full body nor a per-viewer `nav`.
      expect(body.task.content).toBeUndefined();
      expect(body.task.nav).toBeUndefined();
    });

    it('is keyed by workspace, not by number alone: the same number in two workspaces resolves separately', async () => {
      // task_number is a PER-WORKSPACE sequence, so #1 exists in both places.
      // This is the falsifier for a lookup that ignores the workspace half of
      // the key and happens to pass the single-workspace case above.
      t = buildTestApp();
      const a = await seedTask(t, 'task in A', 'alice', 'eng');
      const b = await seedTask(t, 'task in B', 'bob', 'design');
      expect(a.taskNumber).toBe(b.taskNumber);
      expect(a.workspaceId).not.toBe(b.workspaceId);

      const inA = (await (
        await http(t).get(
          `/api/tasks/by-number?workspace_id=${a.workspaceId}&task_number=${a.taskNumber}`,
        )
      ).json()) as any;
      const inB = (await (
        await http(t).get(
          `/api/tasks/by-number?workspace_id=${b.workspaceId}&task_number=${b.taskNumber}`,
        )
      ).json()) as any;
      expect(inA.task.id).toBe(a.taskId);
      expect(inB.task.id).toBe(b.taskId);
    });

    it('is fail-closed and leaks no existence: an unallocated number and a task the viewer cannot see are the SAME 404', async () => {
      t = buildTestApp();
      const { workspaceId, conversationId, taskNumber } = await seedTask(t, 'hidden');

      const unallocated = await http(t).get(
        `/api/tasks/by-number?workspace_id=${workspaceId}&task_number=${taskNumber + 999}`,
      );

      // A REAL task, in the workspace the caller correctly names, whose
      // conversation the viewer is no longer a member of. Naming the right
      // workspace must not confirm that the number exists in it — the gate is
      // the viewer's visibility of the task's own conversation, and the query's
      // `workspace_id` is never taken as an authorized scope.
      t.ctx.db
        .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
        .run(conversationId, t.viewerUserId);
      const invisible = await http(t).get(
        `/api/tasks/by-number?workspace_id=${workspaceId}&task_number=${taskNumber}`,
      );

      expect(unallocated.status).toBe(404);
      expect(invisible.status).toBe(404);
      expect(await unallocated.json()).toEqual(await invisible.json());
    });

    it('400s a query missing or malformed on either axis — not a 404', async () => {
      // A question this face cannot answer is NOT "no such task": the renderer
      // resolves 404 to a cached `null` (inert sigil), so a bad request that
      // returned 404 would be cached as a definitive miss.
      t = buildTestApp();
      const { workspaceId, taskNumber } = await seedTask(t, 'anything');
      const h = http(t);

      for (const qs of [
        `task_number=${taskNumber}`,
        `workspace_id=${workspaceId}`,
        `workspace_id=${workspaceId}&task_number=0`,
        `workspace_id=${workspaceId}&task_number=-1`,
        `workspace_id=${workspaceId}&task_number=1.5`,
        `workspace_id=${workspaceId}&task_number=abc`,
        `workspace_id=&task_number=${taskNumber}`,
      ]) {
        const res = await h.get(`/api/tasks/by-number?${qs}`);
        expect(res.status, qs).toBe(400);
      }
    });

    it('is not shadowed by the single-task id route', async () => {
      // `/api/tasks/:taskId` would swallow the literal `by-number` segment if it
      // were registered first; the 404-vs-400 distinction proves which handler
      // ran (the id route has no query contract to violate).
      t = buildTestApp();
      await seedTask(t, 'ordering');
      const res = await http(t).get('/api/tasks/by-number');
      expect(res.status).toBe(400);
    });

    it('answers with ONE summary read and never through the resolved/detail read path', async () => {
      // The mechanical criterion behind "bounded" (#task:1891). The wire shape
      // cannot carry this fact: a face that resolves the number through the
      // mutation-path column set (which selects `t.content`) and then re-reads
      // the row to project a summary returns a byte-identical body while paying
      // two queries and one unwanted body PER PILL — and a message can carry
      // many sigils. So assert what actually executed.
      t = buildTestApp();
      const { workspaceId, taskNumber } = await seedTask(t, 'observed');

      // `slowStatementMs: 0` makes every observed statement log, which turns the
      // observability layer into an executed-query recorder. Filtering on the
      // `tasks.` prefix is sound because the task repo owns that prefix; the
      // viewer-visibility membership gate runs through the observed narrow port
      // (`tasks.conversation_user_access`), so it appears once alongside the
      // single summary read.
      const executed: string[] = [];
      configureDatabaseObservation(t.ctx.db, {
        slowStatementMs: 0,
        logger: {
          info: () => undefined,
          error: () => undefined,
          warn: (obj: unknown) => {
            const name = (obj as { queryName?: string }).queryName;
            if (name?.startsWith('tasks.')) executed.push(name);
          },
        },
      });

      const res = await http(t).get(
        `/api/tasks/by-number?workspace_id=${workspaceId}&task_number=${taskNumber}`,
      );

      expect(res.status).toBe(200);
      expect(executed).toEqual(['tasks.get_joined_by_number', 'tasks.conversation_user_access']);
    });
  });
});
