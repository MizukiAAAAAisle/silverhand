// Favorites route (#task:1252, re-scoped to conversations by #task:1888;
// docs/list-sort-v1.md). A read-side projection over the `sort` bounded context:
// the viewer's flat global STARRED list, projected from the stars recorded in
// each workspace's own conversation list (`list_key='channels:<ws_id>'`). A
// workspace / DM container has no star at all (#task:1899), so the rail cannot
// contribute rows. Owns no write side: the only star endpoint that
// feeds this list is `/api/channels/:id/star`; this only reads.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import { apiPaths, type ListFavoritesDto } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import { canViewOwnedState } from '../permissions.js';
import type { FavoritesReadModel } from '../read-model/favorites.js';

export interface FavoritesRouteDeps {
  ctx: BackendContext;
  /** The projection, handle bound at composition time (#task:1983 W2). */
  favorites: FavoritesReadModel;
}

export function createFavoritesApp(deps: FavoritesRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, favorites } = deps;

  // GET the viewer's flat Favorites list. The Favorites list is the viewer's
  // own state (like Activity / the unread summary), so the gate is owned-state,
  // not a per-entity membership check — the read-model already scopes every row
  // to entities the viewer can access (workspace_users / conversation_users) and
  // drops archived ones (see read-model/favorites.ts membership contract).
  app.get(apiPaths.favorites, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const dto: ListFavoritesDto = favorites.list({ viewerUserId });
    return c.json(dto);
  });

  return app;
}
