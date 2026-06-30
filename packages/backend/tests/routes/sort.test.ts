import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

async function makeWorkspace(t: TestApp, name: string, agentId: string): Promise<string> {
  const r = await http(t).post('/api/workspaces', {
    name,
    member_agent_ids: [agentId],
  });
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

describe('list sort — viewer state on list responses', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('workspace + channel list responses carry viewer_sort, default empty modes', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(wsList.viewer_sort).toMatchObject({
      list_key: 'workspaces',
      entries: [],
    });
    // No mode rows yet → empty map (every scope defaults to 'recent').
    expect(wsList.viewer_sort.modes).toEqual({});

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(chList.viewer_sort).toMatchObject({
      list_key: `channels:${wsId}`,
      entries: [],
    });
    expect(chList.viewer_sort.modes).toEqual({});
  });
});

describe('PUT /api/sort/mode', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('upserts a channel list-wide mode (scope "") and reflects it on the list', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const listKey = `channels:${wsId}`;

    const res = await http(t).put('/api/sort/mode', { list_key: listKey, mode: 'manual' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).viewer_sort.modes['']).toBe('manual');

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(chList.viewer_sort.modes['']).toBe('manual');
  });

  it('upserts ONE rail section mode (per-group scope), leaving sibling scopes untouched', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);

    const res = await http(t).put('/api/sort/mode', {
      list_key: 'workspaces',
      group: 'regular',
      mode: 'manual',
    });
    expect(res.status).toBe(200);
    const modes = ((await res.json()) as any).viewer_sort.modes;
    expect(modes.regular).toBe('manual');
    // Only the toggled scope is written — `pinned` / `dm` stay at default.
    expect(modes.pinned).toBeUndefined();
    expect(modes.dm).toBeUndefined();

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(wsList.viewer_sort.modes.regular).toBe('manual');
  });

  it('rejects a workspaces mode set without a group (rail mode is per-section)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);
    const res = await http(t).put('/api/sort/mode', { list_key: 'workspaces', mode: 'manual' });
    expect(res.status).toBe(400);
  });

  it('rejects a channel mode set that carries a group (channel is list-wide)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const res = await http(t).put('/api/sort/mode', {
      list_key: `channels:${wsId}`,
      group: 'starred',
      mode: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid list_key', async () => {
    t = buildTestApp();
    const res = await http(t).put('/api/sort/mode', {
      list_key: 'bogus',
      mode: 'manual',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a nonexistent channel list_key (404) — no arbitrary preference writes', async () => {
    t = buildTestApp();
    const res = await http(t).put('/api/sort/mode', {
      list_key: 'channels:ghost-workspace',
      mode: 'manual',
    });
    expect(res.status).toBe(404);
  });

  // The 403 branch (visible-but-not-member workspace) shares the identical
  // `resolveListGroups` gate the 404 test exercises, but isn't constructible
  // here: this harness's single-human model auto-adds every registered user as
  // a member of every workspace, so `canViewWorkspace` never returns false for
  // a human. Left to integration/multi-human v2.
});

