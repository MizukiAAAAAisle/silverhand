import { afterEach, describe, expect, it } from 'vitest';
import type { NameAvailabilityDto } from '@silverhand/shared';
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

  it('rejects a numeric-first participant name', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/name-availability?name=2b');
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
    const body = (await res.json()) as NameAvailabilityDto;
    expect(body.reason).toBe('available');
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

  it('keeps numeric-first workspace names valid', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/workspaces/name-availability?name=2b');
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

  it('keeps a Chinese workspace name valid', async () => {
    t = buildTestApp();
    const res = await http(t).get(
      `/api/workspaces/name-availability?name=${encodeURIComponent('设计评审')}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, reason: 'available' });
  });

  it('answers the same for either Unicode spelling of one name', async () => {
    // The probe must normalize BEFORE the uniqueness lookup, or a name pasted
    // in NFD (what macOS often produces) reads `available` here while create
    // stores/compares NFC and answers 409 — the advisory hint and the
    // authoritative path would disagree on the same visible name.
    t = buildTestApp();
    await http(t).post('/api/workspaces', { name: 'café'.normalize('NFC') });
    const res = await http(t).get(
      `/api/workspaces/name-availability?name=${encodeURIComponent('café'.normalize('NFD'))}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'taken' });
  });

  it('reports an invalid format as invalid, not taken', async () => {
    t = buildTestApp();
    // A workspace name is a label, so the reachable non-length rejection is a
    // code point the field cannot render — here a zero-width space.
    const res = await http(t).get(
      `/api/workspaces/name-availability?name=${encodeURIComponent('has\u200Bspace')}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'invalid' });
  });
});
