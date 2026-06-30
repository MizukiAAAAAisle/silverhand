// Favorites route (#task:1252, docs/list-sort-v1.md). A read-side projection
// over the `sort` bounded context: the viewer's flat global STARRED list,
// UNIONed across every list_key. Owns no write side — starring still happens via
// the per-entity `/api/workspaces/:id/star` and `/api/channels/:id/star`
// endpoints; this only reads.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import { apiPaths, type ListFavoritesDto } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import { canViewOwnedState } from '../permissions.js';
import { listFavorites } from '../read-model/favorites.js';

export interface FavoritesRouteDeps {
  ctx: BackendContext;
}

export function createFavoritesApp(deps: FavoritesRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx } = deps;

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
    const dto: ListFavoritesDto = listFavorites(ctx, { viewerUserId });
    return c.json(dto);
  });

  return app;
}
