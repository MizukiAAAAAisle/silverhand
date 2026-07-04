import { afterEach, describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

function insertFossilThread(
  db: Db,
  channel: { id: string; workspace_id: string; workspace_path: string },
): { id: string } {
  const id = `fossil_thread_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, workspace_path, kind, parent_conversation_id,
        title, status, created_at, updated_at, latest_message_seq)
     VALUES (?, ?, ?, 'thread', ?, 'Fossil', 'idle', ?, ?, 0)`,
  ).run(id, channel.workspace_id, channel.workspace_path, channel.id, Date.now(), Date.now());
  return { id };
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
): Promise<{ workspaceId: string; channelId: string }> {
  const agentId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-attention',
      member_agent_ids: [agentId],
    })
  ).json()) as any;
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
  };
}

describe('channel attention preference routes (#task:1227 ②a)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET resolves the channel default (ambient on = all) when unset', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const res = await http(t).get(
      `/api/conversations/${channelId}/attention-preference`,
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as any;
    expect(dto).toEqual({ conversation_id: channelId, mode: 'all' });
  });

  it('PUT upserts the mode and GET reads it back (round-trip)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const put = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'all' },
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ conversation_id: channelId, mode: 'all' });

    const get = await http(t).get(
      `/api/conversations/${channelId}/attention-preference`,
    );
    expect(await get.json()).toEqual({ conversation_id: channelId, mode: 'all' });

    // Idempotent + reversible: set back to mentions.
    const put2 = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'mentions' },
    );
    expect(await put2.json()).toEqual({ conversation_id: channelId, mode: 'mentions' });
  });

  it('does NOT emit unread_updated — channel unread roll-up is pref-independent (§8)', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);
    const viewerEvents: string[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      viewerEvents.push(e.kind);
    });

    await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'all' },
    );
    unsub();

    expect(viewerEvents).not.toContain('unread_updated');
  });

  it('PUT rejects an invalid mode with 400', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const res = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'loud' },
    );
    expect(res.status).toBe(400);
  });

  it('404s for non-regular-channel conversations (dm_channel + thread)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const conversations = new ConversationRepo(t.ctx.db);
    const workspacePath = (
      t.ctx.db
        .prepare(`SELECT workspace_path FROM conversations WHERE id = ?`)
        .get(channelId) as any
    ).workspace_path as string;
    const thread = insertFossilThread(t.ctx.db, {
      id: channelId,
      workspace_id: workspaceId,
      workspace_path: workspacePath,
    });
    const dm = conversations.insertDmChannel({
      workspaceId,
      workspacePath,
      title: 'dm',
    });

    // A DM's unread is directed-grade (always enters, §5.1) and a thread's
    // ambient is follow-driven — neither has a channel ambient preference.
    for (const id of [thread.id, dm.id]) {
      const get = await http(t).get(
        `/api/conversations/${id}/attention-preference`,
      );
      expect(get.status).toBe(404);
      const put = await http(t).put(
        `/api/conversations/${id}/attention-preference`,
        { mode: 'all' },
      );
      expect(put.status).toBe(404);
    }
  });

  it('DB trigger rejects a pref on a dm_channel / thread (fail-loud backstop)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const conversations = new ConversationRepo(t.ctx.db);
    const workspacePath = (
      t.ctx.db
        .prepare(`SELECT workspace_path FROM conversations WHERE id = ?`)
        .get(channelId) as any
    ).workspace_path as string;
    const thread = insertFossilThread(t.ctx.db, {
      id: channelId,
      workspace_id: workspaceId,
      workspace_path: workspacePath,
    });
    const dm = conversations.insertDmChannel({
      workspaceId,
      workspacePath,
      title: 'dm',
    });

    const insert = t.ctx.db.prepare(
      `INSERT INTO channel_attention_preferences
         (user_id, conversation_id, mode, updated_at)
       VALUES (?, ?, 'all', 1)`,
    );
    // A regular channel is accepted; the non-channel kinds abort.
    expect(() => insert.run('local', channelId)).not.toThrow();
    expect(() => insert.run('local', thread.id)).toThrow(/regular channel/);
    expect(() => insert.run('local', dm.id)).toThrow(/regular channel/);
  });

  it('404s for an unknown conversation id', async () => {
    t = buildTestApp();
    await createWorkspaceChannel(t);

    const res = await http(t).get(
      `/api/conversations/does-not-exist/attention-preference`,
    );
    expect(res.status).toBe(404);
  });
});
