import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { getConnInfo } from '@hono/node-server/conninfo';
import { performance } from 'node:perf_hooks';
import { apiPaths, authPaths, probePaths } from '@silverhand/shared';
import {
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
} from '@silverhand/shared';
import {
  installDesktopApiEpochMiddleware,
  type DesktopApiEpochOptions,
} from './auth/desktop-api-epoch.js';
import type { BackendContext } from './context.js';
import type { BackendPersistence } from './persistence/root.js';
import type { AgentDeletionRunner } from './application/agent-deletion-resumer.js';
import { elapsedSince } from './observability/route-span.js';
import { HostTokenService } from './auth/host-token.js';
import { detectRuntimes } from '@silverhand/host/runtimes';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import { createHostApp } from './routes/hosts.js';
import { createWorkspacesApp } from './routes/workspaces.js';
import { createSortApp } from './routes/sort.js';
import { createFavoritesApp } from './routes/favorites.js';
import { createDirectPairsApp } from './routes/direct-pairs.js';
import { createTasksApp } from './routes/tasks.js';
import { createNotificationsApp } from './routes/notifications.js';
import { createPresenceApp } from './routes/presence.js';
import { createUsersApp } from './routes/users.js';
import { createAuthApp } from './routes/auth.js';
import { createAgentsApp } from './routes/agents.js';
import { createAttachmentsApp } from './routes/attachments.js';
import {
  createConversationReadApp,
  createConversationMessagingApp,
  createConversationRuntimeApp,
} from './routes/conversations.js';
import { createAttentionApp } from './routes/attention.js';
import { MembershipService } from './services/membership-service.js';
import { hostRuntimeDisabledResponse } from './routes/responses.js';
import {
  type MembershipRouteDeps,
  createWorkspaceMembershipApp,
  createConversationMembershipApp,
} from './routes/membership.js';
import { createWorkspaceCapabilityApp } from './routes/capability.js';
import {
  type AppEnv,
  installPublicPrincipalMiddleware,
  installRequireRegisteredViewerMiddleware,
} from './auth/principal.js';
import {
  installPublicBearerMiddleware,
  parseBearerTokenHeader,
} from './auth/bearer.js';
import { authSessionMetadata } from './auth/session-metadata.js';
import {
  consumeEmbeddedBootstrapToken,
  isLoopbackAddress,
} from './auth/embedded-bootstrap.js';
import { UserAuthService } from './auth/user-auth-service.js';
import { runWithBackendRequestContext } from './observability/request-context.js';

function standaloneMode(ctx: BackendContext): boolean {
  return ctx.deploymentMode === 'standalone';
}

function readinessResponse(ctx: BackendContext): {
  body: {
    ok: boolean;
    mode: string;
    deployment_mode: string;
    checks: {
      migrations_applied: boolean;
      listen_ready: boolean;
      db_writable: boolean;
      /**
       * Standalone readiness check: present only when
       * `deployment_mode === 'standalone'`. Reports whether the
       * backend's `OutboundRuntimeEventFanout` was constructed and
       * registered as the `HostWsServer.eventSink`. This is a
       * **backend-side wiring readiness** signal — it does NOT mean
       * any daemon host has connected over the outbound websocket.
       * Daemon-side attachment is reported through
       * `HostWsServerController.getAttachment(hostId)` (D3.a Commit 1).
       *
       * Embedded also constructs the fanout, but has two transports:
       * the co-located app-managed host uses Unix socket while
       * user-managed daemon computers attach over WS. The field is
       * OMITTED from embedded `checks` to avoid implying daemon
       * attachment is a boot-readiness gate.
       */
      outbound_event_fanout_installed?: boolean;
    };
    error?: string;
    ts: number;
  };
  status: 200 | 503;
} {
  const writable = ctx.dbWriteProbe.probe();
  const baseChecks = {
    migrations_applied: ctx.readiness.migrationsApplied,
    listen_ready: ctx.readiness.listenReady,
    db_writable: writable.ok,
  };
  // Standalone backends require the outbound runtime event fanout to be
  // wired before they can correctly route daemon events to clients;
  // missing it is a config bug, not a transient condition, so /readyz
  // must fail-loud at 503 to keep orchestrators from rolling forward.
  // Embedded mode also constructs the shared fanout, but readiness must
  // not be read as daemon attachment for either the local Unix-socket
  // host or user-managed WS hosts, so the check remains omitted there.
  const checks: typeof baseChecks & {
    outbound_event_fanout_installed?: boolean;
  } =
    ctx.deploymentMode === 'standalone'
      ? {
          ...baseChecks,
          outbound_event_fanout_installed:
            ctx.readiness.outboundEventFanoutInstalled,
        }
      : baseChecks;
  const ok =
    checks.migrations_applied &&
    checks.listen_ready &&
    checks.db_writable &&
    (ctx.deploymentMode !== 'standalone' ||
      checks.outbound_event_fanout_installed === true);
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      mode: ctx.serverConfig.mode,
      deployment_mode: ctx.deploymentMode,
      checks,
      ...(writable.ok ? {} : { error: writable.error }),
      ts: Date.now(),
    },
  };
}

