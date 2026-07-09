// Host CRUD surface:
//   - GET  /api/hosts                  list the session user's hosts
//   - POST /api/hosts                  create pending user-managed computer
//   - GET  /api/hosts/connect-token/resolve daemon resolves copied token to host id
//   - GET  /api/hosts/:id              owner-scoped host read (incl. setup draft)
//   - DELETE /api/hosts/:id            delete empty user-managed computer/setup
//   - POST /api/hosts/claim_or_create  desktop main registers + mints host_token
//   - POST /api/hosts/:id/revoke       soft-delete (delegates to revokeHost use case)
//   - POST /api/hosts/:id/rotate-token long-lived token rotation
//   - POST /api/hosts/:id/connect-token/rotate user-managed connect-token rotation
//   - POST /api/hosts/:id/disconnect  disconnect live user-managed daemon
//   - PATCH /api/hosts/:id             rename (display_label)
//   - GET  /api/hosts/:id/status       dynamic host snapshot (daemon dispatch)
//   - GET  /api/hosts/:id/runtime-catalog host-local runtime availability
//   - GET  /api/hosts/:id/proxy-config host-local proxy config (daemon dispatch)
//   - PUT  /api/hosts/:id/proxy-config host-local proxy config update
//
// NOT in scope: GET /api/hosts/connect (the daemon WS-upgrade transport) stays
// in routes.ts — it is a transport concern, not host CRUD, and is separated
// from this block by GET /api/runtimes.
//
// Dependency direction is one-way: `routes.ts → routes/hosts.ts`. The two
// cross-cutting helpers the handlers need are handled per their nature:
//   - `hostRuntimeDisabledResponse` (also used by GET /api/runtimes) is promoted
//     to the neutral `routes/responses.ts` and imported here.
//   - `requireSessionBearerUser` / `standaloneMode` (session + deployment
//     concerns, no neutral response home) are injected as ports so the handlers
//     stay verbatim and no `bearerToken`-level helper cascade is moved.
import { Hono, type Context } from 'hono';
import {
  apiPaths,
  HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
  HOST_WS_CLOSE_REASON_DISCONNECTED,
  HostCreateInputSchema,
  HostClaimOrCreateInputSchema,
  HostDeleteInputSchema,
  HostProxyConfigSchema,
  type HostProxyConfigOfflineResponse,
  UpdateHostInputSchema,
  type AgentOnHostDto,
  type HostProxyConfigResponse,
  type RuntimeCatalogResponse,
  type HostStatusResponse,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AppEnv } from '../auth/principal.js';
