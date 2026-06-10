// Public credentialed session surface: POST /auth/signup, /auth/login,
// /auth/logout. The handlers delegate to UserAuthService (signup) /
// ctx.passwordCredentials (login) / ctx.authSessions (session issue + revoke).
//
// Scope boundary:
//   - /auth/embedded-bootstrap is NOT here — it is embedded bootstrap
//     transport/setup glue and stays in the composition root (routes.ts).
//   - UserAuthService wiring stays in the composition root and is injected via
//     deps; this router does not construct services.
//
// Shared helpers live in neutral leaves so there is no routes.ts back-edge:
// authSessionMetadata (shared with the staying bootstrap route) in
// auth/session-metadata.ts, parseBearerTokenHeader in auth/bearer.ts. authFailed
// is auth-only, so it is module-private here.
import { Hono } from 'hono';
import {
  authPaths,
  AuthLoginInputSchema,
  AuthSignupInputSchema,
} from '@silverhand/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { UserAuthService } from '../auth/user-auth-service.js';
import { authSessionMetadata } from '../auth/session-metadata.js';
import { parseBearerTokenHeader } from '../auth/bearer.js';

export interface AuthRouteDeps {
  ctx: BackendContext;
  userAuth: UserAuthService;
}

function authFailed(c: Context): Response {
  return c.json({ error_code: 'auth_failed' }, 401);
}

export function createAuthApp(deps: AuthRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, userAuth } = deps;

  // `/auth/signup` is always mounted. The handler branches on `signupEnabled`
  // and returns a typed 403 body when disabled so Desktop and ops tooling can
  // distinguish disabled signup from a missing route.
  app.post(authPaths.signup, async c => {
    if (!ctx.authConfig.signupEnabled) {
      return c.json(
        {
          error: 'signup is disabled on this backend',
          code: 'signup_disabled',
        },
        403,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = AuthSignupInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const signup = await userAuth.signup(parsed.data);
    if (!signup.ok) return authFailed(c);
    const user = ctx.userService.getDto(signup.userId);
    if (!user) {
      return c.json({ error: 'created user is missing post-signup' }, 500);
    }
    const issued = ctx.authSessions.issueSession({
      userId: signup.userId,
      ...authSessionMetadata(c),
    });
    return c.json({ user_token: issued.userToken, user });
  });

  app.post(authPaths.login, async c => {
    const body = await c.req.json().catch(() => null);
    const parsed = AuthLoginInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const verified = await ctx.passwordCredentials.verifyLoginPassword(parsed.data);
    if (!verified.ok) return authFailed(c);
    const user = ctx.userService.getDto(verified.userId);
    if (!user) {
      return c.json({ error: 'authenticated user is missing' }, 500);
    }
    const issued = ctx.authSessions.issueSession({
      userId: verified.userId,
      ...authSessionMetadata(c),
    });
    return c.json({ user_token: issued.userToken, user });
  });

  app.post(authPaths.logout, c => {
    const token = parseBearerTokenHeader(c.req.header('authorization'));
    if (!token || !ctx.authSessions.revokeSessionToken(token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ ok: true });
  });

  return app;
}
