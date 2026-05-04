import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t.app).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = await r.json() as any;
  // Reset spawn-related sinks so per-test assertions only see channel work.
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMissing(path: string, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fs.stat(path);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await delay(10);
  }
  throw new Error(`expected ${path} to be removed`);
}

describe('POST /api/channels (provision)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates channel + workspace dir + onboarding session + auto-spawns members', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const bobId = await makeAgent(t, 'bob');

    const res = await http(t.app).post('/api/channels', {
      name: 'eng',
      description: 'engineering',
      member_agent_ids: [aliceId, bobId],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.channel.name).toBe('eng');
    expect(body.channel.kind).toBe('regular');
    expect(typeof body.onboarding_session_id).toBe('string');

    // workspace dir + .silverhand were initialized
    const consensus = join(body.channel.workspace_path, '.silverhand', 'CONSENSUS.md');
    expect((await fs.stat(consensus)).isFile()).toBe(true);

    // both members got delivered + start
    const startedAgents = t.fake.starts.map(s => s.agentId).sort();
    expect(startedAgents).toEqual([aliceId, bobId].sort());
    expect(t.fake.delivered).toHaveLength(2);
    expect(
      t.fake.delivered.every(d => d.sessionId === body.onboarding_session_id),
    ).toBe(true);

    // members listed under the channel
    const members = await (
      await http(t.app).get(`/api/channels/${body.channel.id}/members`)
    ).json() as any;
    expect(members.members.map((m: any) => m.id).sort()).toEqual(
      [aliceId, bobId].sort(),
    );
  });

  it('parallel L1/L2 seeding: 3-member channel seeds all agents without dropping any', async () => {
    // Regression guard for the parallelized seedAgentL2 path: Promise.all
    // across 3 agents must not lose any member compared with the old
    // sequential loop. We verify both the filesystem artifacts and the
    // in-memory delivery/start records.
    t = buildTestApp();
    const a1 = await makeAgent(t, 'p1');
    const a2 = await makeAgent(t, 'p2');
    const a3 = await makeAgent(t, 'p3');

    const res = await http(t.app).post('/api/channels', {
      name: 'parallel-seed',
      member_agent_ids: [a1, a2, a3],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;

    // All 3 L2 agent dirs must be seeded with system_prompt.md.
    for (const agentId of [a1, a2, a3]) {
      const systemPrompt = join(
        body.channel.workspace_path,
        '.silverhand', 'agents', agentId, 'system_prompt.md',
      );
      expect((await fs.stat(systemPrompt)).isFile()).toBe(true);
    }

    // All 3 members appear in the channel roster.
    const members = await (
      await http(t.app).get(`/api/channels/${body.channel.id}/members`)
    ).json() as any;
    expect(members.members.map((m: any) => m.id).sort()).toEqual(
      [a1, a2, a3].sort(),
    );

    // All 3 got delivered + started (onboarding).
    expect(t.fake.starts.map((s: any) => s.agentId).sort()).toEqual(
      [a1, a2, a3].sort(),
    );
    expect(t.fake.delivered).toHaveLength(3);
  });

  it('returns 400 on invalid name (regex)', async () => {
    t = buildTestApp();
    const res = await http(t.app).post('/api/channels', { name: 'has spaces' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate channel name', async () => {
    t = buildTestApp();
    await http(t.app).post('/api/channels', { name: 'eng' });
    const dup = await http(t.app).post('/api/channels', { name: 'eng' });
    expect(dup.status).toBe(409);
  });

  it('silently skips unknown member ids without failing the request', async () => {
    t = buildTestApp();
    const res = await http(t.app).post('/api/channels', {
      name: 'mixed',
      member_agent_ids: ['does-not-exist'],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    const members = await (
      await http(t.app).get(`/api/channels/${body.channel.id}/members`)
    ).json() as any;
    expect(members.members).toHaveLength(0);
  });
});

describe('DELETE /api/channels/:id', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns after DB deletion without waiting for hard-stop cleanup', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'slow-delete');
    const ch = await (
      await http(t.app).post('/api/channels', {
        name: 'delete-me',
        member_agent_ids: [agentId],
      })
    ).json() as any;

    let releaseStop!: () => void;
    const stopBlocked = new Promise<void>(resolve => {
      releaseStop = resolve;
    });
    const originalStop = t.fake.stop.bind(t.fake);
    t.fake.stop = async (...args: Parameters<TestApp['fake']['stop']>) => {
      await originalStop(...args);
      await stopBlocked;
    };

    const dotDir = join(ch.channel.workspace_path, '.silverhand');
    const deletePromise = http(t.app).del(`/api/channels/${ch.channel.id}`);

    try {
      const result = await Promise.race([
        deletePromise,
        delay(75).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout') {
        throw new Error('delete request waited for hard-stop cleanup');
      }
      expect(result.status).toBe(204);
      expect(t.fake.stops).toMatchObject([
        { sessionId: ch.onboarding_session_id, agentId, mode: 'hard' },
      ]);

      const list = await (await http(t.app).get('/api/channels')).json() as any;
      expect(list.channels.some((c: any) => c.id === ch.channel.id)).toBe(false);
      expect((await fs.stat(dotDir)).isDirectory()).toBe(true);
    } finally {
      releaseStop();
      await deletePromise.catch(() => undefined);
    }

    await waitForMissing(dotDir);
  });
});

describe('Channel members', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET members → 404 for unknown channel', async () => {
    t = buildTestApp();
    const r = await http(t.app).get('/api/channels/unknown/members');
    expect(r.status).toBe(404);
  });

  it('POST member rejects unknown agent_id with 404', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'ops' })
    ).json() as any;
    const r = await http(t.app).post(`/api/channels/${ch.channel.id}/members`, {
      agent_id: 'nope',
    });
    expect(r.status).toBe(404);
  });

  it('POST + DELETE member round-trip', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'ops2' })
    ).json() as any;
    const aId = await makeAgent(t, 'carol');
    const add = await http(t.app).post(
      `/api/channels/${ch.channel.id}/members`,
      { agent_id: aId },
    );
    expect(add.status).toBe(201);

    const list1 = await (
      await http(t.app).get(`/api/channels/${ch.channel.id}/members`)
    ).json() as any;
    expect(list1.members.map((m: any) => m.id)).toContain(aId);

    const rm = await http(t.app).del(`/api/channels/${ch.channel.id}/members/${aId}`);
    expect(rm.status).toBe(204);
    const list2 = await (
      await http(t.app).get(`/api/channels/${ch.channel.id}/members`)
    ).json() as any;
    expect(list2.members.map((m: any) => m.id)).not.toContain(aId);
  });
});

