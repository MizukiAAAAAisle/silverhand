/**
 * In-lock revalidation for membership writes (#task:1987) — the shared mechanism
 * by which a use case that is about to WRITE re-derives its authorization from
 * facts read under the coordination mechanism, instead of trusting a boolean
 * captured before the lock.
 *
 * It lives in its own module because there are now membership writers on two
 * axes — a conversation roster (`conversation-member.ts`) and a workspace roster
 * (`add-workspace-human-member.ts`) — and both must answer the same question the
 * same way. The two readers below differ ONLY in whether a conversation floor
 * applies; making that difference explicit is the point.
 *
 * Everything here is PURE with respect to persistence: it reads through
 * {@link MembershipAuthorityTxPort} and returns facts. Which rule consults which
 * fact, and what it concludes, stays in each use case.
 */
import type { WorkspaceRoleDto } from '@silverhand/shared';
import type { Principal } from '../auth/principal.js';
import { roleGovernsWorkspace } from '../auth/workspace-role.js';
import type { MembershipAuthorityTxPort } from './membership-ports.js';

/**
 * A decision that has been INVALIDATED by what the transaction sees. Every gate on
 * these paths runs before `atomically` on purpose — a refusal should not take a
 * write lock — so its inputs may be stale by the time the mechanism is held. When
 * the in-lock re-derivation disagrees, the request must refuse instead of writing.
 *
 * Thrown rather than returned so ROLLBACK is the refusal mechanism: no later edit to
 * a callback can leave a half-applied enrollment or a lone audit message committed
 * by putting a write above the check.
 */
export class MembershipRevalidationRefusal<E> extends Error {
  constructor(readonly refusal: E) {
    super('membership revalidation refusal');
  }
}

/**
 * Recover the refusal a callback threw, or rethrow a genuine error.
 *
 * Deliberately NOT a wrapper around `uow.atomically` — one shared runner would make
 * the enclosing use case invisible as the OWNER of its atomic boundary and hide the
 * callback body from the transaction-boundary gate (which refuses a non-inline
 * callback by design). So each use case keeps its own `atomically` call with an
 * inline callback, and shares only this mapping. The cast is sound by construction:
 * the class above is the only thing this repo throws as a refusal, and each call
 * site's callback throws its OWN `E`.
 */
export function refusalOrRethrow<E>(err: unknown): E {
  if (err instanceof MembershipRevalidationRefusal) return err.refusal as E;
  throw err;
}

/**
 * The WORKSPACE half of every roster-write authorization: the actor's role and
 * whether it governs. This is the whole authority for a write to the workspace
 * roster itself, and the first half of a conversation-roster write (see
 * {@link readActorAuthority}).
 */
export type InLockWorkspaceAuthority = {
  /** The actor's authoritative workspace role — also the input to the rank guard.
   *  `null` for agent and system principals, exactly as `workspaceRole` returns. */
  role: WorkspaceRoleDto | null;
  /** `canGovernWorkspace(…, 'admin')` on the same fact. */
  governs: boolean;
};

export function readWorkspaceAuthority(
  authority: MembershipAuthorityTxPort,
  principal: Principal,
): InLockWorkspaceAuthority {
  // `system` passes every `canX` gate; an agent principal holds no workspace
  // governance role at all. Both mirror `workspaceRole` / `canGovernWorkspace`.
  if (principal.kind === 'system') return { role: null, governs: true };
  if (principal.kind === 'agent') return { role: null, governs: false };
  const role = authority.humanWorkspaceRole(principal.userId);
  return {
    role,
    // `owner`/`admin` outrank `member`. A `null` role is not workspace membership
    // either, so it fails this and any floor built on it. Same rule object the
    // pre-lock `canGovernWorkspace` gate applies — one home for the role axis.
    governs: roleGovernsWorkspace(role),
  };
}

/**
 * The MUTABLE half of every CONVERSATION-roster authorization, re-derived from facts
 * read inside the coordinated transaction. The immutable half (an agent's creator,
 * the actor's own identity, the conversation's kind) is carried in by the caller — a
 * roster write cannot invalidate it.
 *
 * `inConversation` is the visibility FLOOR (`canViewConversation`), reproduced fact
 * for fact: a human needs a workspace role row AND a channel edge, an agent needs
 * its channel edge (its principal is already pinned to this conversation, which no
 * concurrent write can change), and `system` passes as it does in every `canX`.
 */
export type InLockActorAuthority = InLockWorkspaceAuthority & {
  inConversation: boolean;
};

export function readActorAuthority(
  authority: MembershipAuthorityTxPort,
  principal: Principal,
  conversationId: string,
): InLockActorAuthority {
  const workspace = readWorkspaceAuthority(authority, principal);
  if (principal.kind === 'system') return { ...workspace, inConversation: true };
  if (principal.kind === 'agent') {
    return {
      ...workspace,
      inConversation: authority.isConversationMember(conversationId, {
        kind: 'agent',
        id: principal.agentId,
      }),
    };
  }
  return {
    ...workspace,
    // A role row IS workspace membership, so its absence fails the workspace half
    // of the floor even while a stale conversation edge survives.
    inConversation:
      workspace.role !== null
      && authority.isConversationMember(conversationId, {
        kind: 'user',
        id: principal.userId,
      }),
  };
}
