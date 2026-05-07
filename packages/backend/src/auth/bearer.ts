import type { Hono } from 'hono';
import type { BackendContext } from '../context.js';
import type { AppEnv } from './principal.js';

export interface PublicBearerOptions {
  /** Paths that bypass the Bearer check (matched exactly). */
  allowlist?: readonly string[];
}

/**
 * Mount Bearer-token enforcement on the public `/api/*` router.
 *
 * The `/api/*` mount pattern (rather than `*` + a path guard) avoids
 * firing on `/internal/*` requests when both routers are mounted via
 * `app.route('/', ...)`; the internal router has its own bearer check,
 * mounting at `*` here would double-process those requests.
 *
 * `allowlist` paths bypass the check (e.g. `/api/health` for liveness
 * probes). Match is exact, not prefix — a future probe under
 * `/api/health/...` would need to be added explicitly.
 */
export function installPublicBearerMiddleware(
  app: Hono<AppEnv>,
  ctx: BackendContext,
  options: PublicBearerOptions = {},
): void {
  const allowlist = new Set(options.allowlist ?? []);
  app.use('/api/*', async (c, next) => {
    if (allowlist.has(c.req.path)) {
      await next();
      return;
    }
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== ctx.serverConfig.auth_token) {
      ctx.logger.warn(
        {
          path: c.req.path,
          hasHeader: !!header,
          tokenLen: token.length,
        },
        'public: unauthorized request',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
}
