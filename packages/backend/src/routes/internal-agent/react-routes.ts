// Agent reaction facet (docs/reactions-design.md §5.1 / §1). A reaction is
// a WRITE, so it carries the same `send_messages` capability gate as posting a
// message — not a read capability. POST adds, DELETE removes; both take
// `{message_id, emoji}`. The use case enforces that the target message is in
// the agent's own conversation (via canViewConversation on the agent
// principal), rejects system messages, and excludes the write from the message
// CAS (§12.A).
import type { Context, Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import { canPostToConversation } from '../../permissions.js';
import {
  addReaction,
  removeReaction,
} from '../../application/react-message.js';
import { reactionResultResponse } from '../responses.js';
import {
  AgentReactMessageInputSchema,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { requireAgentConversationCapability } from './capability-scope.js';
import { internalAgentRoutePaths } from './paths.js';

export function registerReactRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, conversations, messages, reactions } = deps;

  const handleAgentReact = async (
    c: Context,
    op: 'add' | 'remove',
  ): Promise<Response> => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReactMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'send_messages', conversations.getIdentity(principal.conversationId));
      if (denied) return denied;
    }
    const input = {
      principal,
      messageId: parsed.data.message_id,
      emoji: parsed.data.emoji,
    };
    const result =
      op === 'add'
        ? await addReaction({ ctx, conversations, messages, reactions }, input)
        : await removeReaction({ ctx, conversations, messages, reactions }, input);
    return reactionResultResponse(c, result);
  };

  app.post(internalAgentRoutePaths.reactMessage, c =>
    handleAgentReact(c, 'add'),
  );
  app.delete(internalAgentRoutePaths.reactMessage, c =>
    handleAgentReact(c, 'remove'),
  );
}
