// Direct-pairs route (#task:2035): the viewer's Direct Messages list.
//
// Viewer-scoped and WORKSPACE-FREE by construction. Every other conversation
// list hangs off a workspace (`GET /api/workspaces/:id/channels`), and a
// `direct_pair` cannot: it has no workspace coordinate, so there is no `:id` that
// could carry it. That absence is the placement's definition, which is why this
// is a face of its own rather than a filter on an existing one.
//
// Read-only. Opening a NEW line is a write on the pair get-or-create path, and it
// is reached from the agent's own page (#task:2036) — this endpoint reports the
// lines that already exist and nothing else.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import { apiPaths, type DirectPairListResponse } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import { canViewOwnedState } from '../permissions.js';
import type { DirectPairsReadModel } from '../read-model/direct-pairs.js';

export interface DirectPairsRouteDeps {
  ctx: BackendContext;
  /** The projection, handle bound at composition time (#task:1983 W2). */
  directPairs: DirectPairsReadModel;
}

export function createDirectPairsApp(deps: DirectPairsRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, directPairs } = deps;

  // GET the viewer's existing DM lines. The gate is owned-state, exactly like
  // Activity and Favorites: the question "which lines do I have" is a fact about
  // the viewer, and the read model already scopes every row to pairs the viewer
  // is an ENDPOINT of, through the single placement authority. There is no
  // per-entity membership check to add on top — for a `direct_pair` the endpoint
  // coordinates ARE the membership.
  app.get(apiPaths.directPairs, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const dto: DirectPairListResponse = directPairs.list({ viewerUserId });
    return c.json(dto);
  });

  return app;
}
