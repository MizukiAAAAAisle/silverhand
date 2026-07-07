import type { Context, Hono } from 'hono';
import {
  apiPaths,
  probePaths,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import { UserRepo } from '../repos/user-repo.js';

/**
 * Public user principal resolved from the request itself. Public API
 * callers must present a user session bearer; the bearer middleware sets
 * the principal. No request-bound principal means the registration gate
 * sees "no viewer" and refuses non-whitelisted routes.
 */
export type UserPrincipal = { kind: 'user'; userId: string };
export type AgentPrincipal = {
  kind: 'agent';
  agentId: string;
  conversationId: string;
};
export type SystemPrincipal = { kind: 'system' };
export type Principal = UserPrincipal | AgentPrincipal | SystemPrincipal;

export type AppEnv = {
  Variables: {
    /** Optional: absent in the registration-required state. */
    principal?: Principal;
  };
};

export type AppContext = Context<AppEnv>;

export class PrincipalConversationMismatchError extends Error {
  constructor(
    public readonly actorConversationId: string,
    public readonly inputConversationId: string,
  ) {
    super(
      `agent principal conversationId (${actorConversationId}) does not match input conversationId (${inputConversationId})`,
    );
    this.name = 'PrincipalConversationMismatchError';
  }
}

const PRINCIPAL_CONTEXT_KEY = 'principal';

function skipsPublicSetupGates(path: string): boolean {
  return (
    path === apiPaths.health
    || path === apiPaths.serverInfo
    || path === apiPaths.hostConnectTokenResolve
    || path === probePaths.readyz
    || path.startsWith('/auth/')
  );
}

export function installPublicPrincipalMiddleware(app: Hono<AppEnv>): void {
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/internal/')) {
      await next();
      return;
    }
    // Anonymous/public paths skip principal resolution entirely. Session
    // bearer requests already have their principal set by bearer.ts.
    if (skipsPublicSetupGates(c.req.path)) {
      await next();
      return;
    }
    if (c.get(PRINCIPAL_CONTEXT_KEY)) {
      await next();
      return;
    }
    // Registration-required / no-principal state. Don't synthesize a
    // principal from legacy headers; the bearer middleware is the only
    // public principal source after Stage C.6.
    await next();
  });
}

/**
 * Install the registration gate. Runs AFTER `installPublicPrincipalMiddleware`
 * so the optional principal is in context. Behavior:
 *
 *   - Internal routes (agent principal) skip — agents have no identity
 *     state and run with their own (cid, aid) auth.
 *   - liveness/readiness probes, `/api/server/info`, and `/auth/*`
 *     skip — they are anonymous/public or own their auth response
 *     semantics.
 *   - Whitelisted public routes pass through this gate. In C.6+
 *     `/api/server/info` remains anonymous at the bearer layer; `GET
 *     /api/me` is kept here only as a defensive setup-route allowlist.
 *   - No principal set → 403 `registration_required` if a future route
 *     reaches the gate without bearer authentication.
 *   - Principal set but underlying `users` row missing → 500
 *     (`viewer user pointer is dangling`). Indicates DB corruption.
 *   - Otherwise → next.
 *
 * Renderer-side `App.tsx` mirrors this contract by mounting
 * `<RegistrationGate>` instead of the AppShell pre-registration. This
 * middleware is the security half (V2 multi-user, CLI tools, any
 * non-renderer caller).
 */
