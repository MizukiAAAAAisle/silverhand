import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createChannel(
  t: TestApp,
): Promise<{ channelId: string; agentId: string }> {
  const agentId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-threads',
      member_agent_ids: [agentId],
    })
  ).json()) as any;
  return { channelId: workspace.onboarding_channel_id, agentId };
}

function setCreatedAt(db: Db, id: string, ts: number): void {
  db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(ts, id);
}

const threadsPath = (id: string) => apiPaths.conversationThreads(id);

describe('GET /api/conversations/:id/threads', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists reply-clusters for a channel member', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root message',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a reply',
      threadRootId: root.id,
    });

    const res = await http(t).get(threadsPath(channelId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.next_cursor).toBeNull();
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].root_message_id).toBe(root.id);
    expect(body.threads[0].reply_count).toBe(1);
    expect(body.threads[0].root_author).toEqual({ kind: 'human', id: 'local' });
    expect(body.threads[0].repliers).toEqual([
      { kind: 'agent', id: agentId },
    ]);
  });

  it('paginates over HTTP via opaque cursor', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const roots = [0, 1].map(i =>
      messages.insertForConversation({
        conversationId: channelId,
        fromKind: 'user',
        fromUserId: 'local',
        content: `root ${i}`,
      }),
    );
    roots.forEach((r, i) => {
      const re = messages.insertForConversation({
        conversationId: channelId,
        fromKind: 'agent',
        fromAgentId: agentId,
        content: `reply ${i}`,
        threadRootId: r.id,
      });
      setCreatedAt(t!.ctx.db, re.id, 1000 + i); // root 1 newer
    });

    const p1 = (await (
      await http(t).get(`${threadsPath(channelId)}?limit=1`)
    ).json()) as any;
    expect(p1.threads.map((x: any) => x.root_message_id)).toEqual([
      roots[1]!.id,
    ]);
    expect(p1.next_cursor).not.toBeNull();

    const p2 = (await (
      await http(t).get(
        `${threadsPath(channelId)}?limit=1&cursor=${encodeURIComponent(p1.next_cursor)}`,
      )
    ).json()) as any;
    expect(p2.threads.map((x: any) => x.root_message_id)).toEqual([
      roots[0]!.id,
    ]);
    expect(p2.next_cursor).toBeNull();
  });

  it('rejects an invalid limit and an invalid cursor with 400', async () => {
    t = buildTestApp();
    const { channelId } = await createChannel(t);
    expect((await http(t).get(`${threadsPath(channelId)}?limit=0`)).status).toBe(
      400,
    );
    expect(
      (await http(t).get(`${threadsPath(channelId)}?limit=abc`)).status,
    ).toBe(400);
    const badCursor = await http(t).get(
      `${threadsPath(channelId)}?cursor=not-valid`,
    );
    expect(badCursor.status).toBe(400);
    expect(((await badCursor.json()) as any).code).toBe('invalid_cursor');
  });

  it('returns 404 for a missing channel', async () => {
    t = buildTestApp();
    await createChannel(t);
    expect((await http(t).get(threadsPath('does-not-exist'))).status).toBe(404);
  });

  it('forbids a non-member viewer', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await createChannel(t);
    const res = await http(t).get(threadsPath(channelId), {
      headers: {
        [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
      },
    });
    expect(res.status).toBe(403);
  });
});
