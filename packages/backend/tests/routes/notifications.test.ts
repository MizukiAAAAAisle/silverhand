/**
 * Notifications routes characterization (#task:983 — P15 prep).
 *
 * Pins GET /api/notifications (list + unread filter + limit), GET
 * /api/notifications/unread (total + per-workspace counts + latest pointer), and
 * POST /api/notifications/read (mark by id / workspace / conversation / all, plus
 * the `unread_updated` viewer-scope event that only fires when the unread counter
 * actually changed) BEFORE carving the block into routes/notifications.ts, so the
 * relocation is provably behavior-preserving. No prior route test covered these.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';

describe('Notifications routes — characterization (P15 prep)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // Real workspace + onboarding conversation rows so the notifications FK
  // (workspace_id → workspaces, conversation_id → conversations) is satisfied.
  const createWs = async (name: string) => {
    const r = await http(t!).json<{
      workspace: { id: string };
      onboarding_channel_id: string;
    }>(http(t!).post('/api/workspaces', { name, member_agent_ids: [] }));
    return { workspaceId: r.workspace.id, conversationId: r.onboarding_channel_id };
  };

  const seed = (
    workspaceId?: string | null,
    conversationId?: string | null,
    messageId?: string | null,
  ) =>
    new NotificationRepo(t!.ctx.db).insert({
      kind: 'mention_self',
      userId: t!.viewerUserId,
      workspaceId: workspaceId ?? null,
      conversationId: conversationId ?? null,
      messageId: messageId ?? null,
    });

  // Post a real message to a conversation so a notification can carry a valid
  // message_id (latestUnreadByWorkspace requires conversation_id + message_id).
  const postMsg = async (conversationId: string) => {
    const r = await http(t!).json<{ message: { id: string } }>(
      http(t!).post(`/api/channels/${conversationId}/messages`, { content: 'hi' }),
    );
    return r.message.id;
  };

  const postReply = async (conversationId: string, rootMessageId: string) => {
    const r = await http(t!).json<{ message: { id: string } }>(
      http(t!).post(`/api/channels/${conversationId}/messages`, {
        content: 'thread reply notification',
        reply_to_message_id: rootMessageId,
      }),
    );
    return r.message.id;
  };

  it('GET /api/notifications lists the viewer notifications; unread + limit filters apply', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWs('n-list');
    const a = seed(workspaceId);
    const b = seed(workspaceId);
    new NotificationRepo(t.ctx.db).markRead(a.id, t.viewerUserId);

    const all = await http(t).json<{ notifications: { id: string }[] }>(
      http(t).get('/api/notifications'),
    );
    expect(all.notifications.map(n => n.id).sort()).toEqual([a.id, b.id].sort());

    const unread = await http(t).json<{ notifications: { id: string }[] }>(
      http(t).get('/api/notifications?unread=1'),
    );
    expect(unread.notifications.map(n => n.id)).toEqual([b.id]);

    const limited = await http(t).json<{ notifications: { id: string }[] }>(
      http(t).get('/api/notifications?limit=1'),
    );
    expect(limited.notifications).toHaveLength(1);
  });

  it('GET /api/notifications exposes reply-cluster roots for message-anchored notifications', async () => {
    t = buildTestApp();
    const { workspaceId, conversationId } = await createWs('n-thread-list');
    const rootId = await postMsg(conversationId);
    const replyId = await postReply(conversationId, rootId);
    const n = seed(workspaceId, conversationId, replyId);

    const all = await http(t).json<{
      notifications: Array<{
        id: string;
        thread_root_id: string | null;
      }>;
    }>(http(t).get('/api/notifications'));

    expect(all.notifications.find(x => x.id === n.id)).toMatchObject({
      thread_root_id: rootId,
    });
  });

  it('GET /api/notifications/unread returns total + by_workspace + latest_by_workspace', async () => {
    t = buildTestApp();
    const ws1 = await createWs('n-sum-1');
    const ws2 = await createWs('n-sum-2');
    seed(ws1.workspaceId, ws1.conversationId, await postMsg(ws1.conversationId));
    seed(ws1.workspaceId, ws1.conversationId, await postMsg(ws1.conversationId));
    seed(ws2.workspaceId, ws2.conversationId, await postMsg(ws2.conversationId));

    const res = await http(t).json<{
      total: number;
      by_workspace: Record<string, number>;
      latest_by_workspace: Record<string, { conversation_id: string }>;
    }>(http(t).get('/api/notifications/unread'));

    expect(res.total).toBe(3);
    expect(res.by_workspace[ws1.workspaceId]).toBe(2);
    expect(res.by_workspace[ws2.workspaceId]).toBe(1);
    expect(Object.keys(res.latest_by_workspace).sort()).toEqual(
      [ws1.workspaceId, ws2.workspaceId].sort(),
    );
    expect(res.latest_by_workspace[ws1.workspaceId]?.conversation_id).toBe(
      ws1.conversationId,
    );
  });

  it('GET /api/notifications/unread includes the latest pointer thread root', async () => {
    t = buildTestApp();
    const { workspaceId, conversationId } = await createWs('n-thread-unread');
    const rootId = await postMsg(conversationId);
    const replyId = await postReply(conversationId, rootId);
    seed(workspaceId, conversationId, replyId);

    const res = await http(t).json<{
      latest_by_workspace: Record<
        string,
        {
          conversation_id: string;
          message_id: string;
          thread_root_id: string | null;
        }
      >;
    }>(http(t).get('/api/notifications/unread'));

    expect(res.latest_by_workspace[workspaceId]).toMatchObject({
      conversation_id: conversationId,
      message_id: replyId,
      thread_root_id: rootId,
    });
  });

  it('POST /api/notifications/read by id marks 1 and publishes unread_updated to the viewer scope', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWs('n-mark-id');
    const n = seed(workspaceId);
    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribeScope(
      `viewer:${t.viewerUserId}`,
      e => events.push({ kind: e.kind, payload: e.payload }),
    );

    const res = await http(t).json<{ marked: number }>(
      http(t).post('/api/notifications/read', { id: n.id }),
    );
    unsub();

    expect(res.marked).toBe(1);
    expect(events).toContainEqual({
      kind: 'unread_updated',
      payload: { marked: 1 },
    });
  });

  it('POST /api/notifications/read by conversation_id / workspace_id / all mark the matching set', async () => {
    t = buildTestApp();
    const ws1 = await createWs('n-mark-multi-1');
    const ws2 = await createWs('n-mark-multi-2');
    seed(ws1.workspaceId, ws1.conversationId); // in conversation
    seed(ws1.workspaceId); // workspace-level, no conversation
    seed(ws2.workspaceId);

    const byConv = await http(t).json<{ marked: number }>(
      http(t).post('/api/notifications/read', {
        conversation_id: ws1.conversationId,
      }),
    );
    expect(byConv.marked).toBe(1);

    const byWs = await http(t).json<{ marked: number }>(
      http(t).post('/api/notifications/read', { workspace_id: ws1.workspaceId }),
    );
    expect(byWs.marked).toBe(1); // the remaining ws1 row

    const all = await http(t).json<{ marked: number }>(
      http(t).post('/api/notifications/read', { all: true }),
    );
    expect(all.marked).toBe(1); // the ws2 row
  });

  it('POST /api/notifications/read marking an already-read id marks 0 and publishes NO event', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWs('n-noop');
    const n = seed(workspaceId);
    new NotificationRepo(t.ctx.db).markRead(n.id, t.viewerUserId);
    const events: string[] = [];
    const unsub = t.ctx.events.subscribeScope(
      `viewer:${t.viewerUserId}`,
      e => events.push(e.kind),
    );

    const res = await http(t).json<{ marked: number }>(
      http(t).post('/api/notifications/read', { id: n.id }),
    );
    unsub();

    expect(res.marked).toBe(0);
    expect(events).not.toContain('unread_updated');
  });

  it('POST /api/notifications/read with an empty body is rejected 400', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/notifications/read', {});
    expect(res.status).toBe(400);
  });
});