describe('POST /api/sort/touch', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('stamps recent-opened for a real entity and surfaces it on the list', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);

    const res = await http(t).post('/api/sort/touch', {
      list_key: 'workspaces',
      entity_id: wsId,
    });
    expect(res.status).toBe(200);

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    const entry = wsList.viewer_sort.entries.find((e: any) => e.entity_id === wsId);
    expect(entry).toBeTruthy();
    expect(typeof entry.last_accessed_at).toBe('number');
    expect(entry.rank).toBeNull();
  });

  it('rejects an unknown entity_id for the list', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);
    const res = await http(t).post('/api/sort/touch', {
      list_key: 'workspaces',
      entity_id: 'does-not-exist',
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/sort/order', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('assigns dense ranks within a group from ordered_ids', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);
    const c2 = await makeChannel(t, wsId, 'two', agentId);

    // All channels are unpinned; reorder them as [c2, c1].
    const listKey = `channels:${wsId}`;
    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allIds = chList.channels.map((c: any) => c.id);
    expect(allIds).toContain(c1);
    expect(allIds).toContain(c2);

    const ordered = [c2, c1, ...allIds.filter((id: string) => id !== c1 && id !== c2)];
    const res = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unstarred',
      ordered_ids: ordered,
    });
    expect(res.status).toBe(200);
    const entries = ((await res.json()) as any).viewer_sort.entries as any[];
    const rankOf = (id: string) => entries.find(e => e.entity_id === id)?.rank;
    expect(rankOf(c2)).toBe(0);
    expect(rankOf(c1)).toBe(1);
  });

  it('rejects ordered_ids that contain an id not in the declared group', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);

    // Star c1 → it leaves the 'unstarred' group.
    expect((await http(t).post(`/api/channels/${c1}/star`, undefined)).status).toBe(200);

    const res = await http(t).put('/api/sort/order', {
      list_key: `channels:${wsId}`,
      group: 'unstarred',
      ordered_ids: [c1],
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown ids', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const res = await http(t).put('/api/sort/order', {
      list_key: `channels:${wsId}`,
      group: 'unstarred',
      ordered_ids: ['ghost'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a partial ordered_ids (must cover the whole live group) and leaves ranks intact', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    await makeChannel(t, wsId, 'one', agentId);
    await makeChannel(t, wsId, 'two', agentId);
    const listKey = `channels:${wsId}`;

    // 3 live unpinned channels (onboarding + two). Establish a full order.
    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allIds: string[] = chList.channels.map((c: any) => c.id);
    expect(allIds.length).toBe(3);
    const full = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unstarred',
      ordered_ids: allIds,
    });
    expect(full.status).toBe(200);
    const ranksBefore = ((await full.json()) as any).viewer_sort.entries as any[];

    // Send only two of the three → 400 (partial / would collide), ranks unchanged.
    const partial = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unstarred',
      ordered_ids: allIds.slice(0, 2),
    });
    expect(partial.status).toBe(400);

    const after = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const rankOf = (entries: any[], id: string) =>
      entries.find(e => e.entity_id === id)?.rank;
    for (const id of allIds) {
      expect(rankOf(after.viewer_sort.entries, id)).toBe(rankOf(ranksBefore, id));
    }
  });

  it('rejects duplicate ids in ordered_ids', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);
    const res = await http(t).put('/api/sort/order', {
      list_key: `channels:${wsId}`,
      group: 'unstarred',
      ordered_ids: [c1, c1],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a group not legal for the list kind, even with empty ordered_ids', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);
    // 'unstarred' is a channel-sidebar group, not a workspace-rail group
    // (the rail uses pinned / dm / regular).
    const res = await http(t).put('/api/sort/order', {
      list_key: 'workspaces',
      group: 'unstarred',
      ordered_ids: [],
    });
    expect(res.status).toBe(400);
  });

  it('a reorder switches the list to manual mode atomically (order ⟹ manual)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    await makeChannel(t, wsId, 'one', agentId);
    await makeChannel(t, wsId, 'two', agentId);
    const listKey = `channels:${wsId}`;

    // Default: no mode row → channel reads 'recent' (scope '' absent).
    const before = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(before.viewer_sort.modes['']).toBeUndefined();

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allIds: string[] = chList.channels.map((c: any) => c.id);
    const res = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unstarred',
      ordered_ids: [...allIds].reverse(),
    });
    expect(res.status).toBe(200);
    // Response reflects the atomic mode flip on the list-wide scope ''…
    expect(((await res.json()) as any).viewer_sort.modes['']).toBe('manual');
    // …and it persists on the next list read.
    const after = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(after.viewer_sort.modes['']).toBe('manual');
  });

  it('a rail reorder flips ONLY the dragged section scope to manual', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const a = await makeWorkspace(t, 'alpha', agentId);
    const b = await makeWorkspace(t, 'beta', agentId);

    // Drag the (unpinned) `regular` rail section.
    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    const regularIds = wsList.workspaces
      .filter((w: any) => w.workspace_kind === 'regular' && w.archived_at == null)
      .map((w: any) => w.id);
    expect(regularIds).toEqual(expect.arrayContaining([a, b]));

    const res = await http(t).put('/api/sort/order', {
      list_key: 'workspaces',
      group: 'regular',
      ordered_ids: [...regularIds].reverse(),
    });
    expect(res.status).toBe(200);
    const modes = ((await res.json()) as any).viewer_sort.modes;
    expect(modes.regular).toBe('manual');
    // The `pinned` / `dm` sections keep their own (default) mode — no rail-wide flip.
    expect(modes.pinned).toBeUndefined();
    expect(modes.dm).toBeUndefined();
  });
});

