// Host CRUD surface:
//   - GET  /api/hosts                  list the session user's hosts
//   - POST /api/hosts/claim_or_create  desktop main registers + mints host_token
//   - POST /api/hosts/:id/revoke       soft-delete (delegates to revokeHost use case)
//   - POST /api/hosts/:id/rotate-token long-lived token rotation
//   - PATCH /api/hosts/:id             rename (display_label)
//   - GET  /api/hosts/:id/status       dynamic host snapshot (daemon dispatch)
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
  HostClaimOrCreateInputSchema,
  UpdateHostInputSchema,
  type AgentOnHostDto,
  type HostStatusResponse,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AppEnv } from '../auth/principal.js';
import { HostRepo } from '../repos/host-repo.js';
import { AgentRepo } from '../repos/agent-repo.js';
import { HostCredentialIssueError, HostTokenService } from '../auth/host-token.js';
import { HostWsCommandTransportError } from '../ws/host-ws-server.js';
import {
  HostTokenRotationCoordinator,
  HostTokenRotationError,
} from '../ws/host-token-rotation.js';
import { dispatchHostStatus } from '../runtime/host-status-dispatch.js';
import { revokeHost } from '../application/revoke-host.js';
import { hostRuntimeDisabledResponse } from './responses.js';

export interface HostRouteDeps {
  ctx: BackendContext;
  hosts: HostRepo;
  hostTokens: HostTokenService;
  agents: AgentRepo;
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
  const { ctx, hosts, hostTokens, agents, requireSessionBearerUser, standaloneMode } = deps;

  app.get(apiPaths.hosts, c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    return c.json({ hosts: hosts.listForUser(userId) });
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
      server_url: ctx.serverConfig.url,
      ...(hostToken ? { host_token: hostToken } : {}),
    };
    return c.json(response);
  });

  // POST /api/hosts/:id/revoke — Stage B.4 soft-delete. Owner-only,
  // 404 on cross-user/missing (no enumeration), idempotent. The host-row
  // revoke + credential sweep run as a single transaction; the post-commit
  // best-effort WS disconnect and all other orchestration live in the
  // `revokeHost` use case (`application/revoke-host.ts`). Does NOT cascade-
  // delete agents / workspaces / conversations — runtime placement is the
  // boundary that fails closed afterwards.
  app.post('/api/hosts/:id/revoke', async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const result = revokeHost(
      { ctx, hosts, hostTokens },
      { hostId: c.req.param('id'), requesterUserId: userId },
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

    const hostId = c.req.param('id');
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

  // PATCH /api/hosts/:id — rename. Only `display_label` is mutable; `name`
  // stays the stable identifier set at claim time.
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

    const updated = hosts.updateDisplayLabel(hostId, parsed.data.display_label);
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
