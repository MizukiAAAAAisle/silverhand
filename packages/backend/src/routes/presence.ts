import { Hono } from 'hono';
import { apiPaths, type PresenceResponse } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { UserRepo } from '../repos/user-repo.js';

export interface PresenceRouteDeps {
  ctx: BackendContext;
  users: UserRepo;
}

export function createPresenceApp(deps: PresenceRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, users } = deps;

  app.get(apiPaths.presence, c => {
    const body: PresenceResponse = {
      users: users.list().map(user => {
        const online = ctx.presence.isOnline(user.id);
        return {
          user_id: user.id,
          presence: online ? 'online' : 'offline',
          last_seen_at: online ? null : user.last_seen_at,
        };
      }),
    };
    return c.json(body);
  });

  return app;
}