function requireSessionBearerUser(
  c: Context,
  ctx: BackendContext,
): Response | string {
  const token = parseBearerTokenHeader(c.req.header('authorization'));
  if (!token) {
    return c.json(
      {
        error: 'host claim requires a user session bearer',
        code: 'session_bearer_required',
      },
      401,
    );
  }
  const session = ctx.authSessions.validateSessionToken(token);
  if (!session.ok) {
    return c.json(
      {
        error: 'host claim requires a user session bearer',
        code: 'session_bearer_required',
      },
      401,
    );
  }
  return session.session.user_id;
}

function notFound(c: Context): Response {
  return c.text('404 Not Found', 404);
}

function isLoopbackRequest(c: Context): boolean {
  try {
    return isLoopbackAddress(getConnInfo(c).remote.address);
  } catch {
    try {
      return isLoopbackAddress(new URL(c.req.url).hostname);
    } catch {
      return false;
    }
  }
}

const SLOW_REQUEST_MS = 500;
const DIAGNOSTIC_REQUEST_MS = 100;
let apiRequestSequence = 0;

function installApiTimingMiddleware(
  app: Hono<AppEnv>,
  ctx: BackendContext,
): void {
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const isDiagnosticPath = isChannelSwitchDiagnosticPath(path);
    const requestId = nextApiRequestId();
    const startedAt = performance.now();
    ctx.logger.info(
      {
        requestId,
        method: c.req.method,
        path,
        query: url.search || null,
      },
      'api: request start',
    );
    await runWithBackendRequestContext(
      { requestId, method: c.req.method },
      async () => {
        let unhandledError = false;
        try {
          await next();
        } catch (err) {
          unhandledError = true;
          throw err;
        } finally {
          const elapsedMs = elapsedSince(startedAt);
          const status = unhandledError ? 500 : c.res.status;
          ctx.metrics?.observeHttpRequest({
            method: c.req.method,
            route: normalizedRoute(c),
            status,
            elapsedMs,
          });
          ctx.logger.info(
            {
              requestId,
              method: c.req.method,
              path,
              query: url.search || null,
              status,
              elapsedMs,
            },
            'api: request complete',
          );
          if (
            elapsedMs >= SLOW_REQUEST_MS ||
            (isDiagnosticPath && elapsedMs >= DIAGNOSTIC_REQUEST_MS)
          ) {
            ctx.logger.warn(
              {
                requestId,
                method: c.req.method,
                path,
                status,
                elapsedMs,
                thresholdMs: isDiagnosticPath
                  ? DIAGNOSTIC_REQUEST_MS
                  : SLOW_REQUEST_MS,
              },
              'api: slow request',
            );
          }
        }
      },
    );
  });
}

function normalizedRoute(c: Context): string {
  const matched = routePath(c, -1);
  return matched && matched !== '*' ? matched : 'unmatched';
}

