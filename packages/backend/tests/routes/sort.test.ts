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

  it('workspace + channel list responses carry viewer_sort, default mode recent / empty', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(wsList.viewer_sort).toMatchObject({
      list_key: 'workspaces',
      mode: 'recent',
      entries: [],
    });

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(chList.viewer_sort).toMatchObject({
      list_key: `channels:${wsId}`,
      mode: 'recent',
      entries: [],
    });
  });
});

describe('PUT /api/sort/mode', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('upserts the per-list mode and reflects it on the list response', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);

    const res = await http(t).put('/api/sort/mode', {
      list_key: 'workspaces',
      mode: 'manual',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).viewer_sort.mode).toBe('manual');

    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    expect(wsList.viewer_sort.mode).toBe('manual');
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
      group: 'unpinned',
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

    // Pin c1 → it leaves the 'unpinned' group.
    expect((await http(t).post(`/api/channels/${c1}/pin`, undefined)).status).toBe(200);

    const res = await http(t).put('/api/sort/order', {
      list_key: `channels:${wsId}`,
      group: 'unpinned',
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
      group: 'unpinned',
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
      group: 'unpinned',
      ordered_ids: allIds,
    });
    expect(full.status).toBe(200);
    const ranksBefore = ((await full.json()) as any).viewer_sort.entries as any[];

    // Send only two of the three → 400 (partial / would collide), ranks unchanged.
    const partial = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unpinned',
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
      group: 'unpinned',
      ordered_ids: [c1, c1],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a group not legal for the list kind, even with empty ordered_ids', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    await makeWorkspace(t, 'eng', agentId);
    // 'pinned' is a channel-sidebar group, not a workspace-rail group.
    const res = await http(t).put('/api/sort/order', {
      list_key: 'workspaces',
      group: 'pinned',
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

    // Default mode is 'recent' — never set it manually.
    const before = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(before.viewer_sort.mode).toBe('recent');

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allIds: string[] = chList.channels.map((c: any) => c.id);
    const res = await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unpinned',
      ordered_ids: [...allIds].reverse(),
    });
    expect(res.status).toBe(200);
    // Response reflects the atomic mode flip…
    expect(((await res.json()) as any).viewer_sort.mode).toBe('manual');
    // …and it persists on the next list read.
    const after = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    expect(after.viewer_sort.mode).toBe('manual');
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

describe('pin/unpin clears manual rank (cross-group boundary)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('clears an entity rank when it is pinned', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const wsId = await makeWorkspace(t, 'eng', agentId);
    const c1 = await makeChannel(t, wsId, 'one', agentId);
    const c2 = await makeChannel(t, wsId, 'two', agentId);
    const listKey = `channels:${wsId}`;

    const chList = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const allUnpinned = chList.channels.map((c: any) => c.id);
    await http(t).put('/api/sort/order', {
      list_key: listKey,
      group: 'unpinned',
      ordered_ids: [c1, c2, ...allUnpinned.filter((id: string) => id !== c1 && id !== c2)],
    });

    // c1 had a rank; pinning it must drop the rank to null (it moves groups).
    expect((await http(t).post(`/api/channels/${c1}/pin`, undefined)).status).toBe(200);
    const after = (await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json()) as any;
    const c1Entry = after.viewer_sort.entries.find((e: any) => e.entity_id === c1);
    // Either no rank row, or rank cleared to null.
    expect(c1Entry?.rank ?? null).toBeNull();
  });
});
