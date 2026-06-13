import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { performance } from 'node:perf_hooks';
import { apiPaths, authPaths, probePaths } from '@silverhand/shared';
import type { BackendContext } from './context.js';
import { elapsedSince } from './observability/route-span.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
import { HostRepo } from './repos/host-repo.js';
import { HostTokenService } from './auth/host-token.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { SavedMessageRepo } from './repos/saved-message-repo.js';
import { SearchRepo } from './repos/search-repo.js';
import { ConversationReadRepo } from './repos/conversation-read-repo.js';
import { ConversationInboxRepo } from './repos/conversation-inbox-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { detectRuntimes } from '@silverhand/host/runtimes';
import { createHostApp } from './routes/hosts.js';
import { createWorkspacesApp } from './routes/workspaces.js';
import { createTasksApp } from './routes/tasks.js';
import { createNotificationsApp } from './routes/notifications.js';
import { createPresenceApp } from './routes/presence.js';
import { createUsersApp } from './routes/users.js';
import { createAuthApp } from './routes/auth.js';
import { createSettingsApp } from './routes/settings.js';
import { createAgentsApp } from './routes/agents.js';
import { createAttachmentsApp } from './routes/attachments.js';
import {
  createConversationReadApp,
  createConversationMessagingApp,
  createConversationRuntimeApp,
} from './routes/conversations.js';
import { MembershipService } from './services/membership-service.js';
import { UserRepo } from './repos/user-repo.js';
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
       * Standalone-only check: present only when
       * `deployment_mode === 'standalone'`. Reports whether the
       * backend's `OutboundRuntimeEventFanout` was constructed and
       * registered as the `HostWsServer.eventSink`. This is a
       * **backend-side wiring readiness** signal — it does NOT mean
       * any daemon host has connected over the outbound websocket.
       * Daemon-side attachment is reported through
       * `HostWsServerController.getAttachment(hostId)` (D3.a Commit 1).
       *
       * Embedded mode never wires this fanout (runtime events flow
       * over Unix-socket IPC) and the field is OMITTED from `checks`
       * to avoid the false impression that embedded readiness depends
       * on it.
       */
      outbound_event_fanout_installed?: boolean;
    };
    error?: string;
    ts: number;
  };
  status: 200 | 503;
} {
  const writable = probeDbWritable(ctx);
  const baseChecks = {
    migrations_applied: ctx.readiness.migrationsApplied,
    listen_ready: ctx.readiness.listenReady,
    db_writable: writable.ok,
  };
  // Standalone backends require the outbound runtime event fanout to be
  // wired before they can correctly route daemon events to clients;
  // missing it is a config bug, not a transient condition, so /readyz
  // must fail-loud at 503 to keep orchestrators from rolling forward.
  // Embedded backends intentionally never construct this fanout
  // (runtime events flow over Unix-socket IPC), so the check is OMITTED
  // for embedded mode rather than included-and-defaulted-true — keeping
  // it out of the response makes the mode boundary explicit to anyone
  // reading the JSON.
  const checks: typeof baseChecks & { outbound_event_fanout_installed?: boolean } =
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

function probeDbWritable(ctx: BackendContext): { ok: true } | { ok: false; error: string } {
  try {
    ctx.db.exec('BEGIN IMMEDIATE');
    ctx.db.exec('ROLLBACK');
    return { ok: true };
  } catch (err) {
    safeRollback(ctx);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeRollback(ctx: BackendContext): void {
  try {
    if (ctx.db.inTransaction) ctx.db.exec('ROLLBACK');
  } catch {
    // Best-effort cleanup after a failed readiness write probe.
  }
}


function requireSessionBearerUser(c: Context, ctx: BackendContext): Response | string {
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

function installApiTimingMiddleware(app: Hono<AppEnv>, ctx: BackendContext): void {
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
    try {
      await next();
    } finally {
      const elapsedMs = elapsedSince(startedAt);
      ctx.logger.info(
        {
          requestId,
          method: c.req.method,
          path,
          query: url.search || null,
          status: c.res.status,
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
            status: c.res.status,
            elapsedMs,
            thresholdMs: isDiagnosticPath ? DIAGNOSTIC_REQUEST_MS : SLOW_REQUEST_MS,
          },
          'api: slow request',
        );
      }
    }
  });
}

function nextApiRequestId(): string {
  apiRequestSequence = (apiRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `api-${apiRequestSequence}`;
}

function isChannelSwitchDiagnosticPath(path: string): boolean {
  if (path === apiPaths.messageUnreadSummary) {
    return true;
  }
  if (/^\/api\/workspaces\/[^/]+\/channels(\/archived)?$/.test(path)) return true;
  return /^\/api\/channels\/[^/]+\/(messages|agents|agent-run-states|threads|mark-read|message-unread)$/.test(
    path,
  );
}

export function createApiRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  installApiTimingMiddleware(app, ctx);
  installPublicBearerMiddleware(app, ctx, {
    // Liveness probe stays open so a process supervisor can health-check
    // without holding a user session token. `/readyz` is outside `/api/*`.
    allowlist: [apiPaths.health, apiPaths.serverInfo],
  });
  installPublicPrincipalMiddleware(app);
  // Registration gate: after the public bearer middleware authenticates
  // a session, this verifies the user row still exists before public
  // data routes run. Probe paths, `/api/server/info`, `/auth/*`, and
  // `/internal/*` are anonymous / route-owned / agent-principal and skip the
  // relevant public layers. Under DB corruption (principal set but row missing)
  // it 500s.
  installRequireRegisteredViewerMiddleware(app, ctx, {
    whitelistPaths: [apiPaths.serverInfo, apiPaths.me],
  });
  const hosts = new HostRepo(ctx.db);
  const agents = new AgentRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const attachments = new AttachmentRepo(ctx.db);
  const saved = new SavedMessageRepo(ctx.db);
  const search = new SearchRepo(ctx.db);
  const conversationInboxes = new ConversationInboxRepo(ctx.db);
  const notifications = new NotificationRepo(ctx.db);
  const conversationReads = new ConversationReadRepo(ctx.db);
  const users = new UserRepo(ctx.db);
  const hostTokens = new HostTokenService(ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  const userAuth = new UserAuthService({
    db: ctx.db,
    users,
    passwordCredentials: ctx.passwordCredentials,
    authSessions: ctx.authSessions,
  });
  // Shared by the workspace and conversation membership sub-apps.
  const membershipDeps: MembershipRouteDeps = {
    ctx,
    agents,
    users,
    workspaces,
    conversations,
    messages,
    membership,
  };

  // ── Auth / health / runtimes / hosts ─────────────────────────────
  app.get(apiPaths.serverInfo, c =>
    c.json({
      signup_enabled: ctx.authConfig.signupEnabled,
      bind_address_scope: ctx.bindAddressScope,
    }),
  );

  if (ctx.deploymentMode === 'embedded') {
    app.post(authPaths.embeddedBootstrap, async c => {
      if (ctx.serverConfig.mode !== 'embedded') return notFound(c);
      if (!isLoopbackRequest(c)) return notFound(c);
      const body = await c.req.json().catch(() => null);
      const token =
        body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string'
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
      agents,
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
    createWorkspacesApp({ ctx, agents, users, workspaces, conversations, messages }),
  );

  // Workspace membership routes.
  app.route('/', createWorkspaceMembershipApp(membershipDeps));

  // Workspace-agent capability management routes.
  app.route('/', createWorkspaceCapabilityApp({ ctx, workspaces }));

  // Conversation read, metadata, and log-debug routes.
  app.route(
    '/',
    createConversationReadApp({ ctx, conversations, workspaces, messages, conversationReads }),
  );

  // Conversation membership routes.
  app.route('/', createConversationMembershipApp(membershipDeps));

  // Conversation messaging, threads, and saved-list routes.
  app.route(
    '/',
    createConversationMessagingApp({
      ctx,
      conversations,
      messages,
      conversationReads,
      saved,
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
    }),
  );

  // Public agent routes.
  app.route(
    '/',
    createAgentsApp({ ctx, agents, workspaces, conversations, messages, conversationInboxes }),
  );
  // Legacy settings compatibility surface.
  app.route('/', createSettingsApp());

  // Current viewer, user directory, and avatar routes.
  app.route('/', createUsersApp({ ctx }));

  // Global human presence snapshot. Delta events publish on app scope.
  app.route('/', createPresenceApp({ ctx, users }));

  // Viewer notification routes.
  app.route('/', createNotificationsApp({ ctx, notifications }));

  // Human-facing task board routes.
  app.route('/', createTasksApp({ ctx }));

  return app;
}