function nextApiRequestId(): string {
  apiRequestSequence = (apiRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `api-${apiRequestSequence}`;
}

function isChannelSwitchDiagnosticPath(path: string): boolean {
  if (path === apiPaths.messageUnreadSummary) {
    return true;
  }
  if (/^\/api\/workspaces\/[^/]+\/channels(\/archived)?$/.test(path))
    return true;
  return /^\/api\/channels\/[^/]+\/(messages|agents|agent-run-states|threads|message-unread)$/.test(
    path,
  );
}

export interface ApiRouterOptions {
  /** #task:1761 test seam — see DesktopApiEpochOptions. */
  desktopApiEpoch?: DesktopApiEpochOptions;
  agentDeletionRunner: AgentDeletionRunner;
}

export function createApiRouter(
  ctx: BackendContext,
  persistence: BackendPersistence,
  options: ApiRouterOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  installApiTimingMiddleware(app, ctx);
  installPublicBearerMiddleware(app, ctx, {
    // Liveness probe stays open so a process supervisor can health-check
    // without holding a user session token. `/readyz` is outside `/api/*`.
    allowlist: [
      apiPaths.health,
      apiPaths.serverInfo,
      apiPaths.hostConnectTokenResolve,
    ],
  });
  installPublicPrincipalMiddleware(app);
  // #task:1761 — desktop API epoch admission. After bearer (authenticated
  // requests only reach here), before the registration gate and all business
  // routes. Exemptions come from the shared manifest so advertise/enforce
  // cannot drift; `/internal/*`, `/auth/*`, `/readyz` are outside the mount.
  installDesktopApiEpochMiddleware(app, ctx, options.desktopApiEpoch ?? {});
  // Registration gate: after the public bearer middleware authenticates
  // a session, this verifies the user row still exists before public
  // data routes run. Probe paths, `/api/server/info`, `/auth/*`, and
  // `/internal/*` are anonymous / route-owned / agent-principal and skip the
  // relevant public layers. Under DB corruption (principal set but row missing)
  // it 500s.
  installRequireRegisteredViewerMiddleware(app, persistence.repos.users, {
    whitelistPaths: [apiPaths.serverInfo, apiPaths.me],
  });
  // #task:1983 W1 — the router does NOT build persistence; it receives the
  // already-composed bag and unpacks it into the per-route deps below. The bag
  // dies here: no `*RouteDeps` object carries `BackendPersistence` itself, so a
  // handler can only reach the repos/ports its own deps type names.
  const {
    hosts,
    agents,
    workspaces,
    conversations,
    messages,
    reactions,
    attachments,
    saved,
    search,
    conversationInboxes,
    runtimeSlots,
    notifications,
    conversationReads,
    channelAttentionPrefs,
    workspaceAttentionPrefs,
    attentionBadges,
    conversationEvents,
    sort,
    users,
  } = persistence.repos;
  const hostUow = persistence.hostTokens.uow;
  const hostTokens = new HostTokenService(persistence.hostTokens);
  const membership = new MembershipService({ agents, users, conversations });
  const userAuth = new UserAuthService({
    uow: persistence.auth.uow,
    users,
    handles: persistence.auth.handles,
    passwordCredentials: ctx.passwordCredentials,
    events: ctx.events,
  });
  // Shared by the workspace, conversation and internal membership sub-apps: as
  // of #task:1987 every one of them writes membership through the ports, so the
  // persistence composition is part of the common deps.
  const membershipPersistence = persistence.membership;
  const membershipDeps: MembershipRouteDeps = {
    ctx,
    agents,
    users,
    workspaces,
    conversations,
    membershipPersistence,
    membership,
  };
  // #task:1990 — the create-agent L3a dependent-row transaction, wired at the
  // composition root so `application/create-agent.ts` never holds `BackendContext`.
  const agentProvisioning = persistence.agentProvisioning;
  // #task:1987 D — ONE teardown UnitOfWork for both destructive cascades
  // (`DELETE /api/agents/:id` and `DELETE /api/hosts/:id`), so a computer
  // delete cannot tear an agent down differently from a single-agent delete.
  const agentTeardown = persistence.agentTeardown;
  // #task:1987 E — the viewer-keyed observation write boundary, so the Attention
  // eliminate primitive holds no transaction capability of its own.
  const observations = persistence.observations;
  // #task:1983 W2 — the projections, handle bound at composition time. Each
  // route below names the ONE it reads; no `*RouteDeps` takes the whole set.
  const readModels = persistence.readModels;

  // ── Auth / health / runtimes / hosts ─────────────────────────────
  app.get(apiPaths.serverInfo, c =>
    c.json({
      signup_enabled: ctx.authConfig.signupEnabled,
      bind_address_scope: ctx.bindAddressScope,
      outbound_protocol_version: OUTBOUND_PROTOCOL_VERSION,
      desktop_api: {
        current_epoch: DESKTOP_SERVER_API_EPOCH,
        minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
      },
    }),
  );

  if (ctx.deploymentMode === 'embedded') {
    app.post(authPaths.embeddedBootstrap, async c => {
      if (ctx.serverConfig.mode !== 'embedded') return notFound(c);
      if (!isLoopbackRequest(c)) return notFound(c);
      const body = await c.req.json().catch(() => null);
      const token =
        body &&
        typeof body === 'object' &&
        typeof (body as { token?: unknown }).token === 'string'
          ? (body as { token: string }).token.trim()
          : '';
      if (!token) return notFound(c);

      const ok = await consumeEmbeddedBootstrapToken(
        ctx.embeddedBootstrap,
        token,
        ctx.logger,
      );
      if (!ok) return notFound(c);

      const allUsers = users.list();
      let userId: string;
      if (allUsers.length === 0) {
        const user = ctx.userService.register({
          name: 'local',
          display_name: 'Local User',
        });
        userId = user.id;
      } else if (allUsers.length === 1) {
        userId = allUsers[0]!.id;
      } else {
        return c.json(
          {
            error: 'embedded bootstrap cannot choose among multiple users',
            code: 'bootstrap_ambiguous_user',
          },
          409,
        );
      }

      const user = ctx.userService.getDto(userId);
      if (!user) return c.json({ error: 'bootstrap user is missing' }, 500);
      const issued = ctx.authSessions.issueSession({
        userId,
        ...authSessionMetadata(c),
      });
      return c.json({ user_token: issued.userToken, user });
    });
  }

  // Auth session routes. Embedded bootstrap above is setup glue and stays root-owned.
  app.route('/', createAuthApp({ ctx, userAuth }));

  app.get(apiPaths.health, c =>
    c.json({ ok: true, mode: ctx.serverConfig.mode, ts: Date.now() }),
  );

  const handleReady = (c: Context): Response => {
    const ready = readinessResponse(ctx);
    return c.json(ready.body, ready.status);
  };
  app.get(probePaths.readyz, handleReady);

  app.get(apiPaths.eventWebSocket, c =>
    c.json({ error: 'event websocket requires a websocket upgrade' }, 401),
  );

  app.get(apiPaths.hostConnect, c =>
    c.json({ error: 'host websocket requires a websocket upgrade' }, 401),
  );

  app.get(apiPaths.runtimes, async c => {
    if (standaloneMode(ctx)) {
      return hostRuntimeDisabledResponse(c, 'runtime detection', 503);
    }
    const runtimes = await detectRuntimes();
    return c.json({ runtimes });
  });

  // Host CRUD routes. GET /api/hosts/connect stays above as daemon WS transport,
  // not host CRUD; session and deployment checks are injected to avoid back-edges.
  app.route(
    '/',
    createHostApp({
      ctx,
      hosts,
      hostTokens,
      hostUow,
      agents,
      agentTeardown,
      requireSessionBearerUser,
      standaloneMode,
    }),
  );

  // ── Workspaces / conversations ──────────────────────────────────
  //
  // Canonical workspace/channel/thread API backed by workspaces and
  // conversations. Route kind guards prevent a thread id from silently
  // passing as a channel id.

  // Workspace lifecycle, metadata, and workspace-channel collection routes.
  app.route(
    '/',
    createWorkspacesApp({
      ctx,
      agents,
      users,
      workspaces,
      conversations,
      messages,
      sort,
      membershipPersistence,
    }),
  );

  // Per-user list sort mutations (rail + channel sidebar ordering).
  app.route(
    '/',
    createSortApp({
      ctx,
      favorites: readModels.favorites,
      workspaces,
      conversations,
      sort,
    }),
  );

  // Favorites: the viewer's flat global STARRED list (read projection over the
  // sort context's starred_at in each workspace's conversation list; containers
  // cannot star at all since #task:1899). Read-only.
  app.route('/', createFavoritesApp({ ctx, favorites: readModels.favorites }));

  // Direct Messages: the viewer's existing `direct_pair` lines (#task:2035).
  // Workspace-free, so it is a sibling of the workspace channel list rather than
  // a filter on it. Read-only.
  app.route(
    '/',
    createDirectPairsApp({ ctx, directPairs: readModels.directPairs, conversations }),
  );

  // Workspace membership routes.
  app.route('/', createWorkspaceMembershipApp(membershipDeps));

  // Workspace-agent capability management routes.
  app.route(
    '/',
    createWorkspaceCapabilityApp({
      ctx,
      workspaces,
      capabilities: persistence.repos.agentCapabilities,
    }),
  );

  // Conversation read, metadata, and log-debug routes.
  app.route(
    '/',
    createConversationReadApp({
      ctx,
      conversations,
      workspaces,
      messages,
      conversationReads,
      reactionReads: readModels.reactions,
    }),
  );

  // Attention bounded context (#task:1227): the channel ambient TIER and the
  // workspace mute SUPPRESSOR (GET/PUT each, #task:1870), the tiered badge read
  // faces, the Activity list query, and the `observe` eliminate primitive.
  app.route(
    '/',
    createAttentionApp({
      ctx,
      activity: readModels.activity,
      conversations,
      messages,
      workspaces,
      conversationReads,
      notifications,
      channelAttentionPrefs,
      workspaceAttentionPrefs,
      attentionBadges,
      observations,
    }),
  );

  // Conversation membership routes.
  app.route('/', createConversationMembershipApp(membershipDeps));

  // Conversation messaging, threads, and saved-list routes.
  app.route(
    '/',
    createConversationMessagingApp({
      ctx,
      conversations,
      workspaces,
      messages,
      conversationReads,
      conversationEvents,
      saved,
      sort,
      runtimeSlots: persistence.repos.runtimeSlots,
    }),
  );

  // Upload via channel/thread context so the server resolves the access
  // boundary; clients never specify channel_id directly. Download is by id.
  // `uploadAttachment` stays in the shared neutral leaf routes/attachment-upload.ts
  // (also used by routes/internal-agent.ts); the sub-app imports it, not the reverse.
  app.route('/', createAttachmentsApp({ ctx, conversations, attachments }));

  // Conversation runtime control, search, saved-message, and thread routes.
  app.route(
    '/',
    createConversationRuntimeApp({
      ctx,
      conversations,
      messages,
      saved,
      search,
      agents,
      reactions,
      reactionReads: readModels.reactions,
    }),
  );

  // Public agent routes.
  app.route(
    '/',
    createAgentsApp({
      ctx,
      agents,
      workspaces,
      conversations,
      messages,
      hosts,
      agentAuditChats: readModels.agentAuditChats,
      conversationInboxes,
      runtimeSlots,
      users,
      agentProvisioning,
      agentTeardown,
      agentDeletionRunner: options.agentDeletionRunner,
    }),
  );
  // Current viewer, user directory, and avatar routes.
  app.route('/', createUsersApp({ ctx }));

  // Global human presence snapshot. Delta events publish on app scope.
  app.route('/', createPresenceApp({ ctx, users }));

  // Viewer notification routes.
  app.route('/', createNotificationsApp({ ctx, notifications, attentionBadges }));

  // Human-facing task board routes.
  app.route('/', createTasksApp({ ctx }));

  return app;
}
