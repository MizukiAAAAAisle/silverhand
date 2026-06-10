import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('GET/PUT /api/settings', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('does not expose or accept the legacy viewer_user_id setting', async () => {
    t = buildTestApp();

    const initial = await (await http(t).get(apiPaths.settings)).json() as any;
    expect(initial.settings.viewer_user_id).toBeUndefined();

    const denied = await http(t).put(apiPaths.settings, {
      viewer_user_id: 'someone-else',
    });
    expect(denied.status).toBe(400);

    const pointer = t.ctx.db
      .prepare(`SELECT value FROM app_settings WHERE key = 'viewer_user_id'`)
      .get() as { value: string } | undefined;
    expect(pointer?.value).toBe('local');
  });

  it('rejects removed runtime proxy settings', async () => {
    t = buildTestApp();
    const denied = await http(t).put(apiPaths.settings, {
      proxy_url: 'http://127.0.0.1:7890',
    });
    expect(denied.status).toBe(400);

    const initial = await (await http(t).get(apiPaths.settings)).json() as any;
    expect(initial.settings).toEqual({});
  });

  // Pin the PUT handler's remaining two arms before the settings carve
  // (#task:983 P18 prep): an empty object is the accepted no-op, a non-object
  // body is rejected. Keeps the relocation into routes/settings.ts provably
  // behavior-preserving.
  it('accepts an empty object as a no-op and echoes the empty snapshot', async () => {
    t = buildTestApp();
    const res = await http(t).put(apiPaths.settings, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings).toEqual({});
  });

  it('rejects a non-object body with 400', async () => {
    t = buildTestApp();
    const res = await http(t).put(apiPaths.settings, 42);
    expect(res.status).toBe(400);
  });
});
