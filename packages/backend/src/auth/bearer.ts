import type { Hono } from 'hono';
import type { BackendContext } from '../context.js';
import { setPrincipal, type AppEnv } from './principal.js';

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
 *
 * Stage A.2 transition: a public API bearer can be either the legacy
 * embedded server token or a user session token. Session tokens set the
 * user principal here; the legacy token intentionally falls through to
 * the existing principal-header / `app_settings.viewer_user_id` resolver.
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
    if (!token) {
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
    if (token === ctx.serverConfig.auth_token) {
      await next();
      return;
    }
    const session = ctx.authSessions.validateSessionToken(token);
    if (session.ok) {
      setPrincipal(c, { kind: 'user', userId: session.session.user_id });
      await next();
      return;
    }
    ctx.logger.warn(
      {
        path: c.req.path,
        hasHeader: !!header,
        tokenLen: token.length,
      },
      'public: unauthorized request',
    );
    return c.json({ error: 'unauthorized' }, 401);
  });
}
