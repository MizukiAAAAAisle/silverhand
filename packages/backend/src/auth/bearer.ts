import type { Hono } from 'hono';
import type { BackendContext } from '../context.js';
import { setPrincipal, type AppEnv } from './principal.js';

export interface PublicBearerOptions {
  /** Paths that bypass the Bearer check (matched exactly). */
  allowlist?: readonly string[];
}

/**
 * Parse a raw `Authorization` header value into its Bearer token.
 *
 * Header-level only — it never touches Hono's `Context`, so it is the single
 * source of Bearer parsing shared by the public bearer middleware, the
 * host-claim session-bearer guard, and the `/auth/logout` route. Returns null
 * when the header is absent or carries no token after the `Bearer ` prefix.
 */
export function parseBearerTokenHeader(header: string | undefined): string | null {
  const token = (header ?? '').replace(/^Bearer\s+/i, '').trim();
  return token || null;
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
 * Public API requests must carry a user session bearer. The retired
 * embedded server-config token is not accepted here; embedded startup
 * uses `/auth/embedded-bootstrap` to mint a normal user session instead.
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
    const header = c.req.header('authorization');
    const token = parseBearerTokenHeader(header) ?? '';
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
