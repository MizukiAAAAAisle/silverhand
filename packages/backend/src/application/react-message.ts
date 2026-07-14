import {
  MESSAGE_REACTION_CHANGED_EVENT,
  type MessageReactionChangedEvent,
  type ReactorKind,
  validateReactionEmoji,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { Principal } from '../auth/principal.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { MessageReactionRepo } from '../repos/message-reaction-repo.js';
import { canViewConversation } from '../permissions.js';
import { type PostCommitEffect, runPostCommitEffects } from './post-commit.js';

/**
 * Add / remove a reaction on a message (docs/reactions-design.md §5.1).
 *
 * The load-bearing invariant lives here by what these use cases DON'T do:
 * the write touches ONLY `message_reactions` (via the repo) — never a message
 * row, never `conversations.latest_message_seq`, never a stream head. A
 * reaction is an out-of-band projection, not a stream event, so it must not
 * advance any freshness CAS (§12.A). The broadcast is a post-commit effect on
 * the conversation scope, with its own open event kind — it does not ride the
 * message/stream-head machinery.
 *
 * Authorization mirrors the send path's view/membership gate, plus the
 * write-only guards: reject the system principal, reject reacting TO a system
 * message (§12.E), and reject closed/archived conversations (§12.F).
 */
export type ReactionErrorCode =
  | 'invalid_reaction'
  | 'message_not_found'
  | 'system_message_not_reactable'
  | 'conversation_not_found'
  | 'forbidden'
  | 'conversation_closed'
  | 'conversation_archived';

export type ReactionError = { code: ReactionErrorCode; message: string };

export type ReactionResult =
  | { ok: true; changed: boolean; emoji: string; count: number }
  | { ok: false; error: ReactionError };

export type ReactMessageDeps = {
  ctx: BackendContext;
  conversations: ConversationRepo;
  messages: MessageRepo;
  reactions: MessageReactionRepo;
};

export type ReactMessageInput = {
  principal: Principal;
  messageId: string;
  emoji: string;
};

/** Resolve a Principal to its reactor identity. System principals do not
 *  react (the caller rejects them first), so this only handles user/agent. */
function reactorOf(
  principal: Principal,
): { kind: ReactorKind; id: string } | null {
  if (principal.kind === 'user') return { kind: 'user', id: principal.userId };
  if (principal.kind === 'agent') return { kind: 'agent', id: principal.agentId };
  return null;
}

/** Shared precondition resolution for add/remove: emoji validity, message
 *  existence, system-message rejection, conversation visibility, and
 *  closed/archived guards. Returns the resolved write context or a typed
 *  error. */
function resolveReactionContext(
  deps: ReactMessageDeps,
  input: ReactMessageInput,
):
  | {
      ok: true;
      emoji: string;
      reactor: { kind: ReactorKind; id: string };
      conversationId: string;
      threadRootId: string | null;
    }
  | { ok: false; error: ReactionError } {
  const reactor = reactorOf(input.principal);
  if (!reactor) {
    return {
      ok: false,
      error: { code: 'forbidden', message: 'system principal cannot react' },
    };
  }

  const validated = validateReactionEmoji(input.emoji);
  if (!validated.ok) {
    return {
      ok: false,
      error: { code: 'invalid_reaction', message: validated.reason },
    };
  }

  const message = deps.messages.getById(input.messageId);
  if (!message) {
    return {
      ok: false,
      error: { code: 'message_not_found', message: 'message not found' },
    };
  }
  // §12.E: a system message (task-claim notices, member-added rows, …) is not
  // a reaction target. Reacting to it would force a chip onto the system
  // activity cluster — out of v1 scope.
  if (message.from_kind === 'system') {
    return {
      ok: false,
      error: {
        code: 'system_message_not_reactable',
        message: 'cannot react to a system message',
      },
    };
  }

  const conversation = deps.conversations.get(message.conversation_id);
  if (!conversation) {
    return {
      ok: false,
      error: {
        code: 'conversation_not_found',
        message: 'conversation not found',
      },
    };
  }

  // Same view/membership gate as sending: a reactor must be able to see the
  // conversation (channel membership for users, conversation membership for
  // agents). The route also runs a capability check for agents.
  if (!canViewConversation(deps.ctx, input.principal, conversation.id)) {
    return {
      ok: false,
      error: { code: 'forbidden', message: 'cannot react in this conversation' },
    };
  }

  // §12.F: a reaction is a write — reject closed/archived, reusing the same
  // guard sendMessage applies. For a legacy isolated-thread conversation,
  // also honor the parent channel's state (parity with the send target check).
  const closedArchived = checkOpen(deps, conversation);
  if (closedArchived) return { ok: false, error: closedArchived };

  return {
    ok: true,
    emoji: validated.emoji,
    reactor,
    conversationId: conversation.id,
    threadRootId: message.thread_root_id,
  };
}

type ConversationLike = NonNullable<ReturnType<ConversationRepo['get']>>;

/** Closed/archived guard. Returns an error when the conversation (or, for a
 *  legacy thread, its parent channel) is closed/archived; null when open. */
function checkOpen(
  deps: ReactMessageDeps,
  conversation: ConversationLike,
): ReactionError | null {
  if (conversation.closed_at !== null) {
    return { code: 'conversation_closed', message: 'conversation is closed' };
  }
  if (conversation.archived_at !== null) {
    return {
      code: 'conversation_archived',
      message: 'conversation is archived',
    };
  }
  return null;
}

function publishReactionChanged(
  ctx: BackendContext,
  payload: MessageReactionChangedEvent,
): void {
  ctx.events.publishToScope(
    `conversation:${payload.conversation_id}`,
    MESSAGE_REACTION_CHANGED_EVENT,
    payload,
  );
}

export async function addReaction(
  deps: ReactMessageDeps,
  input: ReactMessageInput,
): Promise<ReactionResult> {
  const resolved = resolveReactionContext(deps, input);
  if (!resolved.ok) return resolved;
  const { emoji, reactor, conversationId, threadRootId } = resolved;

  const now = Date.now();
  const { created } = deps.ctx.db.transaction(() =>
    deps.reactions.add(input.messageId, reactor.kind, reactor.id, emoji, now),
  )();

  // Re-adding an existing reaction is an idempotent no-op: no count change,
  // no event.
  if (!created) {
    const count = deps.reactions.countForEmoji(input.messageId, emoji);
    return { ok: true, changed: false, emoji, count };
  }

  const count = deps.reactions.countForEmoji(input.messageId, emoji);
  const effects: PostCommitEffect[] = [
    () =>
      publishReactionChanged(deps.ctx, {
        message_id: input.messageId,
        conversation_id: conversationId,
        thread_root_id: threadRootId,
        emoji,
        op: 'add',
        reactor_kind: reactor.kind,
        reactor_id: reactor.id,
        count,
      }),
  ];
  await runPostCommitEffects(effects, deps.ctx.logger);
  return { ok: true, changed: true, emoji, count };
}

export async function removeReaction(
  deps: ReactMessageDeps,
  input: ReactMessageInput,
): Promise<ReactionResult> {
  const resolved = resolveReactionContext(deps, input);
  if (!resolved.ok) return resolved;
  const { emoji, reactor, conversationId, threadRootId } = resolved;

  const { removed } = deps.ctx.db.transaction(() =>
    deps.reactions.remove(input.messageId, reactor.kind, reactor.id, emoji),
  )();

  const count = deps.reactions.countForEmoji(input.messageId, emoji);
  if (!removed) {
    // Removing a reaction that wasn't there is an idempotent no-op.
    return { ok: true, changed: false, emoji, count };
  }

  const effects: PostCommitEffect[] = [
    () =>
      publishReactionChanged(deps.ctx, {
        message_id: input.messageId,
        conversation_id: conversationId,
        thread_root_id: threadRootId,
        emoji,
        op: 'remove',
        reactor_kind: reactor.kind,
        reactor_id: reactor.id,
        count,
      }),
  ];
  await runPostCommitEffects(effects, deps.ctx.logger);
  return { ok: true, changed: true, emoji, count };
}
