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

  it('continues to persist ordinary host-wide settings', async () => {
    t = buildTestApp();
    const updated = await (
      await http(t).put(apiPaths.settings, {
        proxy_url: 'http://127.0.0.1:7890',
      })
    ).json() as any;
    expect(updated.settings.proxy_url).toBe('http://127.0.0.1:7890');
    expect(updated.settings.viewer_user_id).toBeUndefined();
  });
});
