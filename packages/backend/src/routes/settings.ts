// Legacy compatibility-only settings surface. Runtime proxy config moved to
// daemon-host local truth, so GET returns the empty snapshot and PUT accepts no
// keys (any key, or a non-object body, is a 400). The handlers depend on nothing
// from BackendContext — publicSettingsSnapshot is a constant {} — so the factory
// takes no deps.
import { Hono } from 'hono';
import { apiPaths } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';

function publicSettingsSnapshot(): Record<string, string> {
  return {};
}

export function createSettingsApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Runtime proxy config moved to daemon-host local truth. The route is
  // retained as an empty, compatibility-only surface; no public settings
  // are accepted.
  app.get(apiPaths.settings, c => c.json({ settings: publicSettingsSnapshot() }));

  app.put(apiPaths.settings, async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid input' }, 400);
    }
    const [firstKey] = Object.keys(body as Record<string, unknown>);
    if (firstKey) {
      return c.json({ error: `unknown settings key: ${firstKey}` }, 400);
    }
    return c.json({ settings: publicSettingsSnapshot() });
  });

  return app;
}
