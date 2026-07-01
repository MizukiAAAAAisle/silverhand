import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Favorites read-model (#task:1252): the viewer's flat global STARRED list,
// a read projection of `user_sort_entry.starred_at` for the WORKSPACE/DM rail
// (`list_key='workspaces'`). A channel star is local to its own channel sidebar
// and is NOT a global favorite. See packages/backend/src/read-model/favorites.ts.

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

  it('projects a starred workspace with server-resolved identity; a channel is NOT a global favorite', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);

    expect((await http(t).post(`/api/workspaces/${wsId}/star`)).status).toBe(200);
    expect((await http(t).post(`/api/channels/${chId}/star`)).status).toBe(200);

    const items = await favorites(t);
    const ws = items.find(i => i.entity_id === wsId);

    expect(ws).toMatchObject({
      kind: 'workspace',
      entity_id: wsId,
      workspace_id: wsId,
      title: 'eng',
      icon_url: null,
      runtime: null,
      // No non-system messages yet → caught-up rollup is 0 (not null).
      unread_count: 0,
    });
    expect(typeof ws.starred_at).toBe('number');

    // #task:1252: the global STARRED list holds workspace/DM only — a channel
    // star is LOCAL to its own channel sidebar (its top `starred` section), never
    // a global favorite. The channel star row still exists in user_sort_entry
    // (it drives the local sidebar partition), it is just not projected here.
    expect(items.find(i => i.entity_id === chId)).toBeUndefined();
    const chStar = t.ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_sort_entry WHERE user_id = 'local' AND list_key = ? AND entity_id = ? AND starred_at IS NOT NULL`,
      )
      .get(`channels:${wsId}`, chId) as any;
    expect(chStar.n).toBe(1);
  });

  it('orders rows by starred_at DESC (most-recently-starred first)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);

    // workspace starred earlier, DM later (both live in list_key='workspaces').
    setStarredAt(t, 'workspaces', wsId, 1000);
    setStarredAt(t, 'workspaces', dmWsId, 2000);

    const items = await favorites(t);
    expect(items.map(i => i.entity_id)).toEqual([dmWsId, wsId]);
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
      title: 'rover', // agent name (no display_name set)
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

  it('returns empty for a viewer with no stars', async () => {
    t = buildTestApp();
    await makeAgent(t, 'alice');
    expect(await favorites(t)).toEqual([]);
  });

  it('populates unread_count from the canonical rollup (#task:1254)', async () => {
    // The STARRED workspace/DM badge is filled server-side from the SAME
    // ROLLUP_UNREAD predicate the rail badge uses (per-workspace rollup), so
    // STARRED ≡ home, no drift. (A channel is not a global favorite, so only the
    // workspace/dm rollup is asserted here; the channel still contributes to its
    // parent workspace's rollup.)
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);

    // Two unread agent mainline messages in the channel. The viewer 'local' has
    // no conversation_reads cursor → any seq > 0 counts. A system message and
    // the viewer's OWN message do NOT (ROLLUP_UNREAD excludes both).
    const db = t.ctx.db;
    const insertMsg = (
      id: string,
      convId: string,
      fromKind: string,
      seq: number,
    ): void => {
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, from_kind, from_agent_id, from_user_id,
            content, metadata, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        convId,
        fromKind,
        fromKind === 'agent' ? agentId : null,
        fromKind === 'user' ? 'local' : null,
        'hi',
        seq,
        seq,
      );
    };
    insertMsg('m1', chId, 'agent', 100);
    insertMsg('m2', chId, 'agent', 101);
    insertMsg('m3', chId, 'system', 102); // excluded
    insertMsg('m4', chId, 'user', 103); // viewer's own → excluded

    const items = await favorites(t);
    const ws = items.find(i => i.entity_id === wsId);
    // Workspace row = the per-workspace rollup (sums its conversations = the
    // channel's 2), exactly what the rail workspace badge would show.
    expect(ws.unread_count).toBe(2);
    // Channel itself is not a global favorite.
    expect(items.find(i => i.entity_id === chId)).toBeUndefined();
  });
});

// ── Favorites ordering (#task:1252 C) ──────────────────────────────────────
// Favorites is a first-class sortable list (list_key='favorites'): a flat single
// group, list-wide recent/manual + manual drag, reusing the `sort` context. The
// read-model synthesizes `viewer_sort` keyed by `<kind>:<entity_id>` favorite
// keys; recent reads the entity's HOME `last_accessed_at` (recently-OPENED), not
// `starred_at`. Membership stays single-source in each home list's `starred_at`.

async function favoritesFull(t: TestApp): Promise<{ items: any[]; viewer_sort: any }> {
  const r = await http(t).get('/api/favorites');
  expect(r.status).toBe(200);
  return (await r.json()) as any;
}

function setHomeAccessed(t: TestApp, listKey: string, entityId: string, at: number): void {
  const n = t.ctx.db
    .prepare(
      `UPDATE user_sort_entry SET last_accessed_at = ? WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`,
    )
    .run(at, listKey, entityId).changes;
  expect(n).toBe(1);
}

describe('Favorites ordering (list_key=favorites)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('emits viewer_sort keyed by kind-qualified favorite_key with the sort triple', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);
    setStarredAt(t, 'workspaces', wsId, 1000);
    setStarredAt(t, 'workspaces', dmWsId, 2000);
    setHomeAccessed(t, 'workspaces', wsId, 7000);
    setHomeAccessed(t, 'workspaces', dmWsId, 8000);

    const { items, viewer_sort } = await favoritesFull(t);
    expect(viewer_sort.list_key).toBe('favorites');

    // Rows carry the favorite_key (kind-qualified) + created_at.
    const wsRow = items.find(i => i.entity_id === wsId);
    const dmRow = items.find(i => i.entity_id === dmWsId);
    expect(wsRow.favorite_key).toBe(`workspace:${wsId}`);
    expect(dmRow.favorite_key).toBe(`dm:${dmWsId}`);
    expect(typeof wsRow.created_at).toBe('number');

    // Entries are keyed by favorite_key and carry rank + HOME last_accessed_at +
    // starred_at — never the favorites row's own (null) last_accessed.
    const byKey = Object.fromEntries(
      viewer_sort.entries.map((e: any) => [e.entity_id, e]),
    );
    expect(byKey[`workspace:${wsId}`]).toMatchObject({
      rank: null,
      last_accessed_at: 7000,
      starred_at: 1000,
    });
    expect(byKey[`dm:${dmWsId}`]).toMatchObject({
      rank: null,
      last_accessed_at: 8000,
      starred_at: 2000,
    });
  });

  it('reorder via list_key=favorites writes per-favorite_key ranks (manual mode)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);

    const wsKey = `workspace:${wsId}`;
    const dmKey = `dm:${dmWsId}`;
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [dmKey, wsKey],
    });
    expect(r.status).toBe(200);
    const vs = ((await r.json()) as any).viewer_sort;
    expect(vs.list_key).toBe('favorites');
    expect(vs.modes['']).toBe('manual'); // order ⟹ manual on the list-wide scope
    const byKey = Object.fromEntries(vs.entries.map((e: any) => [e.entity_id, e]));
    expect(byKey[dmKey].rank).toBe(0);
    expect(byKey[wsKey].rank).toBe(1);
  });

  it('rejects a reorder id that is not a kind-qualified favorite_key', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);

    // Bare entity_id (not `workspace:<id>`) is not a member of the favorites group.
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [wsId],
    });
    expect(r.status).toBe(400);
  });

  it('favorites reorder does NOT disturb the home-list (workspaces rail) ranks', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);

    // Give the workspace a manual rail rank in its HOME list.
    t.ctx.db
      .prepare(
        `UPDATE user_sort_entry SET rank = 5 WHERE user_id = 'local' AND list_key = 'workspaces' AND entity_id = ?`,
      )
      .run(wsId);

    // Reorder the FAVORITES list.
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [`dm:${dmWsId}`, `workspace:${wsId}`],
    });
    expect(r.status).toBe(200);

    // The home rail rank is untouched — favorites ordering is its own axis.
    const homeRank = t.ctx.db
      .prepare<[string], { rank: number | null }>(
        `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'workspaces' AND entity_id = ?`,
      )
      .get(wsId);
    expect(homeRank?.rank).toBe(5);
  });

  it('unstar DROPS the favorite_key rank orphan (re-star re-enters fresh; HOME rank kept) — #task:1252 exclusive', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const { wsId: dmWsId } = dmOf(t, agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);
    await http(t).post(`/api/workspaces/${dmWsId}/star`);
    const wsKey = `workspace:${wsId}`;
    const dmKey = `dm:${dmWsId}`;

    // Manually arrange favorites → both get a rank under list_key='favorites'.
    expect(
      (await http(t).put('/api/sort/order', {
        list_key: 'favorites',
        group: 'favorites',
        ordered_ids: [dmKey, wsKey],
      })).status,
    ).toBe(200);
    // Give the workspace a HOME rail rank too, to prove it is NOT touched.
    t.ctx.db
      .prepare(
        `UPDATE user_sort_entry SET rank = 9 WHERE user_id = 'local' AND list_key = 'workspaces' AND entity_id = ?`,
      )
      .run(wsId);

    const db = t.ctx.db;
    const favRank = (key: string) =>
      db
        .prepare<[string], { rank: number | null }>(
          `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'favorites' AND entity_id = ?`,
        )
        .get(key);
    expect(favRank(wsKey)?.rank).toBe(1);
    expect(favRank(dmKey)?.rank).toBe(0);

    // Unstar the workspace → its FAVORITES rank orphan is deleted (voluntary
    // removal), but the DM's favorites rank and the ws's HOME rank survive.
    expect((await http(t).del(`/api/workspaces/${wsId}/star`)).status).toBe(200);
    expect(favRank(wsKey)).toBeUndefined();
    expect(favRank(dmKey)?.rank).toBe(0);
    const homeRank = t.ctx.db
      .prepare<[string], { rank: number | null }>(
        `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'workspaces' AND entity_id = ?`,
      )
      .get(wsId);
    expect(homeRank?.rank).toBe(9);

    // Re-star → re-enters FRESH (no rank), never jumping to the old slot 1.
    expect((await http(t).post(`/api/workspaces/${wsId}/star`)).status).toBe(200);
    expect(favRank(wsKey)?.rank ?? null).toBeNull();
  });

  it('mode toggle on favorites is persisted list-wide (scope "")', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);

    const r = await http(t).put('/api/sort/mode', {
      list_key: 'favorites',
      mode: 'manual',
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).viewer_sort.modes['']).toBe('manual');

    // A group is list-wide here — passing one is rejected (don't guess).
    const bad = await http(t).put('/api/sort/mode', {
      list_key: 'favorites',
      group: 'favorites',
      mode: 'recent',
    });
    expect(bad.status).toBe(400);
  });

  it('rejects touch on list_key=favorites (no own recent state — touch the home entity)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    await http(t).post(`/api/workspaces/${wsId}/star`);

    const r = await http(t).post('/api/sort/touch', {
      list_key: 'favorites',
      entity_id: `workspace:${wsId}`,
    });
    expect(r.status).toBe(400);
    // No dead last_accessed_at row written under list_key='favorites' — recent
    // reads the HOME list's last_accessed_at, so favorites stores no recency.
    const row = t.ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'favorites' AND last_accessed_at IS NOT NULL`,
      )
      .get() as any;
    expect(row.n).toBe(0);
  });
});

