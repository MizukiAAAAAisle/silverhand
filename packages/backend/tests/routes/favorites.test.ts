import { afterEach, describe, expect, it } from 'vitest';
import { encodeUserPrincipalHeader, X_SILVERHAND_PRINCIPAL_HEADER } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Favorites read-model (#task:1252, re-scoped by #task:1888): the viewer's flat
// global STARRED list, a read projection of `user_sort_entry.starred_at` for the
// per-workspace CONVERSATION lists (`list_key='channels:<ws_id>'`). A workspace /
// DM container cannot be starred at all (#task:1899); a pre-#1899 container row
// is inert. See packages/backend/src/read-model/favorites.ts.

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

  it('projects a starred channel with server-resolved PARENT identity; a pre-#1899 container star row stays inert', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);

    expect((await http(t).post(`/api/channels/${chId}/star`)).status).toBe(200);
    // A container can no longer be starred through any route (#task:1899), so the
    // only way such a row can exist is as a leftover from before the retirement.
    // Those are deliberately neither migrated nor deleted, which is only safe if
    // they are unreachable — write one directly and prove it projects nothing.
    t.ctx.db
      .prepare(
        `INSERT INTO user_sort_entry (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
         VALUES ('local', 'workspaces', ?, NULL, NULL, ?)`,
      )
      .run(wsId, Date.now());

    const items = await favorites(t);
    const ch = items.find(i => i.entity_id === chId);

    expect(ch).toMatchObject({
      kind: 'channel',
      favorite_key: `channel:${chId}`,
      entity_id: chId,
      // The PARENT workspace — no longer the entity itself (#task:1888).
      workspace_id: wsId,
      title: 'general',
      // Parent identity is server-resolved so the renderer joins nothing. It is
      // TEXT only — there is no parent glyph/runtime field (#task:1888).
      parent_title: 'eng',
      // No non-system messages yet → caught-up rollup is 0 (not null).
      unread_count: 0,
    });
    expect(typeof ch.starred_at).toBe('number');

    // The orphan row is still on disk…
    const wsStar = t.ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'workspaces' AND entity_id = ? AND starred_at IS NOT NULL`,
      )
      .get(wsId) as any;
    expect(wsStar.n).toBe(1);
    // …and reaches nothing: the global STARRED list holds CONVERSATIONS only.
    expect(items.find(i => i.entity_id === wsId)).toBeUndefined();
  });

  it('orders rows by starred_at DESC (most-recently-starred first)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);
    const c2 = await makeChannel(t, wsId, 'two', agentId);
    await http(t).post(`/api/channels/${c1}/star`);
    await http(t).post(`/api/channels/${c2}/star`);

    // c1 starred earlier, c2 later (both in the home list channels:<ws_id>).
    setStarredAt(t, `channels:${wsId}`, c1, 1000);
    setStarredAt(t, `channels:${wsId}`, c2, 2000);

    const items = await favorites(t);
    expect(items.map(i => i.entity_id)).toEqual([c2, c1]);
  });

  it('projects a starred dm_channel with the bound agent as PARENT (kind="dm_channel")', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'rover');
    const { wsId: dmWsId, dmChannelId } = dmOf(t, agentId);

    expect((await http(t).post(`/api/channels/${dmChannelId}/star`)).status).toBe(200);

    const items = await favorites(t);
    const dm = items.find(i => i.entity_id === dmChannelId);
    expect(dm).toMatchObject({
      kind: 'dm_channel',
      favorite_key: `dm_channel:${dmChannelId}`,
      entity_id: dmChannelId,
      workspace_id: dmWsId,
      // Agent-home parent → identity comes from the bound agent.
      parent_title: 'rover', // agent name (no display_name set)
    });
    expect(typeof dm.title).toBe('string');
  });

  // Membership ≡ the star endpoint's own live set: a browseable PUBLIC channel the
  // viewer has not joined is star-able, so it must also be projectable. Reducing
  // the predicate to a `conversation_users` join would silently drop it.
  it('projects a starred unjoined PUBLIC channel; an unjoined private one is not even star-able', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    // teammate: workspace member, but NOT a member of the channels below.
    t.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(wsId, 'teammate', Date.now());
    const asTeammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const mkChannel = async (title: string, visibility?: 'public') => {
      const r = await http(t!).post(`/api/workspaces/${wsId}/channels`, {
        title,
        member_agent_ids: [],
        ...(visibility ? { visibility } : {}),
      });
      return ((await r.json()) as any).channel.id as string;
    };
    const pubUnjoined = await mkChannel('pub-unjoined', 'public');
    const privUnjoined = await mkChannel('priv-unjoined');

    expect((await asTeammate.post(`/api/channels/${pubUnjoined}/star`)).status).toBe(200);
    // Not in teammate's visible set → not a star target at all.
    expect((await asTeammate.post(`/api/channels/${privUnjoined}/star`)).status).toBe(404);

    const r = await asTeammate.get('/api/favorites');
    expect(r.status).toBe(200);
    const items = ((await r.json()) as any).items as any[];
    expect(items.map(i => i.entity_id)).toEqual([pubUnjoined]);
    expect(items[0]).toMatchObject({ kind: 'channel', workspace_id: wsId, parent_title: 'eng' });
  });

  it('hides an archived channel and a channel under an archived workspace (storage row preserved)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsA = await makeWorkspace(t, 'eng', agentId);
    const wsB = await makeWorkspace(t, 'ops', agentId);
    const chA = await makeChannel(t, wsA, 'general', agentId);
    const chB = await makeChannel(t, wsB, 'general', agentId);
    await http(t).post(`/api/channels/${chA}/star`);
    await http(t).post(`/api/channels/${chB}/star`);

    // Archive the conversation on one side and the PARENT workspace on the other
    // (directly — the star rows stay in user_sort_entry).
    t.ctx.db.prepare(`UPDATE conversations SET archived_at = 1 WHERE id = ?`).run(chA);
    t.ctx.db.prepare(`UPDATE workspaces SET archived_at = 1 WHERE id = ?`).run(wsB);

    expect(await favorites(t)).toEqual([]);
    // Both star rows persist (each favorite reappears on restore).
    const rows = t.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM user_sort_entry WHERE user_id = 'local' AND starred_at IS NOT NULL`)
      .get() as any;
    expect(rows.n).toBe(2);
  });

  it('hides favorites the viewer can no longer access (channel or workspace membership dropped)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsA = await makeWorkspace(t, 'eng', agentId);
    const wsB = await makeWorkspace(t, 'ops', agentId);
    const chA = await makeChannel(t, wsA, 'general', agentId);
    const chB = await makeChannel(t, wsB, 'general', agentId);
    await http(t).post(`/api/channels/${chA}/star`);
    await http(t).post(`/api/channels/${chB}/star`);

    // chA: left the (private) channel — no conversation membership, no public arm.
    t.ctx.db.prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`).run(chA);
    // chB: removed from the parent workspace entirely.
    t.ctx.db.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`).run(wsB);

    expect(await favorites(t)).toEqual([]);
  });

  it('returns empty for a viewer with no stars', async () => {
    t = buildTestApp();
    await makeAgent(t, 'alice');
    expect(await favorites(t)).toEqual([]);
  });

  it('populates unread_count per CONVERSATION from the canonical rollup (#task:1254)', async () => {
    // The STARRED badge is filled server-side from the SAME ROLLUP_UNREAD
    // predicate the in-tree channel row uses, keyed by CONVERSATION — so a
    // sibling channel's unread never inflates this row (which a per-workspace
    // rollup would).
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    const sibling = await makeChannel(t, wsId, 'random', agentId);
    await http(t).post(`/api/channels/${chId}/star`);
    await http(t).post(`/api/channels/${sibling}/star`);

    // Two unread agent mainline messages in `chId`. The viewer 'local' has no
    // conversation_reads cursor → any seq > 0 counts. A system message and the
    // viewer's OWN message do NOT (ROLLUP_UNREAD excludes both).
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
    expect(items.find(i => i.entity_id === chId).unread_count).toBe(2);
    // The sibling favorite stays caught up — per-conversation, not per-workspace.
    expect(items.find(i => i.entity_id === sibling).unread_count).toBe(0);
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
    const chId = await makeChannel(t, wsId, 'general', agentId);
    const { wsId: dmWsId, dmChannelId } = dmOf(t, agentId);
    await http(t).post(`/api/channels/${chId}/star`);
    await http(t).post(`/api/channels/${dmChannelId}/star`);
    setStarredAt(t, `channels:${wsId}`, chId, 1000);
    setStarredAt(t, `channels:${dmWsId}`, dmChannelId, 2000);
    setHomeAccessed(t, `channels:${wsId}`, chId, 7000);
    setHomeAccessed(t, `channels:${dmWsId}`, dmChannelId, 8000);

    const { items, viewer_sort } = await favoritesFull(t);
    expect(viewer_sort.list_key).toBe('favorites');

    // Rows carry the favorite_key (kind-qualified) + created_at.
    const chRow = items.find(i => i.entity_id === chId);
    const dmRow = items.find(i => i.entity_id === dmChannelId);
    expect(chRow.favorite_key).toBe(`channel:${chId}`);
    expect(dmRow.favorite_key).toBe(`dm_channel:${dmChannelId}`);
    expect(typeof chRow.created_at).toBe('number');

    // Entries are keyed by favorite_key and carry rank + HOME last_accessed_at +
    // starred_at — never the favorites row's own (null) last_accessed.
    const byKey = Object.fromEntries(
      viewer_sort.entries.map((e: any) => [e.entity_id, e]),
    );
    expect(byKey[`channel:${chId}`]).toMatchObject({
      rank: null,
      last_accessed_at: 7000,
      starred_at: 1000,
    });
    expect(byKey[`dm_channel:${dmChannelId}`]).toMatchObject({
      rank: null,
      last_accessed_at: 8000,
      starred_at: 2000,
    });
  });

  it('reorder via list_key=favorites writes per-favorite_key ranks (manual mode)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    const { dmChannelId } = dmOf(t, agentId);
    await http(t).post(`/api/channels/${chId}/star`);
    await http(t).post(`/api/channels/${dmChannelId}/star`);

    const chKey = `channel:${chId}`;
    const dmKey = `dm_channel:${dmChannelId}`;
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [dmKey, chKey],
    });
    expect(r.status).toBe(200);
    const vs = ((await r.json()) as any).viewer_sort;
    expect(vs.list_key).toBe('favorites');
    expect(vs.modes['']).toBe('manual'); // order ⟹ manual on the list-wide scope
    const byKey = Object.fromEntries(vs.entries.map((e: any) => [e.entity_id, e]));
    expect(byKey[dmKey].rank).toBe(0);
    expect(byKey[chKey].rank).toBe(1);
  });

  it('rejects a reorder id that is not a kind-qualified favorite_key', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/channels/${chId}/star`);

    // Bare entity_id (not `channel:<id>`) is not a member of the favorites group.
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [chId],
    });
    expect(r.status).toBe(400);
  });

  it('favorites reorder does NOT disturb the home-list (conversation list) ranks', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    const { dmChannelId } = dmOf(t, agentId);
    await http(t).post(`/api/channels/${chId}/star`);
    await http(t).post(`/api/channels/${dmChannelId}/star`);

    // Give the channel a manual rank in its HOME conversation list.
    t.ctx.db
      .prepare(
        `UPDATE user_sort_entry SET rank = 5 WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`,
      )
      .run(`channels:${wsId}`, chId);

    // Reorder the FAVORITES list.
    const r = await http(t).put('/api/sort/order', {
      list_key: 'favorites',
      group: 'favorites',
      ordered_ids: [`dm_channel:${dmChannelId}`, `channel:${chId}`],
    });
    expect(r.status).toBe(200);

    // The home rank is untouched — favorites ordering is its own axis.
    const homeRank = t.ctx.db
      .prepare<[string, string], { rank: number | null }>(
        `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`,
      )
      .get(`channels:${wsId}`, chId);
    expect(homeRank?.rank).toBe(5);
  });

  it('unstar DROPS the favorite_key rank orphan (re-star re-enters fresh; HOME rank kept) — #task:1888 exclusive', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    const { dmChannelId } = dmOf(t, agentId);
    await http(t).post(`/api/channels/${chId}/star`);
    await http(t).post(`/api/channels/${dmChannelId}/star`);
    const chKey = `channel:${chId}`;
    const dmKey = `dm_channel:${dmChannelId}`;

    // Manually arrange favorites → both get a rank under list_key='favorites'.
    expect(
      (await http(t).put('/api/sort/order', {
        list_key: 'favorites',
        group: 'favorites',
        ordered_ids: [dmKey, chKey],
      })).status,
    ).toBe(200);
    // Give the channel a HOME rank too, to prove it is NOT touched.
    t.ctx.db
      .prepare(
        `UPDATE user_sort_entry SET rank = 9 WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`,
      )
      .run(`channels:${wsId}`, chId);

    const db = t.ctx.db;
    const favRank = (key: string) =>
      db
        .prepare<[string], { rank: number | null }>(
          `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = 'favorites' AND entity_id = ?`,
        )
        .get(key);
    expect(favRank(chKey)?.rank).toBe(1);
    expect(favRank(dmKey)?.rank).toBe(0);

    // Unstar the channel → its FAVORITES rank orphan is deleted (voluntary
    // removal), but the DM's favorites rank and the channel's HOME rank survive.
    expect((await http(t).del(`/api/channels/${chId}/star`)).status).toBe(200);
    expect(favRank(chKey)).toBeUndefined();
    expect(favRank(dmKey)?.rank).toBe(0);
    const homeRank = t.ctx.db
      .prepare<[string, string], { rank: number | null }>(
        `SELECT rank FROM user_sort_entry WHERE user_id = 'local' AND list_key = ? AND entity_id = ?`,
      )
      .get(`channels:${wsId}`, chId);
    expect(homeRank?.rank).toBe(9);

    // Re-star → re-enters FRESH (no rank), never jumping to the old slot 1.
    expect((await http(t).post(`/api/channels/${chId}/star`)).status).toBe(200);
    expect(favRank(chKey)?.rank ?? null).toBeNull();
  });

  it('mode toggle on favorites is persisted list-wide (scope "")', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/channels/${chId}/star`);

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
    const chId = await makeChannel(t, wsId, 'general', agentId);
    await http(t).post(`/api/channels/${chId}/star`);

    const r = await http(t).post('/api/sort/touch', {
      list_key: 'favorites',
      entity_id: `channel:${chId}`,
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
