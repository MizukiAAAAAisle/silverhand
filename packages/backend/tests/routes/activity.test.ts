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
  return result.committed.message.id;
}

/** Send an agent reply into a thread (reply-cluster) under `rootMsgId`. */
async function sendThreadReply(
  t: TestApp,
  channelId: string,
  agentId: string,
  rootMsgId: string,
  content: string,
): Promise<string> {
  const result = await t.ctx.conversationMessageService.sendMessage({
    conversationId: channelId,
    actor: { kind: 'agent', agentId, conversationId: channelId },
    content,
    target: { kind: 'thread', message_id: rootMsgId },
  });
  return result.committed.message.id;
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

  it('REGRESSION #1243: default-all channels still show cursor-unread @me in Activity', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;

    const mentionMsg = await sendAsAgent(t, channelId, sender, 'needs you @local-test');
    await sendAsAgent(t, channelId, sender, 'plain follow-up');

    const cursor = t.ctx.db
      .prepare(
        `SELECT COALESCE(last_read_seq, 0) AS last_read_seq
           FROM conversation_reads
          WHERE user_id = 'local'
            AND conversation_id = ?
            AND thread_root_id IS NULL`,
      )
      .get(channelId) as { last_read_seq: number } | undefined;
    const mentionSeq = t.ctx.db
      .prepare(`SELECT seq FROM messages WHERE id = ?`)
      .get(mentionMsg) as { seq: number };
    expect(cursor?.last_read_seq ?? 0).toBeLessThan(mentionSeq.seq);

    // Default channel attention preference is 'all': ambient channel unread
    // enters too, but the directed mention must remain as the durable backstop
    // until an active eliminate intent writes read_at.
    const items = await getActivity(t);
    const ambient = items.find(
      i => i.kind === 'unread' && i.conversation_id === channelId,
    );
    expect(ambient?.unread_count).toBe(1); // plain follow-up; the mention is netted out
    const mention = items.find(i => i.kind === 'mention' && i.message_id === mentionMsg);
    expect(mention).toMatchObject({
      kind: 'mention',
      salience: 'directed',
      conversation_id: channelId,
      message_id: mentionMsg,
    });
  });

  it('ambient channel unread is on by default and can be opted down to mentions only', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    // A plain (non-mention) message → ambient unread for the viewer.
    await sendAsAgent(t, channelId, sender, 'just chatting, no mention here');

    // Default pref = 'all' (ambient on) → the channel mainline unread enters.
    let items = await getActivity(t);
    let ambient = items.filter(i => i.kind === 'unread');
    expect(ambient).toHaveLength(1);
    expect(ambient[0]).toMatchObject({
      kind: 'unread',
      salience: 'ambient',
      conversation_id: channelId,
      thread_root_id: null,
      unread_count: 1,
    });

    // Flip to 'mentions' (ambient off) → ordinary ambient channel unread stays
    // out of Activity while normal sidebar unread remains pref-independent.
    const put = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'mentions' },
    );
    expect(put.status).toBe(200);

    items = await getActivity(t);
    ambient = items.filter(i => i.kind === 'unread');
    expect(ambient).toHaveLength(0);
  });

  it('#task:1268: mention-only channel gates followed-thread ambient but not thread @mentions (aggregate-floor)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;

    // Root a thread and have the viewer follow it (delivery subscription).
    const rootMsg = await sendAsAgent(t, channelId, sender, 'thread root topic');
    t.ctx.conversationMessageService.followHumanThread({
      conversationId: channelId,
      rootMessageId: rootMsg,
      userId: t.viewerUserId,
    });

    // Default pref = 'all': a plain followed-thread reply enters as ambient.
    await sendThreadReply(t, channelId, sender, rootMsg, 'plain reply in thread');
    let threadAmbient = (await getActivity(t)).filter(
      i => i.kind === 'unread' && i.thread_root_id === rootMsg,
    );
    expect(threadAmbient).toHaveLength(1);
    expect(threadAmbient[0].salience).toBe('ambient');

    // Flip the PARENT channel to 'mentions' (ambient off for the aggregate).
    expect(
      (
        await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
          mode: 'mentions',
        })
      ).status,
    ).toBe(200);

    // The followed-thread AMBIENT reply no longer enters — follow (delivery) must
    // not override the viewer's explicit `仅提及` on the parent channel.
    threadAmbient = (await getActivity(t)).filter(
      i => i.kind === 'unread' && i.thread_root_id === rootMsg,
    );
    expect(threadAmbient).toHaveLength(0);

    // …but a thread @mention still enters via the directed path (unconditional).
    const mentionMsg = await sendThreadReply(
      t,
      channelId,
      sender,
      rootMsg,
      'over here @local-test',
    );
    const threadMention = (await getActivity(t)).filter(
      i => i.kind === 'mention' && i.message_id === mentionMsg,
    );
    expect(threadMention).toHaveLength(1);
    expect(threadMention[0]).toMatchObject({
      salience: 'directed',
      thread_root_id: rootMsg,
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

  it('task-bearing messages produce NO kind=task item in v1 (tasks live in the panel)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    // (a) a task assigned to the viewer, and (b) an in_review task by someone
    // else — both used to project a kind=task item. v1 drops the task projection
    // entirely (shiki 2026-06-26): tasks are tracked in the task panel; only
    // message/unread/mention attention events enter Activity.
    const mineMsg = await sendAsAgent(t, channelId, sender, 'assigned to me');
    t.ctx.db
      .prepare(
        `UPDATE messages SET task_number = 7, task_status = 'in_progress',
            task_assignee_user_id = 'local', task_workspace_id = ?,
            task_title = 'mine' WHERE id = ?`,
      )
      .run(workspaceId, mineMsg);
    const reviewMsg = await sendAsAgent(t, channelId, sender, 'please review');
    t.ctx.db
      .prepare(
        `UPDATE messages SET task_number = 8, task_status = 'in_review',
            task_assignee_user_id = 'someone-else', task_workspace_id = ?,
            task_title = 'awaiting validation' WHERE id = ?`,
      )
      .run(workspaceId, reviewMsg);

    // No task items at all — neither the assigned-to-me nor the in_review branch.
    expect((await getActivity(t)).some(i => i.kind === 'task')).toBe(false);

    // The task-bearing messages are still reachable via the ordinary unread path
    // (they are plain messages from another member) through the default ambient
    // channel path.
    const ambient = (await getActivity(t)).filter(
      i => i.kind === 'unread' && i.conversation_id === channelId,
    );
    expect(ambient).toHaveLength(1);
    expect(ambient[0].unread_count).toBe(2); // both task messages count, non-directed
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

  it('a mention on a task-bearing message still enters as a mention (no kind=task in v1)', async () => {
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
    // Task projection is gone → the message's only directed claim is the mention.
    expect(onThatMessage).toHaveLength(1);
    expect(onThatMessage[0].kind).toBe('mention');
    expect(items.some(i => i.kind === 'task')).toBe(false);
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

  it('drops directed mention items from archived channels (#task:1409)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const msgId = await sendAsAgent(t, channelId, sender, 'archived ping @local-test');

    expect(
      (await getActivity(t)).some(i => i.kind === 'mention' && i.message_id === msgId),
    ).toBe(true);

    const archived = await http(t).patch(`/api/channels/${channelId}/archive`, {
      archived: true,
    });
    expect(archived.status).toBe(200);

    const items = await getActivity(t);
    expect(items.some(i => i.kind === 'mention' && i.message_id === msgId)).toBe(false);
    expect(items.some(i => i.conversation_id === channelId)).toBe(false);
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

  it('drops agent_start_failed items from archived channels (#task:1409)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, @conv,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id: 'notif-af-archived',
        ws: workspaceId,
        conv: channelId,
        payload: JSON.stringify({
          reason: 'runtime_start_failed',
          error: 'spawn ENOENT',
          agent_name: 'beth',
        }),
        now: Date.now(),
      });

    expect(
      (await getActivity(t)).some(
        i => i.kind === 'agent_failed' && i.notification_id === 'notif-af-archived',
      ),
    ).toBe(true);

    const archived = await http(t).patch(`/api/channels/${channelId}/archive`, {
      archived: true,
    });
    expect(archived.status).toBe(200);

    expect(
      (await getActivity(t)).some(
        i => i.kind === 'agent_failed' && i.notification_id === 'notif-af-archived',
      ),
    ).toBe(false);
  });

  it('drops orphaned directed notifications with no live conversation (#task:1409)', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, NULL,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id: 'notif-af-anchorless',
        ws: workspaceId,
        payload: JSON.stringify({
          reason: 'runtime_start_failed',
          error: 'spawn ENOENT',
          agent_name: 'beth',
        }),
        now: Date.now(),
      });

    const failed = (await getActivity(t)).find(
      i => i.kind === 'agent_failed' && i.notification_id === 'notif-af-anchorless',
    );
    expect(failed).toBeUndefined();
  });

  it('anchorless agent_start_failed exits Activity via explicit observe(notification)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, @conv,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id: 'notif-af-clear',
        ws: workspaceId,
        conv: channelId,
        payload: JSON.stringify({
          reason: 'runtime_start_failed',
          error: 'spawn ENOENT',
          agent_name: 'beth',
        }),
        now: Date.now(),
      });

    expect((await getActivity(t)).some(i => i.kind === 'agent_failed')).toBe(true);

    const res = await http(t).post('/api/attention/observe', {
      sources: [{ kind: 'notification', notification_id: 'notif-af-clear' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });

    const row = t.ctx.db
      .prepare(`SELECT read_at FROM notifications WHERE id = 'notif-af-clear'`)
      .get() as { read_at: number | null };
    expect(row.read_at).not.toBeNull();
    expect((await getActivity(t)).some(i => i.kind === 'agent_failed')).toBe(false);
  });

  it('unread items have a null notification_id (cleared via cursor, not read_at)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    await sendAsAgent(t, channelId, sender, 'plain ambient');
    await http(t).put(`/api/conversations/${channelId}/attention-preference`, {
      mode: 'all',
    });

    const items = await getActivity(t);
    const unread = items.filter(x => x.kind === 'unread');
    expect(unread.length).toBeGreaterThan(0);
    for (const i of unread) expect(i.notification_id).toBeNull();
  });

  // ── source-first layout fields (shiki dogfood: row-1 where / row-2/3 content) ──

  it('a channel mention carries conversation_kind and a null thread_root_preview (mainline)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    await sendAsAgent(t, channelId, sender, 'look @local-test');

    const mention = (await getActivity(t)).find(i => i.kind === 'mention');
    expect(mention).toBeTruthy();
    expect(mention.conversation_kind).toBe('channel');
    expect(mention.thread_root_preview).toBeNull(); // mainline → no root row
  });

  it('a thread unread carries the root preview (row-2) and the reply preview (row-3)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const rootMsg = await sendAsAgent(t, channelId, sender, 'ROOT topic message');
    const replyMsg = await sendThreadReply(
      t,
      channelId,
      sender,
      rootMsg,
      'REPLY inside the thread',
    );
    // The viewer follows the thread (human follower); with the default channel
    // ambient pref = 'all' its ambient unread enters (§6: thread ambient needs
    // followed AND parent channel pref = 'all' — follow is necessary not
    // sufficient, #task:1268). The default channel ambient pref may also surface
    // the root mainline, so assert the thread row by root id.
    t.ctx.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id,
            followed_at, source)
         VALUES (?, ?, 'human', 'local', ?, 'manual')`,
      )
      .run(rootMsg, channelId, Date.now());

    const thread = (await getActivity(t)).filter(
      i => i.kind === 'unread' && i.thread_root_id === rootMsg,
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      conversation_kind: 'channel',
      thread_root_id: rootMsg,
      message_id: replyMsg, // anchored at the first unread reply
    });
    // row-2 = the thread's root; row-3 = the reply that triggered the unread.
    expect(thread[0].thread_root_preview).toContain('ROOT topic');
    expect(thread[0].preview).toContain('REPLY inside the thread');
    // row-3 sender = the reply's author, server-resolved (the global list can't
    // client-stitch a cross-workspace sender). Anchor = first unread reply.
    expect(thread[0].preview_sender).toMatchObject({
      kind: 'agent',
      id: sender,
    });
    expect(thread[0].preview_sender!.display_name).toBeTruthy();
  });

  it('preview_sender is null for agent_failed (no message anchor)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, @conv,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id: 'notif-af-sender',
        ws: workspaceId,
        conv: channelId,
        payload: JSON.stringify({ agent_name: 'beth', error: 'spawn EACCES' }),
        now: Date.now(),
      });
    const failed = (await getActivity(t)).find(i => i.kind === 'agent_failed');
    expect(failed).toBeTruthy();
    expect(failed!.preview_sender).toBeNull();
  });

  it('preview_sender passes display_name through raw + carries the handle in name (renderer owns the empty-label fallback)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const agentName = (
      t.ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).get(sender) as {
        name: string;
      }
    ).name;
    // agents.display_name is NOT NULL DEFAULT '' — an empty label is a real
    // schema state. Unlike the retired ActivityPreviewSender (which server-
    // COALESCE'd to a non-empty label), the unified MessageAuthorDto mirrors
    // AgentDto/UserDto: display_name is passed through RAW and the handle is
    // always carried in `name`, so the renderer applies its ONE display
    // fallback (display_name || name) uniformly across every author carrier
    // (#task:1791).
    t.ctx.db.prepare(`UPDATE agents SET display_name = '' WHERE id = ?`).run(sender);

    const rootMsg = await sendAsAgent(t, channelId, sender, 'ROOT for empty-name');
    const replyMsg = await sendThreadReply(t, channelId, sender, rootMsg, 'reply body');
    t.ctx.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id,
            followed_at, source)
         VALUES (?, ?, 'human', 'local', ?, 'manual')`,
      )
      .run(rootMsg, channelId, Date.now());

    const thread = (await getActivity(t)).find(
      i => i.kind === 'unread' && i.message_id === replyMsg,
    );
    expect(thread).toBeTruthy();
    expect(thread!.preview_sender).toEqual({
      kind: 'agent',
      status: 'active',
      id: sender,
      name: agentName,
      display_name: '',
      avatar_url: null,
      runtime: 'claude',
    });
  });

  it('preview_sender flips to a deleted snapshot after the author is hard-deleted (Activity is wired to the ONE author resolver) (#task:1791)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const sender = (await firstChannelAgent(t, channelId))!;
    const { name: agentName, display_name: agentDisplay } = t.ctx.db
      .prepare(`SELECT name, display_name FROM agents WHERE id = ?`)
      .get(sender) as { name: string; display_name: string };

    // A thread reply the human follows → a stable Activity unread anchor.
    const rootMsg = await sendAsAgent(t, channelId, sender, 'ROOT for delete-flip');
    const replyMsg = await sendThreadReply(t, channelId, sender, rootMsg, 'reply body');
    t.ctx.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id,
            followed_at, source)
         VALUES (?, ?, 'human', 'local', ?, 'manual')`,
      )
      .run(rootMsg, channelId, Date.now());

    const app = t;
    const findThread = async () =>
      (await getActivity(app)).find(
        i => i.kind === 'unread' && i.message_id === replyMsg,
      );

    // Before the delete: the live author resolves as `active` (with runtime).
    const before = await findThread();
    expect(before!.preview_sender).toEqual({
      kind: 'agent',
      status: 'active',
      id: sender,
      name: agentName,
      display_name: agentDisplay,
      avatar_url: null,
      runtime: 'claude',
    });

    // Hard-delete the author: ON DELETE SET NULL wipes messages.from_agent_id, but
    // the send-time snapshot survives.
    t.ctx.db.prepare(`DELETE FROM agents WHERE id = ?`).run(sender);

    // Same anchor, same id/name — but now `deleted` with a null avatar and NO
    // runtime (never degrades to a generic "@agent", never leaks a runtime).
    const after = await findThread();
    expect(after!.preview_sender).toEqual({
      kind: 'agent',
      status: 'deleted',
      id: sender,
      name: agentName,
      display_name: agentDisplay,
      avatar_url: null,
    });
    expect(after!.preview_sender).not.toHaveProperty('runtime');
  });

  it('preview_sender passes a user empty display_name through raw + carries the name handle', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const now = Date.now();
    // A second human with an empty display_name authoring the mentioned message.
    t.ctx.db
      .prepare(
        `INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('u-bob', 'bob', '', @now, @now)`,
      )
      .run({ now });
    t.ctx.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_user_id, content, seq, created_at)
         VALUES ('m-bob', @conv, 'user', 'u-bob', '@local hi', 999, @now)`,
      )
      .run({ conv: channelId, now });
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES ('notif-bob', 'mention_self', 'local', NULL, @ws, @conv,
            'm-bob', NULL, NULL, @now)`,
      )
      .run({ ws: workspaceId, conv: channelId, now });

    const mention = (await getActivity(t)).find(
      i => i.kind === 'mention' && i.message_id === 'm-bob',
    );
    expect(mention).toBeTruthy();
    // Raw display_name ('') passed through; handle carried in `name` for the
    // renderer's uniform fallback — no server-side COALESCE (#task:1791).
    expect(mention!.preview_sender).toEqual({
      kind: 'user',
      status: 'active',
      id: 'u-bob',
      name: 'bob',
      display_name: '',
      avatar_url: null,
      runtime: null,
    });
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