export function installRequireRegisteredViewerMiddleware(
  app: Hono<AppEnv>,
  ctx: BackendContext,
  options: { whitelistPaths: ReadonlyArray<string> },
): void {
  // Method+path tuples that bypass the gate. We narrow each whitelist
  // path to a single verb at install time so this gate does not widen
  // setup-route access if the bearer allowlist changes later.
  const narrowed = new Set<string>();
  for (const p of options.whitelistPaths) {
    if (p === apiPaths.me) narrowed.add(`GET ${p}`);
    else if (p === apiPaths.serverInfo) narrowed.add(`GET ${p}`);
    else {
      // Unknown whitelist path — fail loud at install time so we don't
      // silently widen the gate. New whitelisted routes must be
      // explicitly narrowed above.
      throw new Error(
        `installRequireRegisteredViewerMiddleware: unknown whitelist path '${p}'`,
      );
    }
  }

  const users = new UserRepo(ctx.db);

  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/internal/')) {
      await next();
      return;
    }
    if (skipsPublicSetupGates(c.req.path)) {
      await next();
      return;
    }
    const key = `${c.req.method.toUpperCase()} ${c.req.path}`;
    if (narrowed.has(key)) {
      await next();
      return;
    }
    const principal = c.get(PRINCIPAL_CONTEXT_KEY) as Principal | undefined;
    if (!principal || principal.kind !== 'user') {
      // No principal set ⇒ pre-registration. All non-whitelisted public
      // routes are off-limits. This is the inversion of the prior
      // "if no principal, defensively allow" fallback — under the new
      // identity model "no principal" is the unregistered signal.
      return c.json(
        {
          error: 'viewer has not authenticated yet',
          code: 'registration_required',
        },
        403,
      );
    }
    const row = users.get(principal.userId);
    if (!row) {
      // The principal middleware already verified this row exists when
      // it resolved. Reaching this branch means the row was deleted
      // between resolution and gate — DB corruption / race. 500 is the
      // honest answer.
      return c.json({ error: 'viewer user pointer is dangling' }, 500);
    }
    await next();
  });
}

export function installInternalPrincipalMiddleware(
  app: Hono<AppEnv>,
  repos: { agents: AgentRepo; conversations: ConversationRepo },
): void {
  app.use('/internal/conversations/:cid/agents/:aid/*', async (c, next) => {
    if (c.req.header(X_SILVERHAND_PRINCIPAL_HEADER)) {
      return c.json({ error: 'principal header is not allowed on internal routes' }, 400);
    }

    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!repos.conversations.get(cid)) {
      return c.json({ error: 'conversation not found' }, 404);
    }
    if (!repos.agents.get(aid)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!repos.conversations.getAgent(cid, aid)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 403);
    }

    setPrincipal(c, { kind: 'agent', agentId: aid, conversationId: cid });
    await next();
  });
}

export function setPrincipal(c: AppContext, principal: Principal): void {
  c.set(PRINCIPAL_CONTEXT_KEY, principal);
}

export function getPrincipal(c: AppContext): Principal {
  const principal = c.get(PRINCIPAL_CONTEXT_KEY);
  if (!isPrincipal(principal)) {
    throw new Error('principal has not been resolved for this request');
  }
  return principal;
}

export function getUserPrincipal(c: AppContext): UserPrincipal {
  const principal = getPrincipal(c);
  if (principal.kind !== 'user') {
    throw new Error(`expected user principal, got ${principal.kind}`);
  }
  return principal;
}

// Viewer principal → user id. Principal projection (not route-context logic),
// so it lives next to `getUserPrincipal`. Both forms are kept: callers use
// `requireViewerUserId`; `resolveViewerUserId` is the underlying primitive
// (the forwarding is pre-existing and intentionally preserved verbatim).
export function resolveViewerUserId(c: AppContext): string {
  return getUserPrincipal(c).userId;
}

export function requireViewerUserId(c: AppContext): string {
  return resolveViewerUserId(c);
}

export function getAgentPrincipal(c: AppContext): AgentPrincipal {
  const principal = getPrincipal(c);
  if (principal.kind !== 'agent') {
    throw new Error(`expected agent principal, got ${principal.kind}`);
  }
  return principal;
}

export function assertActorConversationMatch(
  actor: UserPrincipal | AgentPrincipal,
  inputConversationId: string,
): void {
  if (actor.kind === 'agent' && actor.conversationId !== inputConversationId) {
    throw new PrincipalConversationMismatchError(
      actor.conversationId,
      inputConversationId,
    );
  }
}

function isPrincipal(value: unknown): value is Principal {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'system') return true;
  if (kind === 'user') {
    return typeof (value as { userId?: unknown }).userId === 'string';
  }
  if (kind === 'agent') {
    return (
      typeof (value as { agentId?: unknown }).agentId === 'string' &&
      typeof (value as { conversationId?: unknown }).conversationId === 'string'
    );
  }
  return false;
}
