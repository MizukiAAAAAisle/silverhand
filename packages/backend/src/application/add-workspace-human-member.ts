/**
 * AddWorkspaceHumanMember use case (#task:1987).
 *
 * Extracted from the route body, which read `isUserMember` BEFORE the write and
 * let that pre-lock boolean decide whether a `viewer_workspaces_changed` event
 * was emitted. Two concurrent adds of the same person could therefore both see
 * "not a member" and both announce an enrollment, and — worse — the actor's
 * `admin` role was sampled once by the route gate and never re-checked, so a
 * demotion committing in the seam still enrolled someone.
 *
 * Both are the same defect: a decision taken outside the coordination mechanism
 * driving a write (and an outward event) inside it. So this path now:
 *
 *  - coordinates on `(workspace, target human)` — the SAME key the removal
 *    cascade takes, so an add cannot interleave with the cascade that removes
 *    that person's conversation edges;
 *  - re-derives the actor's governance from the role row read INSIDE the lock
 *    and refuses by rollback if it no longer governs;
 *  - takes `created` from the ANCHOR (the target's membership as of the lock),
 *    never from a pre-lock read, so exactly one of two racing adds announces the
 *    enrollment.
 *
 * The workspace-roster write is the whole transaction: one idempotent
 * `INSERT OR IGNORE`. It is coordinated anyway because the event and the
 * authority check hang off it — a lone idempotent statement needs no lock, but
 * "who may write this, and who gets told" does.
 */
import type { UserDto, WorkspaceUserMemberDto } from '@silverhand/shared';
import type { Principal } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { MembershipPersistence } from './membership-ports.js';
import {
  MembershipRevalidationRefusal,
  readWorkspaceAuthority,
  refusalOrRethrow,
} from './membership-revalidation.js';
import { runPostCommitEffects } from './post-commit.js';
import { publishViewerWorkspacesChanged } from './viewer-workspaces.js';

export type AddWorkspaceHumanMemberError = { code: 'forbidden' };

export type AddWorkspaceHumanMemberResult =
  | { ok: true; member: WorkspaceUserMemberDto }
  | { ok: false; error: AddWorkspaceHumanMemberError };

export async function addWorkspaceHumanMember(
  deps: {
    ctx: BackendContext;
    membershipPersistence: MembershipPersistence;
  },
  input: {
    /** WHO is enrolling. The people roster is `admin` governance; that fact is
     *  re-read inside the lock below, not trusted from the route's gate. */
    principal: Principal;
    workspaceId: string;
    /** The person being enrolled — resolved by the caller, since "does this user
     *  exist" is a 404 that must not take a write lock. */
    user: UserDto;
  },
): Promise<AddWorkspaceHumanMemberResult> {
  let outcome: { member: WorkspaceUserMemberDto; created: boolean };
  try {
    outcome = deps.membershipPersistence.uow.atomically(
      { workspaceId: input.workspaceId, member: { kind: 'human', id: input.user.id } },
      (tx, anchor) => {
        // Re-derive the ACTOR's authority from the role row as of the lock. The
        // route's `canGovernWorkspace(…, 'admin')` gate stays where it is — it
        // refuses without taking a write lock — but it cannot be the authority
        // for the write, because a demotion or removal may commit in the seam.
        if (!readWorkspaceAuthority(tx.authority, input.principal).governs) {
          throw new MembershipRevalidationRefusal<AddWorkspaceHumanMemberError>({
            code: 'forbidden',
          });
        }
        // The anchor is the TARGET's membership under the lock, so it — and only
        // it — answers "did this request enroll them". The write itself is
        // unconditional and idempotent: an existing member keeps their role
        // (including `owner`), which is why the DTO comes back from the write
        // rather than from the anchor.
        return { member: tx.membership.addWorkspaceMembership(), created: anchor === null };
      },
    );
  } catch (err) {
    return { ok: false, error: refusalOrRethrow<AddWorkspaceHumanMemberError>(err) };
  }

  // Post-commit, and only for a genuine enrollment: a rolled-back transaction
  // must not tell a viewer they gained a workspace, and a re-add must not
  // re-announce one they already had.
  if (outcome.created) {
    await runPostCommitEffects(
      [
        () =>
          publishViewerWorkspacesChanged(deps.ctx, input.user.id, {
            change: 'added',
            workspace_id: input.workspaceId,
            role: outcome.member.role,
          }),
      ],
      deps.ctx.logger,
    );
  }
  return { ok: true, member: outcome.member };
}