describe('viewer_sort does not leak non-live entities', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('drops a stale entry from the channel list once the channel is no longer live (archived)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);

    // Stamp recent-opened for c1, then archive it (leaves the active list).
    expect((await http(t).post('/api/sort/touch', { list_key: `channels:${wsId}`, entity_id: c1 })).status).toBe(200);
    expect((await http(t).patch(`/api/channels/${c1}/archive`, { archived: true })).status).toBe(200);

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(chList.channels.some((c: any) => c.id === c1)).toBe(false);
    // The stale sort entry must NOT leak on the wire.
    expect(chList.viewer_sort.entries.some((e: any) => e.entity_id === c1)).toBe(false);
  });

  it('drops a stale entry from the workspace rail once the workspace is archived (out of sort scope)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);

    // Stamp recent-opened for the workspace, then archive it.
    expect((await http(t).post('/api/sort/touch', { list_key: 'workspaces', entity_id: wsId })).status).toBe(200);
    expect((await http(t).patch(`/api/workspaces/${wsId}/archive`, { archived: true })).status).toBe(200);

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    // The archived workspace row is still returned (for the Archived group)…
    expect(wsList.workspaces.some((w: any) => w.id === wsId)).toBe(true);
    // …but it is out of sort scope, so its entry must not leak.
    expect(wsList.viewer_sort.entries.some((e: any) => e.entity_id === wsId)).toBe(false);
  });
});

