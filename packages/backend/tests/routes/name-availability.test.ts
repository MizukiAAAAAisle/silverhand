import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// #task:1388 — name-availability probe endpoints backing the create-form
// onBlur uniqueness check. The endpoints share ONE predicate with the create
// paths, so "available" here can never contradict a create attempt. The
// load-bearing, non-obvious case is the agent ∪ users cross-namespace check.

describe('GET /api/agents/name-availability', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('reports an unused name as available', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/name-availability?name=freshbot');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, reason: 'available' });
  });

  it('reports an existing agent name as taken', async () => {
    t = buildTestApp();
    await http(t).post('/api/agents', { name: 'takenbot', runtime: 'claude' });
    const res = await http(t).get('/api/agents/name-availability?name=takenbot');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('reports a name colliding with a human user as taken (shared @handle namespace)', async () => {
    t = buildTestApp();
    // Agent names live in the global @-handle namespace shared with users, so a
    // name already held by a human must read as taken — checking `agents` alone
    // would report it available, then create would trip the DB trigger.
    t.ctx.db
      .prepare(
        `INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('u-collide', 'humanhandle', 'Human Handle', 1, 1);
    const res = await http(t).get('/api/agents/name-availability?name=humanhandle');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('reports an invalid format as invalid, not taken', async () => {
    t = buildTestApp();
    const res = await http(t).get(
      `/api/agents/name-availability?name=${encodeURIComponent('bad name!')}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'invalid' });
  });

  it('treats an empty name as invalid', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/name-availability?name=');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'invalid' });
  });

  it('is not shadowed by GET /api/agents/:id', async () => {
    // The static availability segment must resolve the probe, not fall through
    // to the `:id` handler treating "name-availability" as an agent id.
    t = buildTestApp();
    const res = await http(t).get('/api/agents/name-availability?name=freshbot');
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe('available');
  });
});

describe('GET /api/workspaces/name-availability', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('reports an unused name as available', async () => {
    t = buildTestApp();
    const res = await http(t).get(
      '/api/workspaces/name-availability?name=freshspace',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, reason: 'available' });
  });

  it('reports an existing workspace name as taken', async () => {
    t = buildTestApp();
    await http(t).post('/api/workspaces', { name: 'takenspace' });
    const res = await http(t).get(
      '/api/workspaces/name-availability?name=takenspace',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('reports an invalid format as invalid, not taken', async () => {
    t = buildTestApp();
    const res = await http(t).get(
      `/api/workspaces/name-availability?name=${encodeURIComponent('has space')}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'invalid' });
  });
});
