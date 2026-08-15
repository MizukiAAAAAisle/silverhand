// Internal-agent CLI command surface. This router owns its auth/principal
// middleware and mounts the per-facet command routes as one standalone
// factory; it never imports the public API composition root.
//
// Composition root only: this file constructs the Hono app, the shared repos,
// installs the auth / principal / cli-invoke middleware, and then delegates
// every concrete route to a `register<Facet>Routes` module under
// `./internal-agent/`. Facets are registered in an order that preserves the
// original relative registration sequence for any routes with overlapping
// path shapes (attachment param routes, profile vs profile/mcp); across
// distinct suffixes the order is behavior-neutral (no Hono param shadowing).
import {
  installInternalPrincipalMiddleware,
  type AppEnv,
} from '../auth/principal.js';
import { RuntimePrincipalVerifier } from '../auth/runtime-principal-verifier.js';
import type {
  BackendContext,
} from '../context.js';
import {
  createCliInvokeMiddleware,
} from '../observability/cli-invoke-middleware.js';
import {
  requireAgentConversationCapability,
} from './internal-agent/capability-scope.js';
import {
  createInternalMembershipApp,
} from './membership.js';
import type { BackendPersistence } from '../persistence/root.js';
import {
  MembershipService,
} from '../services/membership-service.js';
import type { InternalRouteDeps } from './internal-agent/deps.js';
import { registerConversationRoutes } from './internal-agent/conversation-routes.js';
import { registerDiagnosticsRoutes } from './internal-agent/diagnostics-routes.js';
import { registerFileRoutes } from './internal-agent/file-routes.js';
import { registerMessageRoutes } from './internal-agent/message-routes.js';
import { registerProfileMcpRoutes } from './internal-agent/profile-mcp-routes.js';
import { registerProfileRoutes } from './internal-agent/profile-routes.js';
import { registerReactRoutes } from './internal-agent/react-routes.js';
import { registerScheduleRoutes } from './internal-agent/schedule-routes.js';
import { registerTaskRoutes } from './internal-agent/task-routes.js';
import {
  Hono,
} from 'hono';

// #task:1983 W1/W2 — the internal (agent-facing) router takes the composed
// persistence for the same reason the public one does: it used to rebuild six
// repos and a membership port from `ctx.db`, which is a second assembly of the
// same set and the last reason this file needed the handle at all.
export function createInternalRouter(
  ctx: BackendContext,
  persistence: BackendPersistence,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const routes = new Hono<AppEnv>();
  const { agents, conversations, messages, reactions, workspaces, users } =
    persistence.repos;
  const membership = new MembershipService({ agents, users, conversations });
  const deps: InternalRouteDeps = {
    ctx,
    agents,
    agentReads: persistence.readModels.agent,
    conversations,
    messages,
    reactions,
    users,
    workspaces,
  };

  // Observe every attempt before authentication. Otherwise expired/unknown
  // legacy bearers disappear into a false zero and the bridge can never have a
  // sound deletion gate. This logs only route coordinates + declared caller;
  // authorization remains exclusively in RuntimePrincipalVerifier below.
  app.use('/internal/conversations/:cid/agents/:aid/*', async (c, next) => {
    ctx.logger.info(
      {
        action: 'legacy_internal_agent_route',
        conversationId: c.req.param('cid'),
        agentId: c.req.param('aid'),
        path: c.req.path,
        caller: c.req.header('x-agent-hub-caller') ?? 'unknown',
        routeFamily: 'legacy',
      },
      'legacy internal-agent route bridge used',
    );
    c.header('Deprecation', 'true');
    await next();
  });

  installInternalPrincipalMiddleware(
    app,
    new RuntimePrincipalVerifier(
      ctx.agentTokens,
      persistence.repos.runtimeSlots,
      conversations,
    ),
  );

  // CLI invocation logging — must run after auth so we only emit lines
  // for verified principals, but before route handlers so handler
  // throws/short-circuits still produce one line per call.
  app.use(
    '/internal/conversations/:cid/agents/:aid/*',
    createCliInvokeMiddleware(ctx),
  );
  app.use(
    '/internal/agents/:aid/conversations/:cid/*',
    createCliInvokeMiddleware(ctx),
  );

  // Observability-only pre-flight failure trace — registered first so it keeps
  // its original position ahead of the membership mount.
  registerDiagnosticsRoutes(routes, deps);

  // ── canonical conversation-scoped MCP routes ───────────────────
  // Internal membership routes are wrapped by the param-scoped agent-token auth
  // + getAgentPrincipal middleware installed above.
  routes.route(
    '/',
    createInternalMembershipApp({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      // Read-only, and for one purpose: the add's `--target` address is resolved
      // by the same resolver every P4 door uses (#task:2021 P4-4).
      messages,
      // The SAME port instance the public router writes through. Coordination
      // was never object identity — it is the connection's write lock (BEGIN
      // IMMEDIATE), see `membership-ports.ts` — but there is no longer a second
      // assembly here to keep in step with the first.
      membershipPersistence: persistence.membership,
      membership,
      // Placement-scoped: the add's destination is an ADDRESS now, and a pair or
      // an inbox has no workspace to grant in (#task:2021 P4-4).
      requireAgentConversationCapability,
    }),
  );

  // Agent data-plane facets. Each `register*` only adds routes; the middleware
  // above still applies (Hono matches by registration order, and these facets
  // have distinct non-overlapping suffixes).
  registerMessageRoutes(routes, deps);
  registerReactRoutes(routes, deps);
  registerConversationRoutes(routes, deps);
  registerTaskRoutes(routes, deps);
  registerFileRoutes(routes, deps);
  registerProfileRoutes(routes, deps);
  registerProfileMcpRoutes(routes, deps);
  registerScheduleRoutes(routes, deps);

  // One handler graph, two mounts. Canonical is the long-term authority;
  // legacy only adapts its path coordinate into the same `:cid` target.
  app.route('/internal/agents/:aid/conversations/:cid', routes);
  app.route('/internal/conversations/:cid/agents/:aid', routes);

  return app;
}