describe('star/unstar rank handling — home rank preserved (exclusive move), starred excluded from home reorder', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('PRESERVES a channel home rank when starred, and restores it on unstar (#task:1252 exclusive)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);
    const c2 = await makeChannel(t, wsId, 'two', agentId);
    const listKey = `channels:${wsId}`;

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allUnstarred = chList.channels.map((c: any) => c.id);
    await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unstarred',
      ordered_ids: [c1, c2, ...allUnstarred.filter((id: string) => id !== c1 && id !== c2)],
    });

    // c1 had rank 0; starring MOVES it to the global STARRED list but its home
    // rank is PRESERVED as an orphan — exclusive star is an involuntary home-hide.
    expect((await http(t).post(`/api/channels/${c1}/star`, undefined)).status).toBe(200);
    const after = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const c1Entry = after.viewer_sort.entries.find((e: any) => e.entity_id === c1);
    expect(c1Entry?.rank).toBe(0); // preserved, not cleared
    expect(c1Entry?.starred_at).not.toBeNull(); // carried so the sidebar hides it

    // Unstar restores it to its home position at rank 0.
    expect((await http(t).del(`/api/channels/${c1}/star`)).status).toBe(200);
    const restored = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const c1Restored = restored.viewer_sort.entries.find((e: any) => e.entity_id === c1);
    expect(c1Restored?.rank).toBe(0);
    expect(c1Restored?.starred_at ?? null).toBeNull();
  });

  it('a starred workspace is EXCLUDED from its home kind-group reorder (moved to global STARRED, #task:1252 exclusive)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const regularWs = await makeWorkspace(t, 'eng', agentId);
    const regularWs2 = await makeWorkspace(t, 'eng2', agentId);

    // The agent's auto-provisioned DM (agent_home) workspace.
    const before = (await (await http(t).get('/api/workspaces')).json()) as any;
    const dmWs = before.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentId,
    );
    expect(dmWs).toBeTruthy();

    // Star one regular ws + the DM — both MOVE to the global STARRED list.
    expect((await http(t).post(`/api/workspaces/${dmWs.id}/star`, undefined)).status).toBe(200);
    expect((await http(t).post(`/api/workspaces/${regularWs}/star`, undefined)).status).toBe(200);

    // `starred` is not a legal workspaces rail group → reorder rejected.
    const starredReorder = await http(t).put('/api/sort/order', {
      list_key: 'workspaces',
      group: 'starred',
      ordered_ids: [dmWs.id, regularWs],
    });
    expect(starredReorder.status).toBe(400);

    // The starred entity is still returned in the rail payload (so the renderer
    // can hide it via its `starred_at`)…
    const list = (await (await http(t).get('/api/workspaces')).json()) as any;
    const regularIds = list.workspaces
      .filter((w: any) => w.workspace_kind === 'regular' && w.archived_at == null)
      .map((w: any) => w.id);
    expect(regularIds).toContain(regularWs);
    expect(
      list.viewer_sort.entries.find((e: any) => e.entity_id === regularWs)?.starred_at,
    ).not.toBeNull();

    // …but a home-group reorder whose ordered_ids INCLUDE the starred entity is
    // rejected — it is no longer a home-group member.
    expect(
      (await http(t).put('/api/sort/order', {
        list_key: 'workspaces',
        group: 'regular',
        ordered_ids: regularIds, // contains the starred regularWs
      })).status,
    ).toBe(400);

    // The correct reorder — only the unstarred member(s) — succeeds.
    expect(
      (await http(t).put('/api/sort/order', {
        list_key: 'workspaces',
        group: 'regular',
        ordered_ids: regularIds.filter((id: string) => id !== regularWs),
      })).status,
    ).toBe(200);
  });

  it('starring/unstarring a workspace PRESERVES its manual rail rank (#task:1252)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsA = await makeWorkspace(t, 'enga', agentId);
    await makeWorkspace(t, 'engb', agentId);

    const list = (await (await http(t).get('/api/workspaces')).json()) as any;
    const regularIds = list.workspaces
      .filter((w: any) => w.workspace_kind === 'regular' && w.archived_at == null)
      .map((w: any) => w.id);
    // Manually order the regular group (dense ranks, wsA first → rank 0).
    await http(t).put('/api/sort/order', {
      list_key: 'workspaces',
      group: 'regular',
      ordered_ids: [wsA, ...regularIds.filter((id: string) => id !== wsA)],
    });
    const rankOf = (body: any) =>
      body.viewer_sort.entries.find((e: any) => e.entity_id === wsA)?.rank ?? null;
    expect(rankOf(await (await http(t).get('/api/workspaces')).json())).toBe(0);

    // Star wsA → on the rail star does NOT change its group, so rank survives.
    expect((await http(t).post(`/api/workspaces/${wsA}/star`, undefined)).status).toBe(200);
    const afterStar = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(rankOf(afterStar)).toBe(0);
    expect(
      afterStar.viewer_sort.entries.find((e: any) => e.entity_id === wsA)?.starred_at,
    ).not.toBeNull();

    // Unstar also preserves the rank.
    expect((await http(t).del(`/api/workspaces/${wsA}/star`)).status).toBe(200);
    expect(rankOf(await (await http(t).get('/api/workspaces')).json())).toBe(0);
  });

  it('a DM workspace can be unstarred (cross-kind unstar)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const list = (await (await http(t).get('/api/workspaces')).json()) as any;
    const dmWs = list.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentId,
    );
    expect((await http(t).post(`/api/workspaces/${dmWs.id}/star`, undefined)).status).toBe(200);
    expect((await http(t).del(`/api/workspaces/${dmWs.id}/star`)).status).toBe(200);
    const after = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(
      after.viewer_sort.entries.find((e: any) => e.entity_id === dmWs.id)?.starred_at ?? null,
    ).toBeNull();
  });
});