describe('PATCH /api/channels/:id (rename)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('renames the channel and broadcasts a system message into open root sessions', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const ch = await (
      await http(t.app).post('/api/channels', {
        name: 'old',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    // Reset spawn-related sinks so the rename's distribution shows
    // up cleanly.
    t.fake.delivered = [];

    const res = await http(t.app).patch(`/api/channels/${ch.channel.id}`, {
      name: 'newname',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel.name).toBe('newname');

    // Persisted: GET /api/channels reflects new name.
    const list = await (await http(t.app).get('/api/channels')).json() as any;
    const updated = list.channels.find((c: any) => c.id === ch.channel.id);
    expect(updated.name).toBe('newname');

    // System message went into the onboarding (sole open root) session
    // and was delivered to the (one) member's inbox.
    const msgs = await (
      await http(t.app).get(`/api/sessions/${ch.onboarding_session_id}/messages`)
    ).json() as any;
    const renameMsg = msgs.messages.find(
      (m: any) => m.metadata?.subtype === 'rename',
    );
    expect(renameMsg).toBeTruthy();
    expect(renameMsg.metadata.old_name).toBe('old');
    expect(renameMsg.metadata.new_name).toBe('newname');
    expect(renameMsg.content).toContain('#old');
    expect(renameMsg.content).toContain('#newname');

    expect(t.fake.delivered.some(d => d.messageId === renameMsg.id)).toBe(true);
  });

  it('returns 409 when the new name is already taken by a different channel', async () => {
    t = buildTestApp();
    await http(t.app).post('/api/channels', { name: 'foo' });
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'bar' })
    ).json() as any;
    const res = await http(t.app).patch(`/api/channels/${ch.channel.id}`, {
      name: 'foo',
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 when the new name fails the regex', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'ok' })
    ).json() as any;
    const res = await http(t.app).patch(`/api/channels/${ch.channel.id}`, {
      name: 'has spaces',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when called on a DM channel', async () => {
    t = buildTestApp();
    // Creating an agent auto-provisions a DM channel.
    const r = await http(t.app).post('/api/agents', {
      name: 'solo',
      runtime: 'claude',
    });
    const body = await r.json() as any;
    const dmId = body.dm_channel_id;
    const res = await http(t.app).patch(`/api/channels/${dmId}`, {
      name: 'rename-attempt',
    });
    expect(res.status).toBe(400);
  });

  it('no-op rename to current name returns 200 without inserting a system message', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'same' })
    ).json() as any;
    t.fake.delivered = [];

    const res = await http(t.app).patch(`/api/channels/${ch.channel.id}`, {
      name: 'same',
    });
    expect(res.status).toBe(200);
    const msgs = await (
      await http(t.app).get(`/api/sessions/${ch.onboarding_session_id}/messages`)
    ).json() as any;
    expect(
      msgs.messages.some((m: any) => m.metadata?.subtype === 'rename'),
    ).toBe(false);
    expect(t.fake.delivered).toHaveLength(0);
  });

  it('returns 404 for unknown channel id', async () => {
    t = buildTestApp();
    const res = await http(t.app).patch('/api/channels/does-not-exist', {
      name: 'whatever',
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/channels/:id/archive', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('flips archived_at on/off and surfaces it in the channel DTO', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'attic' })
    ).json() as any;
    expect(ch.channel.archived_at).toBeNull();

    const archived = await (
      await http(t.app).patch(`/api/channels/${ch.channel.id}/archive`, {
        archived: true,
      })
    ).json() as any;
    expect(archived.channel.archived_at).toBeGreaterThan(0);

    // GET /api/channels reflects the flip — sidebar reads from this list.
    const list = await (await http(t.app).get('/api/channels')).json() as any;
    const row = list.channels.find((c: any) => c.id === ch.channel.id);
    expect(row.archived_at).toEqual(archived.channel.archived_at);

    const restored = await (
      await http(t.app).patch(`/api/channels/${ch.channel.id}/archive`, {
        archived: false,
      })
    ).json() as any;
    expect(restored.channel.archived_at).toBeNull();
  });

  it('no-op when already in the requested state — same row, no error', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'static' })
    ).json() as any;
    const res = await http(t.app).patch(
      `/api/channels/${ch.channel.id}/archive`,
      { archived: false },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel.archived_at).toBeNull();
  });

  it('returns 400 on bad body shape', async () => {
    t = buildTestApp();
    const ch = await (
      await http(t.app).post('/api/channels', { name: 'shape' })
    ).json() as any;
    const res = await http(t.app).patch(
      `/api/channels/${ch.channel.id}/archive`,
      { wrong: 'field' },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown channel id', async () => {
    t = buildTestApp();
    const res = await http(t.app).patch(
      '/api/channels/missing/archive',
      { archived: true },
    );
    expect(res.status).toBe(404);
  });
});
