import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Favorites read-model (#task:1252): the viewer's flat global STARRED list,
// a read projection of `user_sort_entry.starred_at` UNIONed across every
// list_key. See packages/backend/src/read-model/favorites.ts.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

async function makeWorkspace(t: TestApp, name: string, agentId: string): Promise<string> {
  const r = await http(t).post('/api/workspaces', { name, member_agent_ids: [agentId] });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).workspace.id;
}

async function makeChannel(t: TestApp, wsId: string, title: string, agentId: string): Promise<string> {
  const r = await http(t).post(`/api/workspaces/${wsId}/channels`, {
    title,
    member_agent_ids: [agentId],
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).channel.id;
}

async function favorites(t: TestApp): Promise<any[]> {
  const r = await http(t).get('/api/favorites');
  expect(r.status).toBe(200);
  return ((await r.json()) as any).items;
}

/** The agent_home (DM) workspace + its dm_channel for an agent. */
function dmOf(t: TestApp, agentId: string): { wsId: string; dmChannelId: string } {
  const ws = t.ctx.db
    .prepare<[string], { id: string }>(
      `SELECT id FROM workspaces WHERE owner_agent_id = ? AND workspace_kind = 'agent_home'`,
    )
    .get(agentId);
  expect(ws).toBeTruthy();
  const dm = t.ctx.db
    .prepare<[string], { id: string }>(
      `SELECT id FROM conversations WHERE workspace_id = ? AND kind = 'dm_channel'`,
    )
    .get(ws!.id);
  expect(dm).toBeTruthy();
  return { wsId: ws!.id, dmChannelId: dm!.id };
}

/** Force a deterministic starred_at so order assertions don't race the clock. */
function setStarredAt(t: TestApp, listKey: string, entityId: string, at: number): void {
  const n = t.ctx.db
    .prepare(`UPDATE user_sort_entry SET starred_at = ? WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`)
    .run(at, listKey, entityId).changes;
  expect(n).toBe(1);
}

describe('GET /api/favorites', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('projects starred workspace + channel with server-resolved identity', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);

    expect((await http(t).post(`/api/workspaces/${wsId}/star`)).status).toBe(200);
    expect((await http(t).post(`/api/channels/${chId}/star`)).status).toBe(200);

    const items = await favorites(t);
    const ws = items.find(i => i.entity_id === wsId);
    const ch = items.find(i => i.entity_id === chId);

    expect(ws).toMatchObject({
      kind: 'workspace',
      entity_id: wsId,
      workspace_id: wsId,
      channel_id: null,
      title: 'eng',
      workspace_name: null,
      icon_url: null,
      runtime: null,
      unread_count: null,
    });
    expect(typeof ws.starred_at).toBe('number');

    expect(ch).toMatchObject({
      kind: 'channel',
      entity_id: chId,
      workspace_id: wsId,
      channel_id: chId,
      title: 'general',
      // parent ws name = the disambiguating muted subtitle.
      workspace_name: 'eng',
      icon_url: null,
      runtime: null,
      unread_count: null,
    });
  });

  it('orders rows by starred_at DESC (most-recently-starred first)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/channels/${chId}/star`);

    // workspace starred earlier, channel later.
    setStarredAt(t, 'workspaces', wsId, 1000);
    setStarredAt(t, `channels:${wsId}`, chId, 2000);

    const items = await favorites(t);
    expect(items.map(i => i.entity_id)).toEqual([chId, wsId]);
  });

  it('projects a starred DM (agent_home) as kind="dm" resolved from the bound agent', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'rover');
    const { wsId: dmWsId } = dmOf(t, agentId);

    expect((await http(t).post(`/api/workspaces/${dmWsId}/star`)).status).toBe(200);

    const items = await favorites(t);
    const dm = items.find(i => i.entity_id === dmWsId);
    expect(dm).toMatchObject({
      kind: 'dm',
      entity_id: dmWsId,
      workspace_id: dmWsId,
      channel_id: null,
      title: 'rover', // agent name (no display_name set)
      workspace_name: null,
      icon_url: null, // no avatar set
      runtime: 'claude',
    });
  });

  it('builds icon_url for a DM agent that has an avatar', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'rover');
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);

    // Give the agent an avatar (both columns set per the CHECK constraint).
    t.ctx.db
      .prepare(`UPDATE agents SET avatar_storage_key = 'k', avatar_content_type = 'image/png', updated_at = 4242 WHERE id = ?`)
      .run(agentId);

    const dm = (await favorites(t)).find(i => i.entity_id === dmWsId);
    expect(dm.icon_url).toBe(`/api/agents/${agentId}/avatar?v=4242`);
  });

  it('hides archived workspace and archived channel favorites (storage row preserved)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/channels/${chId}/star`);

    // Archive both (directly — the star row stays in user_sort_entry).
    t.ctx.db.prepare(`UPDATE conversations SET archived_at = 1 WHERE id = ?`).run(chId);
    t.ctx.db.prepare(`UPDATE workspaces SET archived_at = 1 WHERE id = ?`).run(wsId);

    expect(await favorites(t)).toEqual([]);
    // The underlying star rows persist (favorite reappears on restore).
    const rows = t.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM user_sort_entry WHERE user_id = 'local' AND starred_at IS NOT NULL`)
      .get() as any;
    expect(rows.n).toBe(2);
  });

  it('hides a dm_channel star (#task:1252 v1 narrowing) — DM surfaces only as kind="dm"', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'rover');
    const { wsId: dmWsId, dmChannelId } = dmOf(t, agentId);

    // Directly write a star on the DM *conversation* (channels:<agent_home>).
    t.ctx.db
      .prepare(
        `INSERT INTO user_sort_entry (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
         VALUES ('local', ?, ?, NULL, NULL, 5000)`,
      )
      .run(`channels:${dmWsId}`, dmChannelId);

    // Not projected as a channel row (or any row).
    const items = await favorites(t);
    expect(items.find(i => i.entity_id === dmChannelId)).toBeUndefined();
  });

  it('hides favorites the viewer can no longer access (membership dropped)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/channels/${chId}/star`);

    // Drop the viewer's workspace + conversation membership.
    t.ctx.db.prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`).run(chId);
    t.ctx.db.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`).run(wsId);

    expect(await favorites(t)).toEqual([]);
  });

  it('drops a channel star whose list_key ws ≠ the channel parent ws (orphan/malformed)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsA = await makeWorkspace(t, 'enga', agentId);
    const wsB = await makeWorkspace(t, 'engb', agentId);
    const chA = await makeChannel(t, wsA, 'general', agentId);

    // Correctly-stored star (list_key = the channel's real parent ws).
    expect((await http(t).post(`/api/channels/${chA}/star`)).status).toBe(200);
    // Malformed/orphan row: same channel, but filed under wsB's namespace —
    // an identity the per-entity unstar route (`channels:<real ws>`) can't reach.
    t.ctx.db
      .prepare(
        `INSERT INTO user_sort_entry (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
         VALUES ('local', ?, ?, NULL, NULL, 9000)`,
      )
      .run(`channels:${wsB}`, chA);

    const items = await favorites(t);
    const chRows = items.filter(i => i.entity_id === chA);
    // Exactly one row — the correctly-filed one; the malformed row is dropped.
    expect(chRows).toHaveLength(1);
    expect(chRows[0]).toMatchObject({ kind: 'channel', workspace_id: wsA, workspace_name: 'enga' });
  });

  it('returns empty for a viewer with no stars', async () => {
    t = buildTestApp();
    await makeAgent(t, 'alice');
    expect(await favorites(t)).toEqual([]);
  });
});
