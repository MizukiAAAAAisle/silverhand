import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Human composer `Send as task` (#task:1124): a single canonical message row
// that is BOTH the chat message and an open todo task anchor. Contract:
//  - the row is a real send (enters the stream, advances freshness);
//  - it becomes an OPEN todo task (status=todo, NO assignee) — never the
//    claim-promote shape (in_progress + assignee=claimer);
//  - title = first line of the body;
//  - NO separate "created task #N" system message — the row is the
//    announcement; the board is its projection, fed by a `task_changed` event.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
): Promise<{ workspaceId: string; channelId: string }> {
  const aliceId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-send-as-task',
      member_agent_ids: [aliceId],
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.resolvedRuns = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
  };
}

function countSystemMessages(t: TestApp, channelId: string): number {
  const row = t.ctx.db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE conversation_id = ? AND from_kind = 'system'`,
    )
    .get(channelId);
  return row?.n ?? 0;
}

describe('human Send as task', () => {
  let t: TestApp;
  afterEach(() => t?.cleanup());

  it('promotes the sent message into an open todo task (no claim-promote contamination)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const res = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'Fix the flaky login test\nmore detail in the body',
      as_task: true,
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as any;

    expect(message.task_number).toEqual(expect.any(Number));
    expect(message.task_status).toBe('todo');
    expect(message.task_assignee).toBeNull();
    expect(message.task_closed_at).toBeNull();
    // Title = first line of the body, not the whole content.
    expect(message.task_title).toBe('Fix the flaky login test');
  });

  it('does not create a separate task-created system message (one canonical row)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    // Channel creation seeds an onboarding system message; snapshot it so we
    // assert the send adds NO further system row (no task-created announce).
    const systemBefore = countSystemMessages(t, channelId);
    const events: Array<{ kind: string; payload: any }> = [];
    const unsub = t.ctx.events.subscribe(channelId, e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    const res = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'Ship the release notes',
      as_task: true,
    });
    unsub();
    expect(res.status).toBe(201);

    // The send wrote no new system row (a task-created announcement would be
    // one); the user's task row is the announcement.
    expect(countSystemMessages(t, channelId)).toBe(systemBefore);
    expect(
      events.some(
        e => e.kind === 'message' && e.payload?.message?.from_kind === 'system',
      ),
    ).toBe(false);
  });

  it('publishes a task_changed (create) event so the board surfaces it', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const events: Array<{ kind: string; payload: any }> = [];
    const unsub = t.ctx.events.subscribe(channelId, e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    const res = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'Audit the auth boundary',
      as_task: true,
    });
    unsub();
    const { message } = (await res.json()) as any;

    const taskChanged = events.filter(e => e.kind === 'task_changed');
    expect(taskChanged).toHaveLength(1);
    expect(taskChanged[0]!.payload).toMatchObject({
      kind: 'create',
      message_id: message.id,
      status: 'todo',
      assignee: null,
      task_number: message.task_number,
    });
  });

  it('a plain send (no as_task) creates no task', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const res = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'just chatting',
    });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as any;
    expect(message.task_number).toBeNull();
    expect(message.task_status).toBeNull();
  });

  it('keeps a thread reply Send-as-task in the reply-cluster (no promotion to main line)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    // Root on the main line, then a `Send as task` reply into its cluster.
    const root = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'root of the thread',
      })
    ).json()) as any;
    expect(root.message.thread_root_id).toBeNull();

    const systemBefore = countSystemMessages(t, channelId);
    const events: Array<{ kind: string; payload: any }> = [];
    const unsub = t.ctx.events.subscribe(channelId, e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    const res = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'investigate the regression\nrepro steps in body',
      as_task: true,
      reply_to_message_id: root.message.id,
    });
    unsub();
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as any;

    // The task message stays a reply in the same cluster — NOT lifted to the
    // main line — while still becoming an open todo.
    expect(message.thread_root_id).toBe(root.message.id);
    expect(message.task_status).toBe('todo');
    expect(message.task_assignee).toBeNull();
    expect(message.task_title).toBe('investigate the regression');

    // The board event carries the cluster root, so the task surfaces under the
    // thread rather than the channel main line.
    const taskChanged = events.filter(e => e.kind === 'task_changed');
    expect(taskChanged).toHaveLength(1);
    expect(taskChanged[0]!.payload).toMatchObject({
      kind: 'create',
      message_id: message.id,
      status: 'todo',
      thread_root_id: root.message.id,
    });

    // Still one canonical row — no task-created system announcement.
    expect(countSystemMessages(t, channelId)).toBe(systemBefore);
  });

  it('allocates monotonically increasing task numbers across sends', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const first = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'first task',
        as_task: true,
      })
    ).json()) as any;
    const second = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'second task',
        as_task: true,
      })
    ).json()) as any;

    expect(second.message.task_number).toBe(first.message.task_number + 1);
  });
});
