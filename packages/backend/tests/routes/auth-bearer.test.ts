import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('Public bearer enforcement on /api/*', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects /api/* requests without an Authorization header (401)', async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request('http://localhost/api/workspaces', { method: 'GET' }),
    );
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toBe('unauthorized');
  });

  it('rejects /api/* requests with a wrong bearer token (401)', async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request('http://localhost/api/workspaces', {
        method: 'GET',
        headers: { authorization: 'Bearer not-the-right-token' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts /api/* requests with the correct bearer token (200)', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/workspaces');
    expect(res.status).toBe(200);
  });

  it('does not resolve legacy bearer into a viewer without an explicit principal', async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request('http://localhost/api/workspaces', {
        method: 'GET',
        headers: { authorization: `Bearer ${t.authToken}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'registration_required' });
  });

  it(`allowlists ${apiPaths.health} so liveness probes bypass the bearer check`, async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.health}`, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
  });

  it('does not gate /internal/* with the public bearer middleware (path falls through)', async () => {
    // The internal router has its own bearer check, so missing the public
    // bearer middleware on /internal/* must NOT yield a generic 401 from the
    // public layer. This guards the path-prefix mount used in routes.ts.
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request(
        'http://localhost/internal/conversations/does-not-exist/agents/x/send-message',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'x' }),
        },
      ),
    );
    // The internal bearer middleware still rejects (no token), but it's a
    // different rejection than the public one — and crucially the public
    // middleware did not pre-empt it.
    expect(res.status).toBe(401);
  });
});
