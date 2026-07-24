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
import type {
  BackendContext,
} from '../context.js';
import {
  createCliInvokeMiddleware,
} from '../observability/cli-invoke-middleware.js';
import {
  AgentRepo,
} from '../repos/agent-repo.js';
import {
  ConversationRepo,
} from '../repos/conversation-repo.js';
import {
  MessageRepo,
} from '../repos/message-repo.js';
import {
  MessageReactionRepo,
} from '../repos/message-reaction-repo.js';
import {
  UserRepo,
} from '../repos/user-repo.js';
import {
  WorkspaceRepo,
} from '../repos/workspace-repo.js';
import {
  ChannelAttentionPreferenceRepo,
} from '../repos/channel-attention-preference-repo.js';
import {
  requireAgentCapability,
} from './capability.js';
import {
  createInternalMembershipApp,
} from './membership.js';
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

export function createInternalRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const agents = new AgentRepo(ctx.db);
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const reactions = new MessageReactionRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db);
  const users = new UserRepo(ctx.db);
  const channelAttentionPrefs = new ChannelAttentionPreferenceRepo(ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  const deps: InternalRouteDeps = {
    ctx,
    agents,
    conversations,
    messages,
    reactions,
    workspaces,
  };

  app.use('/internal/conversations/:cid/agents/:aid/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    const verified = ctx.agentTokens.verify(token, cid, aid);
    if (!verified.ok) {
      ctx.logger.warn(
        {
          path: c.req.path,
          hasHeader: !!header,
          tokenLen: token.length,
          reason: verified.reason,
          conversationId: cid,
          agentId: aid,
          caller: c.req.header('x-agent-hub-caller') ?? 'unknown',
        },
        'internal: unauthorized request',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  installInternalPrincipalMiddleware(app, { agents, conversations });

  // CLI invocation logging — must run after auth so we only emit lines
  // for verified principals, but before route handlers so handler
  // throws/short-circuits still produce one line per call.
  app.use(
    '/internal/conversations/:cid/agents/:aid/*',
    createCliInvokeMiddleware(ctx),
  );

  // Observability-only pre-flight failure trace — registered first so it keeps
  // its original position ahead of the membership mount.
  registerDiagnosticsRoutes(app, deps);

  // ── canonical conversation-scoped MCP routes ───────────────────
  // Internal membership routes are wrapped by the param-scoped agent-token auth
  // + getAgentPrincipal middleware installed above.
  app.route(
    '/',
    createInternalMembershipApp({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      messages,
      channelAttentionPrefs,
      membership,
      requireAgentCapability,
    }),
  );

  // Agent data-plane facets. Each `register*` only adds routes; the middleware
  // above still applies (Hono matches by registration order, and these facets
  // have distinct non-overlapping suffixes).
  registerMessageRoutes(app, deps);
  registerReactRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerProfileMcpRoutes(app, deps);
  registerScheduleRoutes(app, deps);

  return app;
}