import { HostRepo } from '../repos/host-repo.js';
import { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import { HostCredentialIssueError, HostTokenService } from '../auth/host-token.js';
import { HostWsCommandTransportError } from '../ws/host-ws-server.js';
import {
  HostTokenRotationCoordinator,
  HostTokenRotationError,
} from '../ws/host-token-rotation.js';
import { dispatchHostStatus } from '../runtime/host-status-dispatch.js';
import {
  dispatchHostRuntimeCatalog,
  type HostRuntimeCatalogOutcome,
} from '../runtime/host-runtime-catalog-dispatch.js';
import {
  dispatchHostProxyConfigGet,
  dispatchHostProxyConfigSet,
  type HostProxyConfigOutcome,
} from '../runtime/host-proxy-config-dispatch.js';
import { resolveOutboundForHost } from '../runtime/workspace-data-plane.js';
import { revokeHost } from '../application/revoke-host.js';
import { deleteAgentControlPlaneOnly } from '../application/delete-agent.js';
import { hostRuntimeDisabledResponse } from './responses.js';

const DEFAULT_DAEMON_NPM_SPEC = '@silverhand-ai/daemon@latest';
const DAEMON_NPM_SPEC_ENV = 'SILVERHAND_DAEMON_NPM_SPEC';

export interface HostRouteDeps {
  ctx: BackendContext;
  hosts: HostRepo;
  hostTokens: HostTokenService;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
  /**
   * Injected session-bearer resolver (port). Verbatim signature from routes.ts
   * so handlers call it unchanged; returns the user id or a 401 Response.
   */
  requireSessionBearerUser: (c: Context, ctx: BackendContext) => Response | string;
  /** Injected deployment-mode predicate (port). */
  standaloneMode: (ctx: BackendContext) => boolean;
}

/**
 * Host CRUD sub-app. Repos and cross-cutting helpers arrive via
 * {@link HostRouteDeps} so this module has no dependency on the composition root.
 */
export function createHostApp(deps: HostRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    hosts,
    hostTokens,
    agents,
    workspaces,
    conversations,
    conversationInboxes,
    requireSessionBearerUser,
    standaloneMode,
  } = deps;

  app.get(apiPaths.hosts, c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    return c.json({ hosts: hosts.listForUser(userId) });
  });

  app.post(apiPaths.hosts, async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const body = await c.req.json().catch(() => ({}));
    const parsed = HostCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const created = ctx.db.transaction(() => {
      const host = hosts.createUserInvite({ userId });
      const issued = hostTokens.issueHostToken({ hostId: host.id });
      return { host, connectToken: issued.hostToken };
    })();

    return c.json({
      host_id: created.host.id,
      host: hosts.toDto(created.host),
      connect_token: created.connectToken,
      daemon_npm_spec: daemonNpmSpec(),
    });
  });

  // GET /api/hosts/connect-token/resolve — daemon bootstrap for copied
  // user-managed connection commands. The command itself intentionally carries
  // no host id; the daemon proves possession of the connect token here, learns
  // the server-side host id for local data-root/config namespacing, and then
  // still uses the same token as the websocket bearer credential.
  app.get(apiPaths.hostConnectTokenResolve, c => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) {
      return c.json({ error: 'unauthorized', error_code: 'unauthorized' }, 401);
    }
    const verified = hostTokens.verifyHostToken(token);
    if (!verified.ok) {
      return c.json({ error: 'unauthorized', error_code: 'unauthorized' }, 401);
    }
    const host = hosts.get(verified.hostId);
    if (
      !host ||
      host.kind !== 'remote' ||
      host.provisioning_source !== 'user_invite' ||
      host.user_id === null ||
      host.revoked_at !== null
    ) {
      return c.json({ error: 'forbidden', error_code: 'forbidden' }, 403);
    }
    return c.json({ host_id: verified.hostId });
  });

  // GET /api/hosts/:id — owner-scoped by-id host read. The bulk list hides
  // unfinalized user-invite drafts so they never appear in the rail; this
  // endpoint intentionally returns them to the Add computer modal that minted
  // the draft and needs to observe pending → attached → active.
  app.get(apiPaths.host(':id'), c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    if (!hostId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const wsController = ctx.hostWsController?.();
    const attachment = wsController ? wsController.getAttachment(hostId) : null;
    return c.json({
      host: {
        ...hosts.toDto(host),
        connected_host_name: attachment?.hostname ?? null,
      },
    });
  });

  // DELETE /api/hosts/:id — delete an empty user-managed computer/setup.
  // This is intentionally a hard-delete, not the normal revoke lifecycle.
  // The DB already has RESTRICT foreign keys from agents/workspaces to hosts;
  // this route pre-counts those dependencies so the UI gets a typed 409 with
  // counts instead of an opaque SQLite constraint error. Pending setup drafts
  // naturally have zero dependents and use the same path.
  app.delete(apiPaths.hostDelete(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    if (!hostId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.provisioning_source !== 'user_invite' || host.kind !== 'remote') {
      return c.json(
        {
          error: 'delete is only supported for user-managed computers',
          error_code: 'provisioning_source_not_supported',
        },
        409,
      );
    }

    const parsedBody = HostDeleteInputSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsedBody.success) {
      return c.json({ error: 'invalid input', issues: parsedBody.error.issues }, 400);
    }

    const dependents = hosts.countDeleteDependents(hostId);
    const hostAgents = agents.listByHost(hostId);
    const hostDeleteAgents = hostAgents.map(agent => ({
      id: agent.id,
      name: agent.name,
      display_name: agent.display_name,
      runtime: agent.runtime,
    }));
    const pendingAgents = hostAgents.filter(
      agent => agent.materialization_status === 'pending_materialization',
    ).length;
    const canCascadeAgents =
      dependents.agents > 0 && dependents.workspaces === 0 && pendingAgents === 0;
    if (dependents.workspaces === 0 && pendingAgents > 0) {
      return c.json(
        {
          error:
            'computer has agents whose creation is still in progress; try again after creation finishes',
          error_code: 'has_pending_agents',
          pending_agents: pendingAgents,
        },
        409,
      );
    }
    if (dependents.workspaces > 0 || (dependents.agents > 0 && !parsedBody.data.cascade_agents)) {
      return c.json(
        {
          error: 'computer has dependent resources',
          error_code: 'has_dependents',
          dependents,
          agents: hostDeleteAgents,
          can_cascade_agents: canCascadeAgents,
        },
        409,
      );
    }

    try {
      if (dependents.agents > 0) {
        if (!canCascadeAgents) {
          return c.json(
            {
              error: 'computer has dependent resources',
              error_code: 'has_dependents',
              dependents,
              agents: hostDeleteAgents,
              can_cascade_agents: false,
            },
            409,
          );
        }
        const outbound = resolveOutboundForHost(
          ctx.outboundFrameAdapter?.() ?? null,
          hostId,
        );
        const purgeHostLocal = outbound.kind === 'ok';
        for (const agent of hostAgents) {
          const deletedAgent = await deleteAgentControlPlaneOnly(
            { ctx, agents, workspaces, conversations, conversationInboxes },
            agent.id,
            { reason: 'computer_delete_cascade', purgeHostLocal },
          );
          if (deletedAgent.kind === 'pendingInFlight') {
            return c.json(
              {
                error:
                  'computer has agents whose creation is still in progress; try again after creation finishes',
                error_code: 'has_pending_agents',
                pending_agents: 1,
              },
              409,
            );
          }
          if (deletedAgent.kind === 'failClosed') {
            return c.json(
              { error: deletedAgent.error, code: deletedAgent.code },
              deletedAgent.status,
            );
          }
        }
      }

      const deleted = hosts.deleteOwnedUserInvite({ hostId, userId });
      if (!deleted) {
        return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
      }
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        return c.json(
          {
            error: 'computer has dependent resources',
            error_code: 'has_dependents',
            dependents: hosts.countDeleteDependents(hostId),
            agents: agents.listByHost(hostId).map(agent => ({
              id: agent.id,
              name: agent.name,
              display_name: agent.display_name,
              runtime: agent.runtime,
            })),
            can_cascade_agents: false,
          },
          409,
        );
      }
      throw err;
    }

    const wsController = ctx.hostWsController?.();
    if (wsController) {
      try {
        wsController.disconnectHost(hostId);
      } catch (err) {
        ctx.logger.warn(
          { err, hostId, action: 'user_managed_delete_disconnect' },
          'user-managed computer delete disconnect failed (non-blocking)',
        );
      }
    }

    return c.json({ host_id: hostId, deleted: true });
  });

  app.post(apiPaths.hostClaimOrCreate, async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    // claim-or-create is the entry point for the desktop main process to
    // register itself with the backend and obtain a host_token to write into
    // daemon-config.json. In standalone deployment the same sequence runs: the
    // desktop's renderer logs in (session bearer), main calls claim-or-create
    // with `installation_id`,
    // backend mints a host row + host_token, main writes
    // daemon-config so the local daemon can attach via outbound
    // WSS. There is no architectural reason to forbid this in
    // standalone. Host-token rotation works in both modes, so claim-or-create
    // runs identically. This is a backend-internal HTTP route, not a
    // server↔daemon protocol change.

    const body = await c.req.json().catch(() => null);
    const parsed = HostClaimOrCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    // Stage B.4: `claimOrCreateLocal` filters revoked rows out of the
    // `(user, installation)` lookup, so this call always returns an
    // active host (either freshly minted, legacy reused, or an active
    // existing claim). The caller no longer needs a `host_revoked`
    // 409 branch here — re-claim after revoke transparently mints a
    // new active row, matching the active-only partial-unique index.
    const claimed = hosts.claimOrCreateLocal({
      userId,
      installationId: parsed.data.installation_id,
      preferredName: parsed.data.label,
    });

    let hostToken: string | undefined;
    if (
      parsed.data.current_host_id !== claimed.host.id ||
      !hostTokens.hasActiveLongLivedCredential(claimed.host.id)
    ) {
      try {
        hostToken = hostTokens.issueHostToken({ hostId: claimed.host.id }).hostToken;
      } catch (err) {
        if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
          // Defensive: the active-only filter above should make this
          // unreachable, but leave the typed mapping in place so a
          // future regression in the lookup surfaces as 409 rather
          // than as a 500.
          return c.json(
            {
              error: 'host has been revoked',
              error_code: 'host_revoked',
            },
            409,
          );
        }
        throw err;
      }
    }

    const response = {
      host_id: claimed.host.id,
      host: hosts.toDto(claimed.host),
      ...(hostToken ? { host_token: hostToken } : {}),
    };
    return c.json(response);
  });

  // POST /api/hosts/:id/revoke — Stage B.4 app-managed soft-delete. Owner-only,
  // 404 on cross-user/missing (no enumeration), idempotent. The host-row
  // revoke + credential sweep run as a single transaction; the post-commit
  // best-effort WS disconnect and all other orchestration live in the
  // `revokeHost` use case (`application/revoke-host.ts`). Does NOT cascade-
  // delete agents / workspaces / conversations — runtime placement is the
  // boundary that fails closed afterwards. User-managed computers intentionally
  // do not expose a revoke half-state: rotate handles credential emergencies;
  // delete handles empty-computer removal and blocks when dependents exist.
  app.post('/api/hosts/:id/revoke', async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    const hostId = c.req.param('id') ?? '';
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.provisioning_source === 'user_invite' && host.kind === 'remote') {
      return c.json(
        {
          error: 'revoke is not supported for user-managed computers',
          error_code: 'provisioning_source_not_supported',
        },
        409,
      );
    }

    const result = revokeHost(
      { ctx, hosts, hostTokens },
      { hostId, requesterUserId: userId },
    );
    switch (result.kind) {
      case 'revoked':
        return c.json({ host: result.host }, 200);
      case 'notFound':
        // Cross-user / missing collapse to 404 to avoid host_id enumeration.
        return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
      default: {
        const _exhaustive: never = result;
        throw new Error(`unreachable revokeHost result: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });

  // POST /api/hosts/:id/rotate-token — Stage B.4 long-lived token
  // rotation. Owner-only, 404 on cross-user/missing, 409 if the host
  // is already revoked or is not a `local` kind (V1 surface only
  // rotates the user's local host). Embedded mode returns a fresh
  // long_lived token for Electron main to write to daemon-config
  // before IPC returns to the renderer. Standalone mode sends the
  // cleartext replacement only over the host WebSocket `rotate_token`
  // command and returns no token bytes in the HTTP response.
  app.post('/api/hosts/:id/rotate-token', async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    if (!hostId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.revoked_at !== null) {
      return c.json(
        {
          error: 'host has been revoked',
          error_code: 'host_revoked',
        },
        409,
      );
    }
    if (host.kind !== 'local') {
      return c.json(
        {
          error: 'rotate is only supported for local hosts',
          error_code: 'kind_not_supported',
        },
        409,
      );
    }

    if (standaloneMode(ctx)) {
      const transport = ctx.hostWsController?.();
      if (!transport) {
        return hostRuntimeDisabledResponse(c, 'host token rotation', 503);
      }
      try {
        await new HostTokenRotationCoordinator({
          hostTokens,
          transport,
          logger: ctx.logger,
        }).rotateHostToken(hostId);
      } catch (err) {
        if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
          return c.json(
            {
              error: 'host has been revoked',
              error_code: 'host_revoked',
            },
            409,
          );
        }
        if (err instanceof HostWsCommandTransportError) {
          return c.json(
            {
              error: 'host token rotation transport failed',
              error_code: err.code,
            },
            err.code === 'transport_no_connection' ? 503 : 502,
          );
        }
        if (err instanceof HostTokenRotationError) {
          return c.json(
            {
              error: 'host token rotation rejected by daemon',
              error_code: 'host_token_rotation_failed',
              reason: err.details.daemonReason,
            },
            502,
          );
        }
        throw err;
      }

      const refreshed = hosts.get(hostId);
      if (!refreshed) {
        throw new Error(`HostRepo.get returned null for rotated host ${hostId}`);
      }
      return c.json({
        host_id: hostId,
        host: hosts.toDto(refreshed),
        status: 'rotated',
      });
    }

    let issued: ReturnType<HostTokenService['rotateHostToken']>;
    try {
      issued = hostTokens.rotateHostToken({ hostId });
    } catch (err) {
      if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
        return c.json(
          {
            error: 'host has been revoked',
            error_code: 'host_revoked',
          },
          409,
        );
      }
      throw err;
    }

    const refreshed = hosts.get(hostId);
    if (!refreshed) {
      throw new Error(`HostRepo.get returned null for rotated host ${hostId}`);
    }
    return c.json({
      host_id: hostId,
      host: hosts.toDto(refreshed),
      host_token: issued.hostToken,
    });
  });

  // POST /api/hosts/:id/connect-token/rotate — user-managed computer
  // reveal-once rotation. This route intentionally does NOT reuse the
  // desktop app-managed rotate-token semantics: no daemon-config write,
  // no grace window, no Electron-main token stripping. The fresh
  // connect-token is returned to the renderer exactly once so the UI can
  // show the new command card; the old token is immediately revoked and
  // any live daemon socket is force-dropped.
  app.post(apiPaths.hostRotateConnectToken(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id');
    if (!hostId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.revoked_at !== null) {
      return c.json(
        {
          error: 'host has been revoked',
          error_code: 'host_revoked',
        },
        409,
      );
    }
    if (host.provisioning_source !== 'user_invite' || host.kind !== 'remote') {
      return c.json(
        {
          error: 'connect-token rotation is only supported for user-managed computers',
          error_code: 'provisioning_source_not_supported',
        },
        409,
      );
    }

    let issued: ReturnType<HostTokenService['rotateHostTokenImmediate']>;
    try {
      issued = hostTokens.rotateHostTokenImmediate({ hostId });
    } catch (err) {
      if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
        return c.json(
          {
            error: 'host has been revoked',
            error_code: 'host_revoked',
          },
          409,
        );
      }
      throw err;
    }

    const wsController = ctx.hostWsController?.();
    if (wsController) {
      try {
        wsController.disconnectHost(hostId);
      } catch (err) {
        ctx.logger.warn(
          { err, hostId, action: 'connect_token_rotate_disconnect' },
          'connect-token rotate disconnect failed (non-blocking)',
        );
      }
    }

    const refreshed = hosts.get(hostId);
    if (!refreshed) {
      throw new Error(`HostRepo.get returned null for rotated host ${hostId}`);
    }
    return c.json({
      host_id: hostId,
      host: hosts.toDto(refreshed),
      status: 'rotated',
      connect_token: issued.hostToken,
      daemon_npm_spec: daemonNpmSpec(),
    });
  });

  // POST /api/hosts/:id/disconnect — availability-axis only. This force-drops
  // the current live websocket for a finalized user-managed computer, but
  // deliberately leaves credentials and lifecycle timestamps untouched so the
  // same connection command can reconnect later. Unlike rotate/revoke, this is
  // a benign no-op when no daemon is currently attached.
  app.post(apiPaths.hostDisconnect(':id'), c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id');
    if (!hostId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.revoked_at !== null) {
      return c.json(
        {
          error: 'host has been revoked',
          error_code: 'host_revoked',
        },
        409,
      );
    }
    if (host.provisioning_source !== 'user_invite' || host.kind !== 'remote') {
      return c.json(
        {
          error: 'disconnect is only supported for active user-managed computers',
          error_code: 'provisioning_source_not_supported',
        },
        409,
      );
    }
    if (host.finalized_at === null) {
      return c.json(
        {
          error: 'host is not active',
          error_code: 'host_not_active',
        },
        409,
      );
    }

    let disconnected = false;
    const wsController = ctx.hostWsController?.();
    if (wsController) {
      try {
        disconnected = wsController.disconnectHost(
          hostId,
          HOST_WS_CLOSE_REASON_DISCONNECTED,
        );
      } catch (err) {
        ctx.logger.warn(
          { err, hostId, action: 'user_managed_disconnect' },
          'user-managed disconnect failed',
        );
        return c.json(
          {
            error: 'disconnect failed',
            error_code: 'disconnect_failed',
          },
          502,
        );
      }
    }

    const refreshed = hosts.get(hostId);
    if (!refreshed) {
      throw new Error(`HostRepo.get returned null for disconnected host ${hostId}`);
    }
    return c.json({
      host_id: hostId,
      host: hosts.toDto(refreshed),
      disconnected,
    });
  });

  // GET/PUT /api/hosts/:id/proxy-config — host-local network proxy config.
  // The backend owns only authz and dispatch; the proxy bytes live on the
  // target computer and are read/written by its daemon. Offline therefore
  // fail-closes for both read and write with a typed `computer_offline`.
  app.get(apiPaths.hostProxyConfig(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    const gate = gateHostDataPlane(hosts, userId, hostId);
    if (gate) return gate(c);

    const outcome = await dispatchHostProxyConfigGet(
      ctx.outboundFrameAdapter?.() ?? null,
      hostId,
    );
    return renderHostProxyConfigOutcome(c, outcome);
  });

  app.put(apiPaths.hostProxyConfig(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    const gate = gateHostDataPlane(hosts, userId, hostId);
    if (gate) return gate(c);

    const body = await c.req.json().catch(() => null);
    const parsed = HostProxyConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const outcome = await dispatchHostProxyConfigSet(
      ctx.outboundFrameAdapter?.() ?? null,
      hostId,
      parsed.data,
    );
    return renderHostProxyConfigOutcome(c, outcome);
  });

  // GET /api/hosts/:id/runtime-catalog — host-local runtime availability.
  // Backend owns only authz and dispatch; the target daemon probes the same
  // resolver spawn uses. `force=1` bypasses the short host resolver cache.
  app.get(apiPaths.hostRuntimeCatalog(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id') ?? '';
    const gate = gateHostDataPlane(hosts, userId, hostId);
    if (gate) return gate(c);

    const outcome = await dispatchHostRuntimeCatalog(
      ctx.outboundFrameAdapter?.() ?? null,
      hostId,
      { force: parseBooleanQuery(c.req.query('force')) },
    );
    return renderHostRuntimeCatalogOutcome(c, outcome);
  });

  // PATCH /api/hosts/:id — rename, and finalizes a user-managed setup after
  // first daemon attach. Only `display_label` is mutable; `name` stays the
  // stable identifier set at claim time.
  // Owner-only; 404 on cross-user / missing (no enumeration); the route
  // also refuses revoked hosts so a renamed-then-revoked workflow can't
  // silently mutate audit history. Body validation is loose (256-char
  // cap) — the repo's `normalizeDisplayLabel` does trim + slice-to-64 +
  // empty→null in one round-trip, so a user typing past the visible
  // field length gets auto-truncation rather than a 400.
  app.patch(apiPaths.host(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id');
    if (!hostId) {
      return c.json(
        { error: 'host not found', error_code: 'host_not_found' },
        404,
      );
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json(
        { error: 'host not found', error_code: 'host_not_found' },
        404,
      );
    }
    if (host.revoked_at !== null) {
      return c.json(
        { error: 'host has been revoked', error_code: 'host_revoked' },
        409,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateHostInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', issues: parsed.error.issues },
        400,
      );
    }

    const finalizingUserInvite =
      host.provisioning_source === 'user_invite' &&
      host.kind === 'remote' &&
      host.finalized_at === null;
    if (finalizingUserInvite) {
      if (host.activated_at === null) {
        return c.json(
          {
            error: 'host has not completed its first daemon attachment',
            error_code: 'host_pending_attach',
          },
          409,
        );
      }
      if (parsed.data.display_label === null || parsed.data.display_label.trim() === '') {
        return c.json(
          {
            error: 'computer name is required',
            error_code: 'display_label_required',
          },
          400,
        );
      }
    }

    const updated = ctx.db.transaction(() => {
      const renamed = hosts.updateDisplayLabel(hostId, parsed.data.display_label);
      if (!renamed) return null;
      if (finalizingUserInvite) {
        return hosts.markFinalized(hostId);
      }
      return renamed;
    })();
    if (!updated) {
      // Unreachable: SELECT immediately after the UPDATE we just ran on
      // a row we know exists. Surface as 500 if it ever happens so the
      // contract stays loud.
      throw new Error(
        `HostRepo.updateDisplayLabel returned null for ${hostId}`,
      );
    }
    return c.json({ host: hosts.toDto(updated) });
  });

  // GET /api/hosts/:id/status — dynamic host snapshot.
  // Powers the ComputerPane / HostDetailView. Owner-only; 404 on
  // cross-user / missing (no enumeration). Always HTTP 200 with a
  // tagged `availability` once owner ACL passes — the renderer
  // discriminates between `available` / `disconnected` / `unreachable` /
  // `revoked` rather than mapping a 503 to "offline".
  //
  // Branch construction is intentionally per-arm (no shared mutable base
  // object): the renderer-facing schema is a discriminatedUnion and each
  // arm is `.strict()`, so building each response inline guarantees we
  // never accidentally leak a half-built `snapshot` onto a non-available
  // arm or a `reason` onto an `available` arm.
  //
  // `agents[]` sits at the response arm root on EVERY 200 arm — registration
  // is a DB fact, not a daemon fact. On non-`available` arms every row has
  // `online: 'offline'`; on `available` we enrich with daemon's active agents.
  // `snapshot` carries ONLY dynamic daemon-derived fields.
  app.get(apiPaths.hostStatus(':id'), async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id');
    if (!hostId) {
      return c.json(
        { error: 'host not found', error_code: 'host_not_found' },
        404,
      );
    }
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json(
        { error: 'host not found', error_code: 'host_not_found' },
        404,
      );
    }

    // Build the registration view in ONE place — same `failed`-filter,
    // same row mapping, regardless of arm. `activeSet` is null on every
    // non-`available` arm (no live daemon to ask) so every row falls to
    // `offline`. On `available` we pass the daemon-derived set so the
    // live runtimes light up. A single function prevents drift between offline
    // and online arms.
    //
    // Match `AgentRepo.list()` default projection — the failed-agent
    // management view is a separate surface (Q6.a). `pending_materialization`
    // rows stay so freshly created agents show up immediately (they
    // just can't be online yet).
    const buildAgentRows = (
      activeSet: ReadonlySet<string> | null,
    ): AgentOnHostDto[] =>
      agents
        .listByHost(hostId)
        .filter(a => a.materialization_status !== 'failed')
        .map(a => ({
          agent_id: a.id,
          display_name: a.display_name,
          handle: `@${a.name}`,
          runtime: a.runtime,
          avatar_url: a.avatar_url,
          online: activeSet?.has(a.id) ? 'online' : 'offline',
        }));

    // Revoked hosts short-circuit BEFORE the daemon dispatch — even if
    // the daemon happens to still be answering on a stale long_lived
    // credential (rotate-token grace window) we don't want ComputerPane
    // to pretend the host is usable. We still include the registered
    // agents list (all offline) so the user can see which agents lived
    // on this host before deciding to delete or re-claim.
    if (host.revoked_at !== null) {
      return c.json({
        host_id: hostId,
        availability: 'revoked',
        agents: buildAgentRows(null),
        last_seen_at: host.last_seen_at,
      } satisfies HostStatusResponse);
    }

    const dispatch = await dispatchHostStatus(
      ctx.outboundFrameAdapter?.() ?? null,
      hostId,
    );

    if (dispatch.kind === 'disconnected') {
      return c.json({
        host_id: hostId,
        availability: 'disconnected',
        agents: buildAgentRows(null),
        last_seen_at: host.last_seen_at,
      } satisfies HostStatusResponse);
    }
    if (dispatch.kind === 'unreachable') {
      return c.json({
        host_id: hostId,
        availability: 'unreachable',
        reason: dispatch.reason,
        agents: buildAgentRows(null),
        last_seen_at: host.last_seen_at,
      } satisfies HostStatusResponse);
    }

    // `dispatch.kind === 'ok'` — live daemon → per-row `online`
    // enrichment from `active_agent_ids`. Daemon-reported ids NOT in
    // the registration are filler-noise and do NOT get injected as
    // phantom rows (registration view is the source of truth).
    const activeSet = new Set(dispatch.result.active_agent_ids);

    return c.json({
      host_id: hostId,
      availability: 'available',
      snapshot: {
        os: dispatch.result.os,
        os_arch: dispatch.result.os_arch,
        daemon_pid: dispatch.result.daemon_pid,
        daemon_version: dispatch.result.daemon_version,
        started_at: dispatch.result.started_at,
        uptime_ms: dispatch.result.uptime_ms,
      },
      agents: buildAgentRows(activeSet),
      last_seen_at: host.last_seen_at,
    } satisfies HostStatusResponse);
  });

  return app;
}

type HostDataPlaneGate = (c: Context) => Response;

function gateHostDataPlane(
  hosts: HostRepo,
  userId: string,
  hostId: string | undefined,
): HostDataPlaneGate | null {
  if (!hostId) {
    return c =>
      c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
  }
  const host = hosts.get(hostId);
  if (!host || host.user_id !== userId) {
    return c =>
      c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
  }
  if (host.revoked_at !== null) {
    return c =>
      c.json({ error: 'host has been revoked', error_code: 'host_revoked' }, 409);
  }
  if (host.finalized_at === null) {
    return c =>
      c.json({ error: 'host is not active', error_code: 'host_not_active' }, 409);
  }
  return null;
}

function parseBooleanQuery(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function renderHostRuntimeCatalogOutcome(
  c: Context,
  outcome: HostRuntimeCatalogOutcome,
): Response {
  if (outcome.kind === 'ok') {
    return c.json(outcome.catalog satisfies RuntimeCatalogResponse);
  }
  if (outcome.code === 'host_attach_pending') {
    return c.json(
      { error: 'computer is offline', error_code: 'computer_offline' },
      503,
    );
  }
  return c.json(
    { error: outcome.message, error_code: outcome.code },
    outcome.status,
  );
}

function renderHostProxyConfigOutcome(
  c: Context,
  outcome: HostProxyConfigOutcome,
): Response {
  if (outcome.kind === 'ok') {
    return c.json({ config: outcome.config } satisfies HostProxyConfigResponse);
  }
  if (outcome.code === 'host_attach_pending') {
    return c.json(
      {
        error: 'computer is offline',
        error_code: HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
      } satisfies HostProxyConfigOfflineResponse,
      503,
    );
  }
  return c.json(
    { error: outcome.message, error_code: outcome.code },
    outcome.status,
  );
}

function daemonNpmSpec(): string {
  return process.env[DAEMON_NPM_SPEC_ENV]?.trim() || DEFAULT_DAEMON_NPM_SPEC;
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isForeignKeyConstraintError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY constraint failed/.test(err.message);
}
