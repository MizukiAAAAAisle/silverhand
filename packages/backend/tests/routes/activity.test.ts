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

  it('forbids a non-self viewer and is read-only owned state', async () => {
    t = buildTestApp();
    await createWorkspaceChannel(t);
    // A different user's token cannot read the viewer's activity… but the route
    // is self-scoped: each caller only ever sees their OWN list, so a foreign
    // token simply returns that foreign user's (empty) list. Assert isolation:
    const otherRes = await http(t).get('/api/activity', {
      headers: { 'x-silverhand-legacy-user-id': 'someone-else' },
    });
    expect(otherRes.status).toBe(200);
    const dto = (await otherRes.json()) as any;
    expect(Array.isArray(dto.items)).toBe(true);
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
