import type { BackendLogger } from '../context.js';
import type {
  MembershipConversationRef,
  MembershipPersistence,
  WorkspaceMemberRef,
} from './membership-ports.js';
import {
  type ConversationMemberAddedActorSnapshot,
  type ConversationMemberAddedMemberSnapshot,
  conversationMemberRemovedContent,
  conversationMemberRemovedMetadata,
} from './conversation-member-audit.js';
import type { MessageDto } from '@silverhand/shared';

/**
 * RemoveWorkspaceMember use case (#task:1982 W5) — the cascade behind
 * `DELETE /api/workspaces/:id/members/:agentId`,
 * `DELETE /api/workspaces/:id/members/users/:userId` and
 * `POST /api/workspaces/:id/leave`.
 *
 * ## Why this stopped being a route body
 *
 * The route listed the workspace's conversations containing the member, ran the
 * runtime stops, and then opened `ctx.db.transaction` and cascaded over THAT
 * LIST. The list was therefore a decision taken before the transaction that acts
 * on it: a membership added in between kept its `conversation_agents` row (and
 * got no audit message) while its workspace membership was deleted — a member of
 * a channel of a workspace it does not belong to. Here the pre-transaction list
 * is a stop HINT only; the cascade is driven by
 * `listConversationsWithMemberForUpdate`, recomputed under the anchor. This use
 * case does not — and cannot — take the anchor itself: it passes the coordination
 * key to `atomically`, which acquires the anchor and hands back a scope bound to
 * that key (see `membership-ports.ts` on the coordination anchor).
 *
 * ## The stop is compensated in BOTH directions
 *
 * `runtimeHost.stop` is async and must not run inside a transaction, so it can
 * never be atomic with the row deletes. Instead of pretending otherwise, the
 * effect is idempotent and issued on both sides of the commit:
 *  - FORWARD drift (a conversation the member joined after the hint was taken):
 *    the recompute still deletes its row and still writes its audit message, and
 *    the post-commit pass issues `stop` for it — the authoritative set is what
 *    gets stopped, not the hint.
 *  - REVERSE drift (a conversation from the hint that somebody else already
 *    removed): the recomputed set is smaller, so no audit message and no publish
 *    are produced for it, and the pre-commit `stop` we already issued is a no-op
 *    against a session that is gone. A wasted stop is the cheap direction; a
 *    missing one would leave a live agent in a channel it was removed from.
 * Both passes swallow failures (logged): the durable removal is the commit, and a
 * runtime that cannot be reached must not fail the request. The post-commit pass
 * covers the whole authoritative set rather than just the drift delta — `stop` is
 * idempotent, so paying one no-op per conversation is how the window between the
 * hint's stop and the commit closes.
 *
 * ## HTTP-agnostic (spec §1.1/§4)
 *
 * Returns a typed {@link RemoveWorkspaceMemberResult}; the route maps kind →
 * status and runs the publish plan. `ownerRemovalUnsupported` is a DOMAIN answer,
 * not a duplicate of the route's own pre-check: the route's check is a snapshot,
 * this one is taken from the anchor, so a role change to `owner` racing a
 * removal cannot leave the workspace ownerless.
 */

export type RemoveWorkspaceMemberDeps = {
  persistence: MembershipPersistence;
  /**
   * Best-effort runtime stop, per conversation. Absent for a human removal —
   * humans run no process, so there is nothing to compensate for.
   */
  stopRuntime?: (conversationId: string, agentId: string) => Promise<void>;
  logger: BackendLogger;
};

export type RemoveWorkspaceMemberCommand = {
  workspaceId: string;
  /** Who acts (drives the audit sentence; actor === member marks a self-leave). */
  actor: ConversationMemberAddedActorSnapshot;
  /** Whose membership ends. Its `kind` + `id` ARE the member reference — the
   *  cascade has one idea of who is being removed, not two. */
  member: ConversationMemberAddedMemberSnapshot;
};

/** One removed conversation edge and the audit message that recorded it. The
 *  publish plan: the caller emits these AFTER the commit, so a rolled-back
 *  cascade cannot produce a phantom event. */
export type RemovedConversationPublish = {
  conversation: MembershipConversationRef;
  message: MessageDto;
};

export type RemoveWorkspaceMemberResult =
  | { kind: 'ownerRemovalUnsupported' }
  | { kind: 'removed'; removed: RemovedConversationPublish[] };

