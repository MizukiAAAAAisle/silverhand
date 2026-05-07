import type { Context, Hono } from 'hono';
import {
  decodeUserPrincipalHeader,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';

export type UserPrincipal = { kind: 'user'; userId: string | null };
export type AgentPrincipal = {
  kind: 'agent';
  agentId: string;
  conversationId: string;
};
export type SystemPrincipal = { kind: 'system' };
export type Principal = UserPrincipal | AgentPrincipal | SystemPrincipal;

export type AppEnv = {
  Variables: {
    principal: Principal;
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

export function installPublicPrincipalMiddleware(
  app: Hono<AppEnv>,
  ctx: BackendContext,
): void {
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/internal/')) {
      await next();
      return;
    }
    const resolved = resolvePublicUserPrincipal(c, ctx);
    if (resolved instanceof Response) return resolved;
    setPrincipal(c, resolved);
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

export function resolvePublicUserPrincipal(
  c: AppContext,
  ctx: BackendContext,
): UserPrincipal | Response {
  const principalHeader = c.req.header(X_SILVERHAND_PRINCIPAL_HEADER)?.trim();
  if (principalHeader) {
    const userId = decodeUserPrincipalHeader(principalHeader);
    if (!userId) {
      return c.json({ error: 'invalid principal header' }, 400);
    }
    return { kind: 'user', userId };
  }

  const legacyUserId = c.req.header(X_SILVERHAND_LEGACY_USER_ID_HEADER)?.trim();
  return {
    kind: 'user',
    userId: legacyUserId || ctx.serverConfig.user_id || null,
  };
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
  if (kind === 'user') return 'userId' in value;
  if (kind === 'agent') {
    return (
      typeof (value as { agentId?: unknown }).agentId === 'string' &&
      typeof (value as { conversationId?: unknown }).conversationId === 'string'
    );
  }
  return false;
}
