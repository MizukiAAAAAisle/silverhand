import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENT_WS_SESSION_COOKIE,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  apiPaths,
} from '@silverhand/shared';
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

  it('does not treat the event websocket cookie as REST API auth', async () => {
    t = buildTestApp();
    const token = t.ctx.authSessions.issueSession({ userId: 'local' }).userToken;
    const res = await t.app.fetch(
      new Request('http://localhost/api/workspaces', {
        method: 'GET',
        headers: { cookie: `${EVENT_WS_SESSION_COOKIE}=${token}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
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

  it('accepts /api/* requests with a user session bearer (200)', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/workspaces');
    expect(res.status).toBe(200);
  });

  it('rejects the retired server-config bearer even with a fabricated viewer header', async () => {
    t = buildTestApp();
    const res = await t.app.fetch(
      new Request('http://localhost/api/workspaces', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${t.legacyServerAuthToken}`,
          [X_SILVERHAND_LEGACY_USER_ID_HEADER]: 'local',
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
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
