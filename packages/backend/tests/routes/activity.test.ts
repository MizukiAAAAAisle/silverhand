import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// #task:1227 ②c — the Activity list (`listActivity` read-model + GET /api/activity).
// Drives real message sends (so mention_self / unread come from the production
// emission paths) and asserts the projection: enter() gating, §7 dedup, §8 net
// ambient count, salience sort, and the owned-state auth gate.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(t: TestApp): Promise<{
  workspaceId: string;
  channelId: string;
  aliceId: string;
}> {
  const aliceId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-activity',
      member_agent_ids: [aliceId],
    })
  ).json()) as any;
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    aliceId,
  };
}

/** Send a message as an agent through the real service (exercises mention_self
 *  emission + stream-head advance), returning the created message id. */
async function sendAsAgent(
  t: TestApp,
  channelId: string,
  agentId: string,
  content: string,
): Promise<string> {
  const result = await t.ctx.conversationMessageService.sendMessage({
    conversationId: channelId,
    actor: { kind: 'agent', agentId, conversationId: channelId },
    content,
  });
  return result.message.id;
}

async function getActivity(t: TestApp): Promise<any[]> {
  const res = await http(t).get('/api/activity');
  expect(res.status).toBe(200);
  const dto = (await res.json()) as any;
  return dto.items;
}

