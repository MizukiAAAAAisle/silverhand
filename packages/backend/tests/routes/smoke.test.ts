import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('route harness smoke', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET /api/health works without spinning up a server', async () => {
    t = buildTestApp();
    const res = await http(t.app).get('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('embedded');
    expect(typeof body.ts).toBe('number');
  });

  it('GET /api/hosts returns the bootstrapped local host', async () => {
    t = buildTestApp();
    const res = await http(t.app).get('/api/hosts');
    const body = await res.json() as any;
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0].kind).toBe('local');
  });

  it('allows renderer viewer identity header in CORS preflight', async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request('http://localhost/api/notifications?unread=1', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-silverhand-user-id',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(
      /x-silverhand-user-id/i,
    );
  });
});