export async function removeWorkspaceMember(
  deps: RemoveWorkspaceMemberDeps,
  cmd: RemoveWorkspaceMemberCommand,
): Promise<RemoveWorkspaceMemberResult> {
  // Built by branch, not by copying `kind`: the member reference is a
  // discriminated union (#task:1987), because the member kind selects the
  // in-transaction capability set, not just a table.
  const member: WorkspaceMemberRef =
    cmd.member.kind === 'agent'
      ? { kind: 'agent', id: cmd.member.id }
      : { kind: 'human', id: cmd.member.id };

  // Pre-commit stop pass, over the NON-LOCKING hint. Best-effort by contract:
  // the authoritative pass runs after the commit.
  await stopAll(
    deps,
    member,
    deps.stopRuntime
      ? deps.persistence.read.listConversationsWithMember(cmd.workspaceId, member)
      : [],
  );

  const outcome = deps.persistence.uow.atomically(
    { workspaceId: cmd.workspaceId, member },
    (tx, anchor) => {
      // The owner can never be removed: a workspace always has an owner and
      // ownership transfer is unsupported. Read from the anchor the UnitOfWork
      // acquired, so it holds against a concurrent role change too.
      if (anchor?.role === 'owner') {
        return { kind: 'ownerRemovalUnsupported' } as const;
      }
      // A missing anchor is NOT a refusal: dangling conversation rows without a
      // workspace-membership row are exactly what this cleanup is for. The
      // recompute below decides whether there is anything to do.
      const targets = tx.membership.listConversationsWithMemberForUpdate();
      const removed: RemovedConversationPublish[] = [];
      for (const conversation of targets) {
        tx.membership.removeConversationMember(conversation.id);
        const message = tx.membership.insertMembershipAuditMessage({
          conversationId: conversation.id,
          content: conversationMemberRemovedContent({ actor: cmd.actor, member: cmd.member }),
          metadata: conversationMemberRemovedMetadata({ actor: cmd.actor, member: cmd.member }),
        });
        removed.push({ conversation, message });
      }
      tx.membership.removeWorkspaceMembership();
      return { kind: 'removed', removed } as const;
    },
  );

  if (outcome.kind !== 'removed') return outcome;

  // Post-commit compensation: the authoritative set is what gets stopped.
  await stopAll(
    deps,
    member,
    outcome.removed.map(entry => entry.conversation),
  );
  return outcome;
}

/**
 * Purge a workspace-membership row whose subject AGENT no longer exists
 * (#task:1987).
 *
 * A separate entry point rather than an arm of {@link removeWorkspaceMember}
 * because there is no agent left to name: the cascade above needs a member
 * snapshot to write its audit sentences, and a deleted agent has none. What is
 * left is one idempotent DELETE of a row that references nothing.
 *
 * It takes NO in-lock authority re-derivation, and that is not an omission: the
 * only write is the removal of a row whose subject is already gone, so there is
 * no state a concurrent role change could make wrong — every serial order ends
 * with the row absent. It goes through the UnitOfWork anyway so that the
 * membership tables have exactly one writer; a route holding a repo would be a
 * second one.
 *
 * Effectively unreachable in a live install: `workspace_members.agent_id`
 * carries `REFERENCES agents(id) ON DELETE CASCADE` and `db.ts` opens every
 * connection with `foreign_keys = ON`, so deleting an agent already takes its
 * membership rows. It stays as a repair path for rows predating that
 * constraint, and it is cheap: one statement, no reads.
 */
export function purgeDanglingWorkspaceAgentMembership(
  persistence: MembershipPersistence,
  input: { workspaceId: string; agentId: string },
): void {
  persistence.uow.atomically(
    { workspaceId: input.workspaceId, member: { kind: 'agent', id: input.agentId } },
    tx => tx.membership.removeWorkspaceMembership(),
  );
}

async function stopAll(
  deps: RemoveWorkspaceMemberDeps,
  member: WorkspaceMemberRef,
  conversations: readonly MembershipConversationRef[],
): Promise<void> {
  const stop = deps.stopRuntime;
  if (!stop || member.kind !== 'agent') return;
  for (const conversation of conversations) {
    await stop(conversation.id, member.id).catch(err =>
      deps.logger.warn(
        { conversationId: conversation.id, agentId: member.id, err },
        'workspace member remove: stop failed',
      ),
    );
  }
}