describe('activity list (#task:1227 ②c GET /api/activity)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('a human @-mention enters as a directed mention item', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const aliceId = (await makeAgent(t, 'alice2')); // ensure a distinct sender agent exists
    const msgId = await sendAsAgent(
      t,
      channelId,
      // the channel snapshots the workspace agents; reuse the member alice
      (await firstChannelAgent(t, channelId)) ?? aliceId,
      'hey @local-test can you look?',
    );

    const items = await getActivity(t);
    const mentions = items.filter(i => i.kind === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      kind: 'mention',
      salience: 'directed',
      conversation_id: channelId,
      message_id: msgId,
      thread_root_id: null,
    });
    // §8 worked edge: the only unread IS the mention → no ambient row for it.
    expect(items.some(i => i.kind === 'unread' && i.conversation_id === channelId)).toBe(
      false,
    );
  });

  it('ambient channel unread is gated by the attention preference (enter())', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    // A plain (non-mention) message → ambient unread for the viewer.
    await sendAsAgent(t, channelId, sender, 'just chatting, no mention here');

    // Default pref = 'mentions' (ambient off) → NOT in Activity.
    let items = await getActivity(t);
    expect(items.some(i => i.kind === 'unread')).toBe(false);

    // Flip to 'all' (ambient on) → the channel mainline unread enters.
    const put = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'all' },
    );
    expect(put.status).toBe(200);

    items = await getActivity(t);
    const ambient = items.filter(i => i.kind === 'unread');
    expect(ambient).toHaveLength(1);
    expect(ambient[0]).toMatchObject({
      kind: 'unread',
      salience: 'ambient',
      conversation_id: channelId,
      thread_root_id: null,
      unread_count: 1,
    });
  });

  it('nets directed claims out of the ambient count (§8) and sorts directed first', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    // 1 mention + 2 plain unread.
    const mentionMsg = await sendAsAgent(t, channelId, sender, 'ping @local-test');
    await sendAsAgent(t, channelId, sender, 'plain one');
    await sendAsAgent(t, channelId, sender, 'plain two');

    await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
      mode: 'all',
    });

    const items = await getActivity(t);
    // 3 unread total, 1 is the mention → ambient count = 2 (positional \ directed).
    const ambient = items.filter(i => i.kind === 'unread');
    expect(ambient).toHaveLength(1);
    expect(ambient[0].unread_count).toBe(2);
    const mention = items.filter(i => i.kind === 'mention');
    expect(mention).toHaveLength(1);
    expect(mention[0].message_id).toBe(mentionMsg);
    // Directed tier sorts above ambient.
    expect(items[0].salience).toBe('directed');
    expect(items[items.length - 1].salience).toBe('ambient');
  });

  it('a task assigned to the viewer enters as a resolve-cleared task item', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'work item seed');
    // Project a task assigned to the viewer onto that message (the read-model
    // reads messages.task_* — seeding the source directly is a valid
    // characterization of the projection).
    t.ctx.db
      .prepare(
        `UPDATE messages
            SET task_number = 7, task_status = 'in_progress',
                task_assignee_user_id = 'local', task_workspace_id = ?,
                task_title = 'fix the thing'
          WHERE id = ?`,
      )
      .run(workspaceId, msgId);

    const items = await getActivity(t);
    const tasks = items.filter(i => i.kind === 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'task',
      salience: 'directed',
      task_number: 7,
      task_status: 'in_progress',
      conversation_id: channelId,
      message_id: msgId,
    });
    // The task's own message is no longer double-counted as ambient (§7).
    await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
      mode: 'all',
    });
    const after = await getActivity(t);
    expect(after.some(i => i.kind === 'unread' && i.conversation_id === channelId)).toBe(
      false,
    );
  });

  it('done/closed tasks do not enter (needs-action only)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'finished work');
    t.ctx.db
      .prepare(
        `UPDATE messages
            SET task_number = 8, task_status = 'done',
                task_assignee_user_id = 'local', task_workspace_id = ?,
                task_title = 'already done'
          WHERE id = ?`,
      )
      .run(workspaceId, msgId);

    const items = await getActivity(t);
    expect(items.some(i => i.kind === 'task')).toBe(false);
  });

  it('scopes to a workspace when ?workspace_id is given', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, a.channelId))!;
    await sendAsAgent(t, a.channelId, sender, 'mention @local-test in ws A');

    // A second workspace with its own mention.
    const bAlice = await makeAgent(t, 'beth');
    const wsB = (await (
      await http(t).post('/api/workspaces', {
        name: 'ws-activity-b',
        member_agent_ids: [bAlice],
      })
    ).json()) as any;
    const bChannel = wsB.onboarding_channel_id as string;
    const bSender = (await firstChannelAgent(t, bChannel))!;
    await sendAsAgent(t, bChannel, bSender, 'mention @local-test in ws B');

    const scoped = (await (
      await http(t).get(`/api/activity?workspace_id=${a.workspaceId}`)
    ).json()) as any;
    expect(scoped.items.every((i: any) => i.workspace_id === a.workspaceId)).toBe(true);
    expect(scoped.items.some((i: any) => i.conversation_id === a.channelId)).toBe(true);
    expect(scoped.items.some((i: any) => i.conversation_id === bChannel)).toBe(false);

    // Unscoped sees both.
    const all = await getActivity(t);
    expect(all.some(i => i.conversation_id === a.channelId)).toBe(true);
    expect(all.some(i => i.conversation_id === bChannel)).toBe(true);
  });

  it('an in_review task enters for a conversation member who is not the assignee', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'please review my work');
    // Assigned to a DIFFERENT principal, status in_review — the viewer ('local')
    // is a channel member but not the assignee. Per shiki 2026-06-25, in_review
    // tasks awaiting validation are first-class Activity events for members.
    t.ctx.db
      .prepare(
        `UPDATE messages
            SET task_number = 11, task_status = 'in_review',
                task_assignee_user_id = 'someone-else', task_workspace_id = ?,
                task_title = 'awaiting validation'
          WHERE id = ?`,
      )
      .run(workspaceId, msgId);

    const items = await getActivity(t);
    const tasks = items.filter(i => i.kind === 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      task_number: 11,
      task_status: 'in_review',
      conversation_id: channelId,
    });
  });

  it('a task does not leak to a non-member of its conversation (visibility gate)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'work needing review');
    t.ctx.db
      .prepare(
        `UPDATE messages
            SET task_number = 12, task_status = 'in_review',
                task_assignee_user_id = 'someone-else', task_workspace_id = ?,
                task_title = 'visible to members only'
          WHERE id = ?`,
      )
      .run(workspaceId, msgId);

    // Member sees it…
    expect((await getActivity(t)).some(i => i.kind === 'task')).toBe(true);

    // …drop the viewer's membership of that conversation → it must disappear
    // (both task branches are membership-gated, no info leak).
    t.ctx.db
      .prepare(
        `DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`,
      )
      .run(channelId);
    expect((await getActivity(t)).some(i => i.kind === 'task')).toBe(false);
  });

  it('a mention and a task on the SAME message yield one item (task wins, §7)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'ping @local-test review this');
    t.ctx.db
      .prepare(
        `UPDATE messages
            SET task_number = 13, task_status = 'in_progress',
                task_assignee_user_id = 'local', task_workspace_id = ?,
                task_title = 'mention + task'
          WHERE id = ?`,
      )
      .run(workspaceId, msgId);

    const items = await getActivity(t);
    const onThatMessage = items.filter(i => i.message_id === msgId);
    expect(onThatMessage).toHaveLength(1);
    expect(onThatMessage[0].kind).toBe('task');
    expect(items.some(i => i.kind === 'mention' && i.message_id === msgId)).toBe(false);
  });

  it('task ids are globally unique across workspaces with the same task_number', async () => {
    t = buildTestApp();
    const a = await createWorkspaceChannel(t);
    const aSender = (await firstChannelAgent(t, a.channelId))!;
    const aMsg = await sendAsAgent(t, a.channelId, aSender, 'task in ws A');
    t.ctx.db
      .prepare(
        `UPDATE messages SET task_number = 7, task_status = 'in_review',
            task_assignee_user_id = 'someone-else', task_workspace_id = ?,
            task_title = 'A7' WHERE id = ?`,
      )
      .run(a.workspaceId, aMsg);

    const bAlice = await makeAgent(t, 'beth');
    const wsB = (await (
      await http(t).post('/api/workspaces', {
        name: 'ws-activity-b',
        member_agent_ids: [bAlice],
      })
    ).json()) as any;
    const bChannel = wsB.onboarding_channel_id as string;
    const bWorkspace = wsB.workspace.id as string;
    const bSender = (await firstChannelAgent(t, bChannel))!;
    const bMsg = await sendAsAgent(t, bChannel, bSender, 'task in ws B');
    t.ctx.db
      .prepare(
        `UPDATE messages SET task_number = 7, task_status = 'in_review',
            task_assignee_user_id = 'someone-else', task_workspace_id = ?,
            task_title = 'B7' WHERE id = ?`,
      )
      .run(bWorkspace, bMsg);

    const tasks = (await getActivity(t)).filter(i => i.kind === 'task');
    expect(tasks).toHaveLength(2);
    const ids = new Set(tasks.map(i => i.id));
    expect(ids.size).toBe(2); // both task_number=7 but distinct ids
    expect(ids.has(`task:${a.workspaceId}:7`)).toBe(true);
    expect(ids.has(`task:${bWorkspace}:7`)).toBe(true);
  });

  it('ambient anchor is the first NON-directed unread when a mention is first (§8)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    // mention is the LOWEST-seq unread; a plain message follows it.
    await sendAsAgent(t, channelId, sender, 'ping @local-test');
    const plainMsg = await sendAsAgent(t, channelId, sender, 'plain follow-up');

    await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
      mode: 'all',
    });

    const items = await getActivity(t);
    const ambient = items.filter(i => i.kind === 'unread');
    expect(ambient).toHaveLength(1);
    // Anchor must skip the mention (already a directed item) and point at the
    // first non-directed unread — count net of the mention too.
    expect(ambient[0].message_id).toBe(plainMsg);
    expect(ambient[0].unread_count).toBe(1);
  });

  it('a mention item carries its notification_id as the source_ref-out (§5.3)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'look @local-test');

    const notif = t.ctx.db
      .prepare(
        `SELECT id FROM notifications
          WHERE user_id = 'local' AND kind = 'mention_self' AND message_id = ?`,
      )
      .get(msgId) as { id: string } | undefined;
    expect(notif?.id).toBeTruthy();

    const items = await getActivity(t);
    const mention = items.find(i => i.kind === 'mention');
    // The renderer marks read BY this id — never by parsing the list key.
    expect(mention?.notification_id).toBe(notif!.id);
    expect(mention?.id).not.toBe(mention?.notification_id);
  });

  it('an agent_start_failed notification enters as a directed agent_failed item with notification_id', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    // Seed the notification the production path would emit (a real spawn failure
    // is awkward to force here; the read-model reads notifications by kind).
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, @conv,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id: 'notif-af-1',
        ws: workspaceId,
        conv: channelId,
        payload: JSON.stringify({
          reason: 'runtime_start_failed',
          error: 'spawn ENOENT',
          agent_name: 'beth',
        }),
        now: Date.now(),
      });

    const items = await getActivity(t);
    const failed = items.find(i => i.kind === 'agent_failed');
    expect(failed).toBeTruthy();
    expect(failed).toMatchObject({
      kind: 'agent_failed',
      salience: 'directed',
      notification_id: 'notif-af-1',
      message_id: null,
    });
    // Preview surfaces the failure summary from the payload.
    expect(failed!.preview).toContain('beth');
  });

  it('unread and task items have a null notification_id (cleared via cursor / task_status)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const taskMsg = await sendAsAgent(t, channelId, sender, 'task seed');
    t.ctx.db
      .prepare(
        `UPDATE messages SET task_number = 20, task_status = 'in_review',
            task_assignee_user_id = 'someone-else', task_workspace_id = ?,
            task_title = 't20' WHERE id = ?`,
      )
      .run(workspaceId, taskMsg);
    await sendAsAgent(t, channelId, sender, 'plain ambient');
    await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
      mode: 'all',
    });

    const items = await getActivity(t);
    for (const i of items.filter(x => x.kind === 'unread' || x.kind === 'task')) {
      expect(i.notification_id).toBeNull();
    }
  });
});

/** Resolve the first agent member of a channel (the workspace snapshot), so
 *  sends come from a real member rather than a guessed id. */
async function firstChannelAgent(
  t: TestApp,
  channelId: string,
): Promise<string | null> {
  const row = t.ctx.db
    .prepare(
      `SELECT agent_id FROM conversation_agents WHERE conversation_id = ? LIMIT 1`,
    )
    .get(channelId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}
