import {
  type AddConversationMemberInput,
  type ChannelDetailResponse,
  type ChannelLeaveBlockedReason,
  type ChannelLikeDto,
  type ConversationKind,
  type ConversationVisibility,
  type MemberRemovabilityDto,
  type MessageDto,
  type WorkspaceRoleDto,
  type WorkspaceUserMemberDto,
  normalizeHandle,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MembershipService } from '../services/membership-service.js';
import type {
  AgentMembershipTxPort,
  HumanMembershipTxPort,
  HumanMembershipTxScope,
  MembershipAuthorityTxPort,
  MembershipChannelExitFacts,
  MembershipPersistence,
  WorkspaceMembershipAnchor,
} from './membership-ports.js';
import {
  canAddConversationMember,
  canEditAgent,
  canEnrollAgent,
  canGovernWorkspace,
  canJoinPublicChannel,
  canViewConversation,
  userWorkspaceRole,
  workspaceRole,
} from '../permissions.js';
import { workspaceRoleOutranks } from '../auth/workspace-role.js';
import { enrollAgentIntoWorkspace } from './add-workspace-agent-member.js';
import {
  MembershipRevalidationRefusal,
  readActorAuthority,
  refusalOrRethrow,
} from './membership-revalidation.js';
import {
  type ConversationMemberAddedActorSnapshot,
  conversationMemberAddedAgentSnapshot,
  conversationMemberAddedContent,
  conversationMemberAddedHumanSnapshot,
  conversationMemberAddedMetadata,
  conversationMemberRemovedContent,
  conversationMemberRemovedMetadata,
} from './conversation-member-audit.js';
import { type PostCommitEffect, runPostCommitEffects } from './post-commit.js';
import { publishViewerWorkspacesChanged } from './viewer-workspaces.js';

/**
 * Add a member (agent or human) to a channel/thread conversation
 * (`docs/use-case-layer-p0-spec.md` §3).
 *
 * This use case owns the orchestration that previously lived in a ~150-line
 * route helper bound to Hono's `Context`. It is HTTP-agnostic: it returns a
 * typed {@link AddConversationMemberResult} and the route maps it to status
 * codes. Authorization is part of the application boundary (spec §3,
 * constraint ①) — the route passes a `Principal`, this resolves the target
 * and runs the auth policy, returning `forbidden`. External effects (event
 * publishes) are collected during the DB transaction and drained AFTER commit
 * (spec §2/§5) so a rolled-back insert never emits a phantom event.
 */
export type HandleCandidate = {
  kind: 'agent' | 'human';
  id: string;
  display_name: string;
  handle: string;
};

export type AddConversationMemberError =
  | { code: 'conversation_not_found' }
  | { code: 'conversation_member_add_unsupported' }
  | { code: 'conversation_closed' }
  | { code: 'forbidden' }
  | { code: 'candidate_not_found'; message: string }
  | { code: 'workspace_membership_required'; message: string }
  /**
   * #task:1681 — the candidate agent would have to be enrolled into the
   * workspace first, and only its creator may do that. Distinct from
   * `forbidden` (which is about the CALLER's conversation/workspace role) —
   * here the caller's roster authority is fine; the agent isn't theirs.
   *
   * #task:1683 widened it to the CHANNEL roster too: a plain channel member may
   * add their own agents, so reaching for someone else's agent is again an
   * ownership refusal, not a role one — even when that agent is already in the
   * workspace and no enrollment would happen.
   */
  | { code: 'agent_not_owned' }
  | { code: 'handle_ambiguous'; candidates: HandleCandidate[] };

export type AddConversationMemberResult =
  | { ok: true; members: ReturnType<MembershipService['listMembers']> }
  | { ok: false; error: AddConversationMemberError };

export type AddConversationMemberDeps = {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  membershipPersistence: MembershipPersistence;
  membership: MembershipService;
};

/**
 * The membership-transition write-core for "an existing workspace human enters
 * a channel", SHARED by {@link addConversationMember}'s human leg and
 * {@link joinPublicChannel} so the join invariants live in ONE place and cannot
 * drift into two models. The CALLER owns the enclosing DB transaction and any
 * post-commit effects — this does only the membership writes.
 *
 * Returns whether this call was the FRESH ENTRY, and does nothing beyond the
 * idempotent edge insert when it was not. That answer comes from the port's
 * in-lock `created`, which is why it lives here rather than in the callers: the
 * read baseline uses `markRead` (monotonic max), which never regresses but WOULD
 * advance the cursor past new messages if re-run on an existing member. Under a
 * caller-side `alreadyMember` guard that silent cursor bug was one stale read
 * away; now it is unexpressible.
 *
 * `announce` runs after the edge insert and BEFORE the read baseline, and only on
 * a fresh entry. That slot is the load-bearing ordering, not a convenience: the
 * baseline seeds each stream to its CURRENT head, so a caller's visible
 * "X added you" message must already be on the mainline or the new member would
 * see it as unread (#task:1404). Self-join announces nothing and omits it.
 *
 * Writes:
 *  1. the `conversation_users` edge (`addUser` = INSERT OR IGNORE);
 *  2. an insert-only `mentions` attention preference — a human pulled into an
 *     existing channel does NOT inherit the noisy `all` default (initial members
 *     keep the default; a later entrant is mention-only). Insert-only keeps a
 *     prior explicit choice across remove-then-re-add;
 *  3. a per-stream read baseline: the mainline AND every existing thread head
 *     seeded to that stream's CURRENT head, so pre-join history is not unread
 *     (#task:1404). Mainline alone is insufficient — the thread-chip read model
 *     (`streamUnreadForConversation`) is follow-agnostic, so a member with no
 *     thread cursors would see pre-join thread replies as `+n new`. markRead is
 *     monotonic max(), so remove-then-re-add advances to the re-join head.
 *
 * Takes the HUMAN membership scope, not a set of repos (#task:1987): the viewer
 * is the coordinated member of the enclosing `atomically`, so this write-core
 * cannot be pointed at anybody else and holds no DB handle.
 */
function enterChannelAsHuman(
  tx: HumanMembershipTxPort,
  conversationId: string,
  announce?: () => void,
): boolean {
  const { created } = tx.addConversationMember(conversationId);
  if (!created) return false;
  announce?.();
  tx.insertAttentionPreferenceIfAbsent({ conversationId, mode: 'mentions' });
  for (const head of tx.listStreamHeads(conversationId)) {
    tx.markStreamRead({
      conversationId,
      threadRootId: head.threadRootId,
      seq: head.latestSeq,
    });
  }
  return true;
}

/**
 * Re-derive the whole ADD authorization inside the lock, and return the refusal that
 * an ABSENT anchor must produce for this actor.
 *
 * Shaped as "the enrollment refusal" rather than a boolean because the pre-lock gates
 * are a two-stage refusal (`workspace_membership_required` for a principal whose
 * enrollment path can never run, `agent_not_owned` for one that can but does not own
 * the agent), and the in-lock re-derivation must answer with the SAME code the
 * pre-lock path would have. Whether the enrollment happens at all is the anchor's
 * call, so this cannot decide it — only what to say when it is needed.
 */
function authorizeAddInsideLock(
  authority: MembershipAuthorityTxPort,
  input: {
    principal: Principal;
    conversationId: string;
    target: { kind: 'agent'; ownedByActor: boolean } | { kind: 'human' };
  },
): { enrollmentRefusal: AddConversationMemberError | null } {
  const refuse = (error: AddConversationMemberError): never => {
    throw new MembershipRevalidationRefusal<AddConversationMemberError>(error);
  };
  const actor = readActorAuthority(authority, input.principal, input.conversationId);
  // Stage 1 — the floor. An actor removed from the channel between the gate and the
  // lock may not write its roster, and neither may one whose workspace role is gone.
  if (!actor.inConversation) refuse({ code: 'forbidden' });
  // Stage 2 — target-graded, for a non-admin human: the people roster and other
  // people's agents stay governance; your OWN agents do not.
  if (input.principal.kind === 'user' && !actor.governs) {
    if (input.target.kind === 'human') refuse({ code: 'forbidden' });
    else if (!input.target.ownedByActor) refuse({ code: 'agent_not_owned' });
  }
  if (input.principal.kind !== 'user') {
    // Non-human principals never auto-provision — the target must already be a
    // workspace member — so for them an absent anchor is always this refusal,
    // whichever kind the target is.
    return {
      enrollmentRefusal: {
        code: 'workspace_membership_required',
        message:
          input.target.kind === 'agent'
            ? 'agent is not a member of this workspace'
            : 'user is not a member of this workspace',
      },
    };
  }
  if (input.target.kind === 'human') {
    // A non-admin human was refused by stage 2 above, so reaching here means the
    // actor governs the workspace and may enroll people.
    return { enrollmentRefusal: null };
  }
  // Enrollment authority for an AGENT target is creator-only: not even an admin
  // enrolls someone else's agent (#task:1681). An admin adding a NON-owned agent is
  // still fine when it is already a workspace member — that is the anchor's call,
  // which is why this refusal is returned rather than thrown.
  return {
    enrollmentRefusal: input.target.ownedByActor ? null : { code: 'agent_not_owned' },
  };
}

export async function addConversationMember(
  deps: AddConversationMemberDeps,
  input: {
    conversationId: string;
    principal: Principal;
    member: AddConversationMemberInput;
  },
): Promise<AddConversationMemberResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation) return { ok: false, error: { code: 'conversation_not_found' } };
  if (conversation.kind !== 'channel') {
    return { ok: false, error: { code: 'conversation_member_add_unsupported' } };
  }
  if (conversation.closed_at !== null) {
    return { ok: false, error: { code: 'conversation_closed' } };
  }

  // Authorization (spec §3, constraint ①), in TWO stages, because the second
  // one is a property of the TARGET and the target may still be an unresolved
  // handle here.
  //
  // Stage 1 — the FLOOR, target-independent: the caller must be a member of
  // THIS conversation (`canAddConversationMember` = `canViewConversation`).
  // This is what keeps a private channel private: no role and no agent of
  // yours gets you a roster write on a channel you are not in, so
  // own-agent-add can never be used to gain or spread channel access
  // (#task:1683). Agent/system: the agent route's
  // `manage_conversation_members` capability gate already ran before the
  // request entered this use case; the floor is the same membership check.
  if (!canAddConversationMember(deps.ctx, input.principal, conversation.id)) {
    return { ok: false, error: { code: 'forbidden' } };
  }

  const isWorkspaceAdmin = canGovernWorkspace(
    deps.ctx,
    input.principal,
    conversation.workspace_id,
    'admin',
  );
  const callerIsHuman = input.principal.kind === 'user';

  // WORKSPACE-side auto-provision (a target that is not in the workspace yet).
  //
  // For a HUMAN target this predicate IS the authority: an admin genuinely may
  // enroll people, so `canAutoProvisionHumanMember` means what it says.
  //
  // For an AGENT target there is deliberately NO such predicate here, because
  // this use case does not hold enrollment authority — `canEnrollAgent` is the
  // authority (creator-only, #task:1681: not even an admin enrolls someone
  // else's agent), applied on the auto-provision branch below. What we decide
  // here is only ROUTING: whether to walk the enrollment path and let that gate
  // answer with its own typed refusal, or to stop with
  // `workspace_membership_required` because that path can never run for this
  // principal at all. Hence the name — an admin gets `true` and may still be
  // refused with `agent_not_owned` one gate later; that is a two-stage refusal,
  // not a permission. Non-human principals keep the old posture (they never
  // auto-provision — the target must already be a workspace member).
  const canAutoProvisionHumanMember = callerIsHuman && isWorkspaceAdmin;
  const mayAttemptAgentEnrollment = (agentId: string): boolean =>
    callerIsHuman && (isWorkspaceAdmin || canEnrollAgent(deps.ctx, input.principal, agentId));

  const resolved = resolveConversationMemberInput(deps, {
    workspaceId: conversation.workspace_id,
    member: input.member,
    mayAttemptNonWorkspaceCandidate: candidate =>
      candidate.kind === 'agent'
        ? mayAttemptAgentEnrollment(candidate.id)
        : canAutoProvisionHumanMember,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // Stage 2 — now that the target IS known: for a NON-admin human, the channel
  // roster write is graded by the target's kind and, for an agent, by its
  // OWNERSHIP (#task:1683, shiki 2026-07-28). A plain channel member may bring
  // their OWN agents in; the people roster and other people's agents stay
  // `admin` governance. The two factors stay independent — this never widens the
  // membership floor above (owning an agent buys no access to a channel you are
  // not in), and no role substitutes for ownership. Non-human principals keep
  // their pre-existing posture (capability gate at the route + the floor).
  // Runs BEFORE any write, daemon seed or workspace row, so a refusal leaves
  // nothing behind.
  if (callerIsHuman && !isWorkspaceAdmin) {
    if (resolved.member.kind === 'human') {
      return { ok: false, error: { code: 'forbidden' } };
    }
    if (!canEnrollAgent(deps.ctx, input.principal, resolved.member.agent_id)) {
      return { ok: false, error: { code: 'agent_not_owned' } };
    }
  }

  const effects: PostCommitEffect[] = [];

  if (resolved.member.kind === 'agent') {
    const agent = deps.agents.get(resolved.member.agent_id);
    if (!agent) {
      return { ok: false, error: { code: 'candidate_not_found', message: 'agent not found' } };
    }
    const workspaceWasMember = deps.workspaces.isMember(conversation.workspace_id, agent.id);
    if (!workspaceWasMember) {
      // Not "you are allowed to enroll" — only "the enrollment path can run for
      // this principal". The gate below owns the real answer and refuses anyone
      // but the creator, admin included.
      if (!mayAttemptAgentEnrollment(agent.id)) {
        return {
          ok: false,
          error: {
            code: 'workspace_membership_required',
            message: 'agent is not a member of this workspace',
          },
        };
      }
      if (!deps.workspaces.get(conversation.workspace_id)) {
        throw new Error(`conversation ${conversation.id} references missing workspace ${conversation.workspace_id}`);
      }
      // #task:1681 — this door auto-provisions WORKSPACE membership, so it is
      // bound by the same enrollment authority as the workspace member-add
      // route: a workspace admin may not pull a teammate's agent in. An agent
      // already in the workspace is unaffected (the gate only runs on the
      // auto-provision branch). It is the same gate `addWorkspaceAgentMember`
      // applies; only the WRITE moved, into the single transaction below.
      if (!canEnrollAgent(deps.ctx, input.principal, agent.id)) {
        return { ok: false, error: { code: 'agent_not_owned' } };
      }
    }
    // The IMMUTABLE half of the enrollment authority: who created this agent. A
    // roster write cannot change it, so unlike the role and membership facts it is
    // safe to carry into the transaction (#task:1681 — creator-only, admin included).
    const ownedByActor = canEnrollAgent(deps.ctx, input.principal, agent.id);
    const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
    const memberSnap = conversationMemberAddedAgentSnapshot(agent);
    // ONE keyed commit for the whole enrollment (#task:1987): the workspace
    // row, the capability seed, the conversation edge and the audit message.
    // Before this, the workspace enrollment committed on its own and a
    // failure of the second transaction left the agent enrolled in a
    // workspace it had joined no channel of.
    //
    // Every write below is decided INSIDE the lock — by the re-derived authority,
    // the ANCHOR and the port's in-lock `created` — never by the reads above: those
    // ran before the lock, so a removal or a demotion landing in between would
    // otherwise write a conversation row for a non-member, enroll without placing,
    // or complete a roster write its actor no longer has the authority for.
    let message: MessageDto | null;
    try {
      message = deps.membershipPersistence.uow.atomically(
        { workspaceId: conversation.workspace_id, member: { kind: 'agent', id: agent.id } },
        (tx, anchor) => {
          const { enrollmentRefusal } = authorizeAddInsideLock(tx.authority, {
            principal: input.principal,
            conversationId: conversation.id,
            target: { kind: 'agent', ownedByActor },
          });
          if (anchor === null) {
            if (enrollmentRefusal) {
              throw new MembershipRevalidationRefusal<AddConversationMemberError>(enrollmentRefusal);
            }
            enrollAgentIntoWorkspace(tx.membership);
          }
          if (!tx.membership.addConversationMember(conversation.id).created) return null;
          return tx.membership.insertMembershipAuditMessage({
            conversationId: conversation.id,
            content: conversationMemberAddedContent({ actor, member: memberSnap }),
            metadata: conversationMemberAddedMetadata({ actor, member: memberSnap }),
          });
        },
      );
    } catch (err) {
      return { ok: false, error: refusalOrRethrow<AddConversationMemberError>(err) };
    }
    if (message) {
      const added = message;
      effects.push(() => publishMemberAdded(deps.ctx, deps.conversations, conversation, added));
    }
    await runPostCommitEffects(effects, deps.ctx.logger);
    return { ok: true, members: deps.membership.listMembers(conversation.id) };
  }

  const user = deps.ctx.userService.getDto(resolved.member.user_id);
  if (!user) {
    return { ok: false, error: { code: 'candidate_not_found', message: 'user not found' } };
  }
  const workspaceWasMember = deps.workspaces.isUserMember(conversation.workspace_id, user.id);
  if (!workspaceWasMember && !canAutoProvisionHumanMember) {
    return {
      ok: false,
      error: {
        code: 'workspace_membership_required',
        message: 'user is not a member of this workspace',
      },
    };
  }
  const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
  const memberSnap = conversationMemberAddedHumanSnapshot(user);
  // Same shape as the agent arm above: the pre-lock reads refuse early, and every
  // write is decided inside the lock — the caller's authority by the in-lock
  // authority projection, the workspace enrollment by the ANCHOR, the edge and the
  // audit message by the port's in-lock `created`.
  let write: { workspaceMember: WorkspaceUserMemberDto | null; message: MessageDto | null };
  try {
    write = deps.membershipPersistence.uow.atomically(
      { workspaceId: conversation.workspace_id, member: { kind: 'human', id: user.id } },
      (tx, anchor) => {
        const { enrollmentRefusal } = authorizeAddInsideLock(tx.authority, {
          principal: input.principal,
          conversationId: conversation.id,
          target: { kind: 'human' },
        });
        let workspaceMember: WorkspaceUserMemberDto | null = null;
        if (anchor === null) {
          if (enrollmentRefusal) {
            throw new MembershipRevalidationRefusal<AddConversationMemberError>(enrollmentRefusal);
          }
          workspaceMember = tx.membership.addWorkspaceMembership();
        }
        let message: MessageDto | null = null;
        // The visible member-added message is admin-add-specific and stays HERE
        // in the caller; the write-core owns the edge + attention-pref + read
        // baseline and the slot this runs in, so the "message before baseline"
        // ordering it depends on cannot be got wrong from here.
        enterChannelAsHuman(tx.membership, conversation.id, () => {
          message = tx.membership.insertMembershipAuditMessage({
            conversationId: conversation.id,
            content: conversationMemberAddedContent({ actor, member: memberSnap }),
            metadata: conversationMemberAddedMetadata({ actor, member: memberSnap }),
          });
        });
        return { workspaceMember, message };
      },
    );
  } catch (err) {
    return { ok: false, error: refusalOrRethrow<AddConversationMemberError>(err) };
  }
  const workspaceMember = write.workspaceMember;
  if (workspaceMember) {
    effects.push(() =>
      publishViewerWorkspacesChanged(deps.ctx, user.id, {
        change: 'added',
        workspace_id: conversation.workspace_id,
        role: workspaceMember.role,
      }),
    );
  }
  const message = write.message;
  if (message) {
    effects.push(() => publishMemberAdded(deps.ctx, deps.conversations, conversation, message));
  }
  await runPostCommitEffects(effects, deps.ctx.logger);
  return { ok: true, members: deps.membership.listMembers(conversation.id) };
}

/**
 * Universe alignment (design doc §5.2): a membership system message bumps
 * the conversation's main stream head, so EVERY agent member needs a
 * normal inbox delivery to advance past it — under the signal-only stale
 * contract, a head-bump without a delivery would leave agents 409-blocked
 * on a row that never arrives. Same shape as the rename/task-notice
 * fan-outs; best-effort per agent (a failed leg leaves that row pending
 * for the next drain, it never blocks the mutation).
 */
function deliverSystemMessageToConversationAgents(
  ctx: BackendContext,
  conversations: ConversationRepo,
  conversationId: string,
  messageId: string,
): void {
  for (const ca of conversations.listAgents(conversationId)) {
    void ctx.runtimeHost
      .deliverMessage(conversationId, ca.agent_id, messageId)
      .catch(err => {
        ctx.logger.warn(
          { conversationId, agentId: ca.agent_id, messageId, err },
          'membership notice delivery failed; row stays pending',
        );
      });
  }
}

/**
 * Post-commit publish for a member-added system message. Order is preserved
 * verbatim from the original route helper (spec §7 ruling ⑥): `message` →
 * `conversation_members_changed` → `workspace_channels_changed`.
 */
function publishMemberAdded(
  ctx: BackendContext,
  conversations: ConversationRepo,
  conversation: { id: string; workspace_id: string },
  message: MessageDto,
): void {
  ctx.events.publish(conversation.id, { kind: 'message', payload: { message } });
  deliverSystemMessageToConversationAgents(ctx, conversations, conversation.id, message.id);
  ctx.events.publishSide(conversation.id, {
    kind: 'conversation_members_changed',
    payload: {
      conversation_id: conversation.id,
      workspace_id: conversation.workspace_id,
    },
  });
  ctx.events.publishToScope(
    `workspace:${conversation.workspace_id}`,
    'workspace_channels_changed',
    {
      workspace_id: conversation.workspace_id,
      channel_id: conversation.id,
    },
  );
}

// ── joinPublicChannel ──

export type JoinPublicChannelDeps = {
  ctx: BackendContext;
  conversations: ConversationRepo;
  membershipPersistence: MembershipPersistence;
};

export type JoinPublicChannelError = { code: 'channel_not_found' } | { code: 'forbidden' };

export type JoinPublicChannelResult =
  | { ok: true }
  | { ok: false; error: JoinPublicChannelError };

/**
 * Self-join a PUBLIC channel — the ONLY non-member mutation the public model
 * allows: a workspace human pulls THEMSELVES into a public channel. The caller
 * is ALWAYS the joined member; the route takes no body, so there is no target
 * on the wire to forge.
 *
 * Admission (`canJoinPublicChannel`) is validated BEFORE any write, so an
 * existing member of a private / `dm_channel` / legacy thread / archived target
 * cannot get a success from `/join`. The membership transition itself runs through
 * the SHARED {@link enterChannelAsHuman} primitive (same-source with admin-add),
 * which also decides — in the transaction — whether this was a fresh join.
 *
 * The joiner's WORKSPACE membership is re-derived from the ANCHOR rather than from
 * that pre-lock gate: here the actor IS the member being written, so the anchor —
 * read under the coordination mechanism — is exactly the authority fact the gate
 * checked. If a cascade removes the workspace membership in the seam, joining anyway
 * would leave a channel edge (plus attention preference and read cursors) for a
 * non-member of the workspace, a state neither serial order reaches. The channel's
 * public/active SHAPE stays a pre-lock read on purpose: it is ordinary conversation
 * state, not membership, so last-writer-wins is the correct answer for it.
 *
 * Post-commit fires ONLY `conversation_members_changed` (roster) +
 * `workspace_channels_changed` (discovery/list): NO `viewer_workspaces_changed`
 * (the joiner was already a workspace member — joining a channel does not change
 * workspace membership) and NO system message (self-join has no "actor added
 * member" semantic to reuse, and v1 has no distinct joined message). Every effect
 * is gated by the write-core's in-lock `created`, so an idempotent retry is
 * zero-increment on the row, the attention preference, the read cursors, AND the
 * events.
 */
export async function joinPublicChannel(
  deps: JoinPublicChannelDeps,
  input: { conversationId: string; principal: Principal },
): Promise<JoinPublicChannelResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation) return { ok: false, error: { code: 'channel_not_found' } };
  // Public-target admission BEFORE already-member idempotency (a member of a
  // non-public target must not get success). Also rejects non-user principals.
  if (!canJoinPublicChannel(deps.ctx, input.principal, conversation.id)) {
    return { ok: false, error: { code: 'forbidden' } };
  }
  // canJoinPublicChannel guarantees `principal.kind === 'user'`.
  const userId = (input.principal as UserPrincipal).userId;
  // Self-join writes no workspace-membership row (the joiner is already a
  // workspace member) but it DOES write the same conversation-membership rows
  // a removal cascades over, so it coordinates on the same key.
  let joined: boolean;
  try {
    joined = deps.membershipPersistence.uow.atomically(
      { workspaceId: conversation.workspace_id, member: { kind: 'human', id: userId } },
      (tx, anchor) => {
        // An ABSENT anchor is the one case this path may NOT proceed on: unlike the
        // add path it has no enrollment authority to fall back on (a self-join never
        // enrolls anyone), so the only sound answer is the same refusal the pre-lock
        // gate would have given.
        if (anchor === null) {
          throw new MembershipRevalidationRefusal<JoinPublicChannelError>({ code: 'forbidden' });
        }
        return enterChannelAsHuman(tx.membership, conversation.id);
      },
    );
  } catch (err) {
    return { ok: false, error: refusalOrRethrow<JoinPublicChannelError>(err) };
  }
  if (joined) {
    await runPostCommitEffects(
      [() => publishSelfJoined(deps.ctx, conversation)],
      deps.ctx.logger,
    );
  }
  return { ok: true };
}

/**
 * Post-commit publish for a SELF-JOIN. Unlike {@link publishMemberAdded} there
 * is NO member-added system message (self-join has no actor-added-member
 * semantic) and NO `viewer_workspaces_changed` (workspace membership is
 * unchanged). Emits only the two invalidation signals a new channel membership
 * requires: `conversation_members_changed` (roster) + `workspace_channels_changed`
 * (the viewer's channel list / discovery) — the add path's event choice minus
 * the message.
 */
function publishSelfJoined(
  ctx: BackendContext,
  conversation: { id: string; workspace_id: string },
): void {
  ctx.events.publishSide(conversation.id, {
    kind: 'conversation_members_changed',
    payload: {
      conversation_id: conversation.id,
      workspace_id: conversation.workspace_id,
    },
  });
  ctx.events.publishToScope(
    `workspace:${conversation.workspace_id}`,
    'workspace_channels_changed',
    {
      workspace_id: conversation.workspace_id,
      channel_id: conversation.id,
    },
  );
}

// ── leaveChannel ──

export type LeaveChannelDeps = {
  ctx: BackendContext;
  conversations: ConversationRepo;
  membershipPersistence: MembershipPersistence;
};

export type LeaveChannelResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | { code: 'channel_not_found' }
        | { code: ChannelLeaveBlockedReason };
    };

/**
 * The four facts the exit rule branches on, as METHODS rather than a gathered
 * bundle. Two reasons, both load-bearing:
 *  - the rule short-circuits, and the per-member carrier
 *    ({@link buildConversationMemberRemovability}) evaluates it once per roster
 *    row, so eagerly gathering all four would turn today's cheap early exits into
 *    a per-row `listUsers` + role lookup;
 *  - the two sources answer from different places — repos before the lock, the
 *    membership port and the ANCHOR inside it — and only a lazy source lets the
 *    in-lock reader satisfy "one face, one point in the transaction".
 *
 * `isTargetWorkspaceOwner` is about the member being removed, never the actor.
 */
export interface ChannelMemberExitFactSource {
  /** The channel row, or `null` when the conversation no longer exists — read by
   *  the in-lock source as "there is no edge to end". */
  channel(): {
    kind: ConversationKind;
    visibility: ConversationVisibility;
    archived_at: number | null;
  } | null;
  isMember(): boolean;
  isTargetWorkspaceOwner(): boolean;
  humanMemberCount(): number;
}

/**
 * The SINGLE exit-eligibility rule for a human's `conversation_users` edge,
 * shared by every path that can end that membership: the {@link leaveChannel}
 * write (authoritative), the channel-detail `can_leave` carrier (advisory
 * display), and — since #task:1688 — third-party removal
 * ({@link evaluateChannelHumanMemberRemoval}) plus its per-member carrier.
 * Evaluated for the TARGET member, which for self-leave is the caller: whether
 * the edge may end does not depend on who asked, so the rule cannot fork into a
 * "leave" copy and a "remove" copy. It is a pure predicate over the member +
 * channel facts — returns `can_leave` plus the stable
 * {@link ChannelLeaveBlockedReason} when blocked (advisory ≠ correctness, but
 * same source — docs/architecture-principles.md §12.1#5).
 *
 * PURE over a {@link ChannelMemberExitFactSource} (#task:1987) so the two callers
 * that need it at different points in time run the SAME rule: the pre-lock gate /
 * advisory carriers read repos, and a path about to WRITE re-runs it on facts read
 * inside the coordinated transaction. `channel_owner` and `last_human_member`
 * protect a state no serial order of two legal exits can reach ("a private channel
 * with no human in it"), so a decision taken before the lock is not merely stale,
 * it is unsound — one rule, two fact sources is what makes the write path sound
 * without letting the display path drift.
 *
 * Ordered so the most specific block wins:
 *  1. `not_member` — there is no edge to end. For self-leave that is a 403
 *     (leave is member-only; idempotency must not outrank the permission
 *     model); for third-party removal the caller maps it to an idempotent
 *     no-op. The REASON is one fact; what it means for a verb is the caller's.
 *  2. `channel_archived` — v1 freezes archived channels; restore before leaving
 *     (an archived channel is deliberately NOT folded into the public 0-human
 *     exception).
 *  3. `channel_owner` — the workspace OWNER of a PRIVATE channel anchors the
 *     owner-bound governance chain; ending that edge would make the channel
 *     invisible to them (private + non-member) and sever the chain from the
 *     resource even with other humans present. Authoritative
 *     `workspace_users.role='owner'` — the model has NO per-channel creator, so
 *     this never guesses from row order / first member. Public channels are
 *     exempt (owner re-browses + re-joins freely).
 *  4. `last_human_member` — ending the last HUMAN edge of a PRIVATE channel
 *     would strand it (no human, incl. admins, can see or re-join a private
 *     channel). `conversation_users` IS the human-membership table, so its row
 *     count is the human count. Active PUBLIC channels are exempt (0 humans
 *     stays discoverable + joinable).
 *
 * "Every path" above means every path that ends a CHANNEL edge as its own unit
 * of work. Two WORKSPACE-level exits deliberately do NOT consult this rule and
 * are not violations of it: owner-driven human removal
 * (`DELETE …/members/users/:userId`) and self-leave
 * (`POST /api/workspaces/:id/leave`, #task:1930). Both are existential — the
 * human stops being a member of the workspace, so no channel of it can keep an
 * edge; deferring to a per-channel guard would let one private channel veto the
 * exit and lock a person into a workspace they left. That has a real price,
 * accepted deliberately (shiki 2026-08-09): a private channel whose last human
 * was the leaver is left stranded — exactly the outcome `last_human_member`
 * exists to prevent — because exit freedom outranks the recoverability of a
 * sub-resource. Add a new consulting path here, not a third exception.
 */
export function evaluateChannelMemberExit(
  source: ChannelMemberExitFactSource,
): { can_leave: boolean; reason: ChannelLeaveBlockedReason | null } {
  const channel = source.channel();
  if (channel === null || channel.kind !== 'channel') {
    return { can_leave: false, reason: 'not_member' };
  }
  if (!source.isMember()) {
    return { can_leave: false, reason: 'not_member' };
  }
  if (channel.archived_at !== null) {
    return { can_leave: false, reason: 'channel_archived' };
  }
  // Owner-bound governance guard (private only), checked ABOVE last_human_member
  // so the owner-specific reason wins when both apply.
  if (channel.visibility === 'private' && source.isTargetWorkspaceOwner()) {
    return { can_leave: false, reason: 'channel_owner' };
  }
  if (channel.visibility === 'private' && source.humanMemberCount() <= 1) {
    return { can_leave: false, reason: 'last_human_member' };
  }
  return { can_leave: true, reason: null };
}

/**
 * The REPO-backed fact source: the pre-lock gate and every advisory carrier. Safe
 * outside a transaction because a refusal it produces is only ever an early
 * reject — the authoritative answer comes from
 * {@link inLockChannelExitFactSource} under the coordination mechanism.
 */
export function evaluateChannelMemberExitEligibility(
  deps: { ctx: BackendContext; conversations: ConversationRepo },
  userId: string,
  conversation: {
    id: string;
    kind: ConversationKind;
    workspace_id: string;
    visibility: ConversationVisibility;
    archived_at: number | null;
  },
): { can_leave: boolean; reason: ChannelLeaveBlockedReason | null } {
  return evaluateChannelMemberExit({
    channel: () => conversation,
    isMember: () => deps.conversations.getUser(conversation.id, userId) !== null,
    isTargetWorkspaceOwner: () =>
      userWorkspaceRole(deps.ctx, conversation.workspace_id, userId) === 'owner',
    humanMemberCount: () => deps.conversations.listUsers(conversation.id).length,
  });
}

/**
 * The IN-LOCK fact source for the coordinated member: three facts from ONE
 * {@link HumanMembershipTxPort.readChannelExitFacts} call (memoized, so the rule's
 * short-circuit cannot make them come from three points in the transaction) plus
 * the target's workspace role from the ANCHOR — which the UnitOfWork read under
 * the same mechanism, so there is nothing left to read it from twice.
 */
function inLockChannelExitFactSource(
  membership: HumanMembershipTxPort,
  conversationId: string,
  anchor: WorkspaceMembershipAnchor | null,
): ChannelMemberExitFactSource {
  let facts: MembershipChannelExitFacts | null = null;
  const read = (): MembershipChannelExitFacts =>
    (facts ??= membership.readChannelExitFacts(conversationId));
  return {
    channel: () => read().channel,
    isMember: () => read().isMember,
    isTargetWorkspaceOwner: () => anchor?.role === 'owner',
    humanMemberCount: () => read().humanMemberCount,
  };
}

/**
 * Self-leave a channel — the symmetric counterpart of {@link joinPublicChannel}.
 * A human member removes THEMSELVES; the route takes no body, so there is no
 * target on the wire to forge. Eligibility runs through the shared
 * {@link evaluateChannelMemberExitEligibility} (evaluated for the caller, who IS
 * the target here) so the block reasons match the detail-carrier hint exactly.
 *
 * Teardown deletes ONLY the `conversation_users` edge — the read cursors and
 * attention preference are intentionally KEPT (the seed contract advances the
 * cursor to the re-join head via monotonic `markRead`, and the attention pref is
 * insert-only across remove-then-re-add). Membership-scoped projections
 * (unread rollup, favorites, Activity, restore/default-selection) all INNER-join
 * `conversation_users`, so the leaver drops out of them the instant the edge is
 * gone — no per-projection cleanup here (§12: one domain fact → the viewer-local
 * consumers converge on it).
 *
 * Post-commit fires the SAME two signals as self-join —
 * `conversation_members_changed` (roster) + `workspace_channels_changed`
 * (discovery/list) — and NO new event type, NO `viewer_workspaces_changed`
 * (workspace membership is unchanged), NO system message (v1 silent, mirroring
 * self-join). Which of the two a viewer still receives after their own edge is
 * gone differs, and a renderer-side visibility-loss cleanup should key off the
 * durable one: live delivery obeys the CURRENT `canSubscribeScope`
 * (#task:1690), so `conversation-side:<id>` stops reaching an ex-member from the
 * next frame on — including this very `conversation_members_changed`.
 * `workspace_channels_changed` rides the workspace scope, which membership loss
 * here does not touch, so it is the signal that still arrives. As of #task:1688
 * the same loss also reaches a client that did NOT initiate it
 * (`removeConversationHumanMember`), so a mutation-local `onSuccess` is no longer
 * the whole story; what the renderer covers is a renderer question, not a claim
 * this file can make.
 */
export async function leaveChannel(
  deps: LeaveChannelDeps,
  input: { conversationId: string; principal: UserPrincipal },
): Promise<LeaveChannelResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation || conversation.kind !== 'channel') {
    return { ok: false, error: { code: 'channel_not_found' } };
  }
  const eligibility = evaluateChannelMemberExitEligibility(
    { ctx: deps.ctx, conversations: deps.conversations },
    input.principal.userId,
    conversation,
  );
  if (!eligibility.can_leave) {
    // Early reject only — the authoritative evaluation is the in-lock one below.
    // reason is non-null whenever can_leave is false.
    return { ok: false, error: { code: eligibility.reason as ChannelLeaveBlockedReason } };
  }
  // Re-evaluated INSIDE the lock (#task:1987) on facts read under the mechanism,
  // because two of the reasons guard a state no serial order of two legal exits
  // reaches: if another human left this private channel in the seam above, the
  // caller is now the last one and must be refused, not let out. `removed` — also
  // decided under the lock — drives the effects, so an edge another request already
  // deleted produces no second leave signal.
  let removed: boolean;
  try {
    removed = deps.membershipPersistence.uow.atomically(
      { workspaceId: conversation.workspace_id, member: { kind: 'human', id: input.principal.userId } },
      (tx, anchor) => {
        const inLock = evaluateChannelMemberExit(
          inLockChannelExitFactSource(tx.membership, conversation.id, anchor),
        );
        if (!inLock.can_leave) {
          throw new MembershipRevalidationRefusal<ChannelLeaveBlockedReason>(
            inLock.reason as ChannelLeaveBlockedReason,
          );
        }
        return tx.membership.removeConversationMember(conversation.id).removed;
      },
    );
  } catch (err) {
    return { ok: false, error: { code: refusalOrRethrow<ChannelLeaveBlockedReason>(err) } };
  }
  if (removed) {
    await runPostCommitEffects(
      [() => publishSelfLeft(deps.ctx, conversation)],
      deps.ctx.logger,
    );
  }
  return { ok: true };
}

/**
 * Post-commit publish for a SELF-LEAVE. Identical event choice to
 * {@link publishSelfJoined} — the two channel-membership invalidation signals,
 * no system message, no `viewer_workspaces_changed`. Kept as a named sibling
 * (not a call to `publishSelfJoined`) so the leave semantics read at the call
 * site; the event set is deliberately the same domain fact ("this viewer's
 * channel membership changed").
 */
function publishSelfLeft(
  ctx: BackendContext,
  conversation: { id: string; workspace_id: string },
): void {
  ctx.events.publishSide(conversation.id, {
    kind: 'conversation_members_changed',
    payload: {
      conversation_id: conversation.id,
      workspace_id: conversation.workspace_id,
    },
  });
  ctx.events.publishToScope(
    `workspace:${conversation.workspace_id}`,
    'workspace_channels_changed',
    {
      workspace_id: conversation.workspace_id,
      channel_id: conversation.id,
    },
  );
}

/**
 * Build the `GET /api/channels/:id` detail envelope — the per-viewer channel
 * identity + capability carriers. SHARED by the detail route and the self-join
 * route so both return an IDENTICAL shape (the client backfills its cache
 * uniformly). All fields are viewer-scoped route projections, never on the
 * identity DTO:
 *  - `is_member` — authoritative membership (a public non-member reads `false`);
 *  - `can_leave` / `leave_blocked_reason` — from the shared leave evaluator;
 *  - `can_update_visibility` — workspace-admin governance on a regular channel
 *    (agents never govern), fail-closed.
 * These carriers are advisory display; the write paths remain authoritative
 * (§12.1#5 advisory ≠ correctness).
 */
export function buildChannelDetailResponse(
  ctx: BackendContext,
  conversations: ConversationRepo,
  principal: UserPrincipal,
  channel: ChannelLikeDto,
): ChannelDetailResponse {
  const leave = evaluateChannelMemberExitEligibility(
    { ctx, conversations },
    principal.userId,
    channel,
  );
  return {
    channel,
    is_member: conversations.getUser(channel.id, principal.userId) !== null,
    can_leave: leave.can_leave,
    leave_blocked_reason: leave.reason,
    can_update_visibility:
      channel.kind === 'channel'
      && canGovernWorkspace(ctx, principal, channel.workspace_id, 'admin'),
  };
}

// ── removeConversationMember (P6) ──
//
// The symmetric counterpart of addConversationMember: remove an agent from a
// channel/thread. Previously the route helper `removeConversationAgentMember`
// (routes/membership.ts) which took a Hono `Context` and returned a `Response`.
// This use case is HTTP-agnostic — it returns a typed RemoveConversationMemberResult
// and the route maps it to status/body.
//
// Authorization (view → govern-admin OR edit-agent, with the anti-enumeration
// branch for a missing agent) lives in the use case (spec §3.2 / #957 semantics,
// preserved verbatim). The pre-commit `runtimeHost.stop` is best-effort and
// stays AWAITED before the DB transaction (spec §2.1: success blocks the
// response until stop settles; failure is caught and we continue). The
// `removeAgent` + removed-system-message single transaction and the post-commit
// publish (message → conversation_members_changed → workspace_channels_changed)
// are preserved; the publish runs as a post-commit effect aligned with the add
// path (a throwing effect logs and continues, vs the old direct-call throw).

export type RemoveConversationMemberDeps = {
  ctx: BackendContext;
  agents: AgentRepo;
  // `users` is needed only to render a human actor's name in the removed-system
  // message via conversationMemberAddedActorSnapshot — dropping it would degrade
  // the actor label to the raw userId (a behavior change).
  users: UserRepo;
  conversations: ConversationRepo;
  membershipPersistence: MembershipPersistence;
  membership: MembershipService;
};

export type RemoveConversationMemberResult =
  | { ok: true; members: ReturnType<MembershipService['listMembers']> }
  | {
      ok: false;
      error:
        | { code: 'conversation_not_found' }
        | { code: 'unsupported' }
        | { code: 'conversation_closed' }
        | { code: 'forbidden' }
        | { code: 'candidate_not_found' };
    };

/**
 * "May this principal remove THAT agent from this channel" — the ownership half
 * of the agent-removal gate, extracted (#task:1688) so the authoritative write
 * ({@link removeConversationMember}) and the advisory per-member carrier
 * ({@link buildConversationMemberRemovability}) read ONE predicate instead of
 * two copies that could disagree. The conversation-visibility FLOOR
 * (`canViewConversation`) stays at the call sites: it is a separate factor, and
 * the write path must evaluate it BEFORE looking the agent up (anti-enumeration
 * ordering, #957).
 *
 * `admin` OR the agent's creator — removal is graded per verb (#task:1683): an
 * admin governs the roster and must be able to clean it up, while ENROLLMENT has
 * no admin OR-arm at all.
 */
export function mayRemoveConversationAgent(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
  agentId: string,
): boolean {
  return (
    canGovernWorkspace(ctx, principal, workspaceId, 'admin')
    || canEditAgent(ctx, principal, agentId)
  );
}

export async function removeConversationMember(
  deps: RemoveConversationMemberDeps,
  input: { conversationId: string; agentId: string; principal: Principal },
): Promise<RemoveConversationMemberResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation) return { ok: false, error: { code: 'conversation_not_found' } };
  if (conversation.kind !== 'channel') {
    return { ok: false, error: { code: 'unsupported' } };
  }
  if (conversation.closed_at !== null) {
    return { ok: false, error: { code: 'conversation_closed' } };
  }

  // Authorization + anti-enumeration (spec §3.2, #957 — order is load-bearing).
  if (!canViewConversation(deps.ctx, input.principal, conversation.id)) {
    return { ok: false, error: { code: 'forbidden' } };
  }
  const canRemoveByWorkspaceRole = canGovernWorkspace(
    deps.ctx,
    input.principal,
    conversation.workspace_id,
    'admin',
  );
  const agent = deps.agents.get(input.agentId);
  if (!agent) {
    // Missing agent: only callers with the governance role learn it is missing
    // (404); everyone else gets 403 so removal cannot enumerate agent ids.
    return {
      ok: false,
      error: { code: canRemoveByWorkspaceRole ? 'candidate_not_found' : 'forbidden' },
    };
  }
  if (
    !mayRemoveConversationAgent(
      deps.ctx,
      input.principal,
      conversation.workspace_id,
      agent.id,
    )
  ) {
    return { ok: false, error: { code: 'forbidden' } };
  }

  // Idempotent short-circuit: a non-member target is a duplicate-safe no-op —
  // no stop, no system message, no events (spec §6 #7).
  const alreadyMember =
    deps.conversations.getAgent(conversation.id, agent.id) !== null;
  if (!alreadyMember) {
    return { ok: true, members: deps.membership.listMembers(conversation.id) };
  }

  // Pre-commit best-effort: stop the runtime BEFORE the DB write (spec §2.1).
  // The success path awaits until stop settles; a failure is caught and we
  // continue to the removal.
  await deps.ctx.runtimeHost
    .stop(conversation.id, agent.id)
    .catch(err =>
      deps.ctx.logger.warn(
        { conversationId: conversation.id, agentId: agent.id, err },
        'conversation member remove: stop failed',
      ),
    );

  // The IMMUTABLE half of the removal authority: `canEditAgent` is the agent's
  // creator (or the agent itself), which no roster write can change. The
  // governance half IS mutable and is therefore re-derived inside the lock.
  const ownsAgent = canEditAgent(deps.ctx, input.principal, agent.id);
  const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
  const member = conversationMemberAddedAgentSnapshot(agent);
  // The audit message and every effect are driven by the port's in-lock `removed`
  // (#task:1987): the `alreadyMember` read above ran before the lock, so a removal
  // landing in the seam would otherwise commit a second removal audit and fan out a
  // roster change for an edge that no longer exists — a state no serial order of two
  // removals produces. The authority is re-derived here for the same reason.
  let message: MessageDto | null;
  try {
    message = deps.membershipPersistence.uow.atomically(
      { workspaceId: conversation.workspace_id, member: { kind: 'agent', id: agent.id } },
      tx => {
        const authority = readActorAuthority(tx.authority, input.principal, conversation.id);
        if (!authority.inConversation || !(authority.governs || ownsAgent)) {
          throw new MembershipRevalidationRefusal<'forbidden'>('forbidden');
        }
        if (!tx.membership.removeConversationMember(conversation.id).removed) return null;
        return tx.membership.insertMembershipAuditMessage({
          conversationId: conversation.id,
          content: conversationMemberRemovedContent({ actor, member }),
          metadata: conversationMemberRemovedMetadata({ actor, member }),
        });
      },
    );
  } catch (err) {
    return { ok: false, error: { code: refusalOrRethrow<'forbidden'>(err) } };
  }
  if (message) {
    const removedMessage = message;
    await runPostCommitEffects(
      [() => publishMemberRemoved(deps.ctx, deps.conversations, conversation, removedMessage)],
      deps.ctx.logger,
    );
  }
  return { ok: true, members: deps.membership.listMembers(conversation.id) };
}

/**
 * Post-commit publish for a member-removed system message. Order is preserved
 * verbatim (spec §5): `message` → `conversation_members_changed` →
 * `workspace_channels_changed`.
 */
export function publishMemberRemoved(
  ctx: BackendContext,
  conversations: ConversationRepo,
  conversation: { id: string; workspace_id: string },
  message: MessageDto,
): void {
  ctx.events.publish(conversation.id, { kind: 'message', payload: { message } });
  // The removed member no longer appears in listAgents, so the remaining
  // agents get the row and the departed one is naturally excluded.
  deliverSystemMessageToConversationAgents(ctx, conversations, conversation.id, message.id);
  ctx.events.publishSide(conversation.id, {
    kind: 'conversation_members_changed',
    payload: {
      conversation_id: conversation.id,
      workspace_id: conversation.workspace_id,
    },
  });
  ctx.events.publishToScope(
    `workspace:${conversation.workspace_id}`,
    'workspace_channels_changed',
    {
      workspace_id: conversation.workspace_id,
      channel_id: conversation.id,
    },
  );
}

// ── removeConversationHumanMember (#task:1688) ──
//
// Remove ANOTHER human from a channel. The third-party counterpart of
// `leaveChannel`, and the human counterpart of `removeConversationMember`.
//
// Two independent factors, same shape as agent placement (#task:1681/#1683):
// roster AUTHORITY over this workspace (`admin`) ∧ the TARGET being an eligible
// exit. The target factor is not a second copy of the leave rules — it IS
// `evaluateChannelMemberExitEligibility`, so "the workspace owner of a private
// channel cannot be stranded outside it" holds no matter who asks.
//
// `admin`, not `owner`: this ends ONE conversation edge — workspace membership,
// the user row, and the target's role are untouched — which is the same
// day-to-day channel governance already graded `admin` (create / rename /
// archive / add a human). The WORKSPACE human roster stays owner-only because
// it is existential and carries role control (docs/graded-permissions-v1.md
// §1.1). One extra guard makes the grading non-transitive: an `admin` may not
// remove someone who OUTRANKS them, so admin-removes-owner is 403 even though
// both are "governance".

export type RemoveConversationHumanMemberDeps = {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  conversations: ConversationRepo;
  membershipPersistence: MembershipPersistence;
  membership: MembershipService;
};

/**
 * Why a third-party human removal is refused. `not_member` is NOT here: an
 * absent edge is the post-state the caller asked for, so the use case reports
 * success (idempotent no-op) rather than a refusal — the same choice the agent
 * path makes.
 *  - `unsupported`        — the target conversation is not a top-level channel.
 *  - `conversation_closed`— closed conversations take no roster writes.
 *  - `forbidden`          — the caller fails the visibility FLOOR or the `admin`
 *                           authority factor. One code for both: which one it
 *                           was is exactly the fact a non-member must not learn.
 *  - `self_target`        — removing yourself is `POST /channels/:id/leave`, a
 *                           different verb with different gating (any member may
 *                           leave; nobody needs `admin` to). Refusing here keeps
 *                           one owner per behavior instead of letting the
 *                           removal route grow a self branch.
 *  - `target_outranks_actor` — the rank guard above.
 *  - `channel_archived` / `channel_owner` / `last_human_member` — the shared
 *                           exit guards, evaluated for the TARGET.
 */
export type RemoveConversationHumanMemberRefusal =
  | 'unsupported'
  | 'conversation_closed'
  | 'forbidden'
  | 'self_target'
  | 'target_outranks_actor'
  | Exclude<ChannelLeaveBlockedReason, 'not_member'>;

export type RemoveConversationHumanMemberResult =
  | { ok: true; members: ReturnType<MembershipService['listMembers']> }
  | {
      ok: false;
      error:
        | { code: 'conversation_not_found' }
        | { code: RemoveConversationHumanMemberRefusal };
    };

/**
 * The complete third-party human-removal gate, as a pure predicate so the
 * authoritative write ({@link removeConversationHumanMember}) and the advisory
 * per-member carrier ({@link buildConversationMemberRemovability}) cannot
 * disagree — the carrier's whole purpose is to let a surface HIDE an action
 * instead of rendering it disabled, which is only safe while it evaluates the
 * same rule.
 *
 * Ordered so no refusal leaks a fact the caller may not observe:
 *  1. `canViewConversation` — the FLOOR, and it comes FIRST because this
 *     predicate is reached straight from a public route with a caller-supplied
 *     id. Nothing about the conversation may be answered above it: kind and
 *     `closed_at` are as private as the target rows below, so ordering shape
 *     first would let any workspace member sort unknown ids into DM (422) /
 *     closed (409) / invisible channel (403) buckets (anti-enumeration, #957;
 *     the leak this order originally had, caught in review of #task:1688);
 *  2. shape (`unsupported`, `conversation_closed`) — properties the caller has
 *     now proven they can observe;
 *  3. `self_target` — before the authority check, so a plain member asking about
 *     their OWN row gets the accurate "use Leave" answer instead of a
 *     misleading "you lack admin";
 *  4. `admin` authority, then the rank guard;
 *  5. the shared exit eligibility for the target.
 *
 * `outcome: 'noop'` is returned for a target with no edge: the caller may treat
 * it as success without re-deriving "was there anything to remove".
 */
export function evaluateChannelHumanMemberRemoval(
  deps: { ctx: BackendContext; conversations: ConversationRepo },
  principal: Principal,
  conversation: {
    id: string;
    kind: ConversationKind;
    workspace_id: string;
    visibility: ConversationVisibility;
    archived_at: number | null;
    closed_at: number | null;
  },
  targetUserId: string,
):
  | { outcome: 'allowed' }
  | { outcome: 'noop' }
  | { outcome: 'refused'; code: RemoveConversationHumanMemberRefusal } {
  if (!canViewConversation(deps.ctx, principal, conversation.id)) {
    return { outcome: 'refused', code: 'forbidden' };
  }
  if (conversation.kind !== 'channel') {
    return { outcome: 'refused', code: 'unsupported' };
  }
  if (conversation.closed_at !== null) {
    return { outcome: 'refused', code: 'conversation_closed' };
  }
  if (principal.kind === 'user' && principal.userId === targetUserId) {
    return { outcome: 'refused', code: 'self_target' };
  }
  if (!canGovernWorkspace(deps.ctx, principal, conversation.workspace_id, 'admin')) {
    return { outcome: 'refused', code: 'forbidden' };
  }
  // Rank guard: governance is not transitive upward. An `admin` who could evict
  // the `owner` from a channel would be able to strip the owner-anchored
  // governance chain of its resource — the same harm the `channel_owner` exit
  // guard prevents, reached from the other side. Compared by AUTHORITATIVE role
  // rows on both sides (`workspaceRole` for the actor, `userWorkspaceRole` for
  // the target); a target with no role row ranks below everyone, so this never
  // blocks removing a plain member.
  if (
    workspaceRoleOutranks(
      userWorkspaceRole(deps.ctx, conversation.workspace_id, targetUserId),
      workspaceRole(deps.ctx, principal, conversation.workspace_id),
    )
  ) {
    return { outcome: 'refused', code: 'target_outranks_actor' };
  }
  const exit = evaluateChannelMemberExitEligibility(deps, targetUserId, conversation);
  if (exit.can_leave) return { outcome: 'allowed' };
  if (exit.reason === 'not_member') return { outcome: 'noop' };
  // reason is non-null and no longer 'not_member' here.
  return {
    outcome: 'refused',
    code: exit.reason as Exclude<ChannelLeaveBlockedReason, 'not_member'>,
  };
}

/**
 * The MUTABLE half of {@link evaluateChannelHumanMemberRemoval}, re-derived inside
 * the coordinated transaction (#task:1987) — the actor's floor and `admin`
 * authority, the actor↔target rank comparison, and the shared exit rule on facts
 * read under the mechanism.
 *
 * The immutable half is deliberately NOT repeated: the conversation's kind, its
 * `closed_at` and `self_target` are not roster facts, so the pre-lock gate above
 * remains their only evaluation. The target's role comes from the ANCHOR — the same
 * `workspace_users.role` `userWorkspaceRole` reads, taken once, under the lock.
 *
 * Refuses by THROWING, so a refusal is a rollback: `channel_owner` /
 * `last_human_member` protect a state no serial order reaches, and a returned
 * refusal could be ignored by a future edit that had already written.
 */
function revalidateHumanRemovalInsideLock(
  tx: HumanMembershipTxScope,
  input: { principal: Principal; conversationId: string; anchor: WorkspaceMembershipAnchor | null },
): { outcome: 'allowed' | 'noop' } {
  const refuse = (code: RemoveConversationHumanMemberRefusal): never => {
    throw new MembershipRevalidationRefusal<RemoveConversationHumanMemberRefusal>(code);
  };
  const actor = readActorAuthority(tx.authority, input.principal, input.conversationId);
  if (!actor.inConversation) refuse('forbidden');
  if (!actor.governs) refuse('forbidden');
  if (workspaceRoleOutranks(input.anchor?.role ?? null, actor.role)) {
    refuse('target_outranks_actor');
  }
  const exit = evaluateChannelMemberExit(
    inLockChannelExitFactSource(tx.membership, input.conversationId, input.anchor),
  );
  if (exit.can_leave) return { outcome: 'allowed' };
  if (exit.reason === 'not_member') return { outcome: 'noop' };
  return refuse(exit.reason as Exclude<ChannelLeaveBlockedReason, 'not_member'>);
}

/**
 * Remove another human's `conversation_users` edge.
 *
 * Deliberately narrower than the workspace-level human removal
 * (`removeWorkspaceHumanMember`, routes/membership.ts): NOTHING outside this one
 * conversation changes — no `workspace_users` row, no user row, no other
 * channel, no `viewer_workspaces_changed`. Teardown drops only the edge; read
 * cursors and the attention preference are kept for exactly the reasons
 * {@link leaveChannel} documents, and every membership-scoped projection
 * INNER-joins `conversation_users`, so the removed human falls out of all of
 * them from that one delete.
 *
 * Unlike the agent path there is no runtime to stop first — a human has no
 * process — so the pre-commit best-effort `stop` has no counterpart here.
 *
 * Unlike self-leave (silent in v1) this DOES write a
 * `conversation_member_removed` system message: someone else ended the
 * membership, so the remaining members need the audit row, and the actor/member
 * snapshots are the ones the agent-removal path already renders.
 */
export async function removeConversationHumanMember(
  deps: RemoveConversationHumanMemberDeps,
  input: { conversationId: string; userId: string; principal: Principal },
): Promise<RemoveConversationHumanMemberResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation) return { ok: false, error: { code: 'conversation_not_found' } };

  const decision = evaluateChannelHumanMemberRemoval(
    { ctx: deps.ctx, conversations: deps.conversations },
    input.principal,
    conversation,
    input.userId,
  );
  if (decision.outcome === 'refused') {
    return { ok: false, error: { code: decision.code } };
  }
  if (decision.outcome === 'noop') {
    return { ok: true, members: deps.membership.listMembers(conversation.id) };
  }

  const target = deps.users.get(input.userId);
  if (!target) {
    // `conversation_users.user_id` REFERENCES users(id) ON DELETE CASCADE, so an
    // edge without its user row cannot exist. Not a branch to handle — an
    // impossible state to report (same treatment as a conversation pointing at a
    // missing workspace).
    throw new Error(
      `conversation ${conversation.id} has a member row for missing user ${input.userId}`,
    );
  }
  const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
  const member = conversationMemberAddedHumanSnapshot(target);
  // The authority, the exit eligibility and the audit message are all decided under
  // the lock (#task:1987). The gate above ran before it, so another request could
  // have deleted the edge (a second removal audit is a state no serial order
  // produces), demoted the actor, or — by leaving this private channel — made the
  // target its last human, which the exit rule must then refuse.
  let message: MessageDto | null;
  try {
    message = deps.membershipPersistence.uow.atomically(
      { workspaceId: conversation.workspace_id, member: { kind: 'human', id: input.userId } },
      (tx, anchor) => {
        const revalidated = revalidateHumanRemovalInsideLock(tx, {
          principal: input.principal,
          conversationId: conversation.id,
          anchor,
        });
        if (revalidated.outcome === 'noop') return null;
        // The audit follows the WRITE, not the read above it: both answers come from
        // under the lock so they agree, and deriving it from `removed` means no future
        // reordering can leave a lone audit row for an edge that was already gone.
        if (!tx.membership.removeConversationMember(conversation.id).removed) return null;
        return tx.membership.insertMembershipAuditMessage({
          conversationId: conversation.id,
          content: conversationMemberRemovedContent({ actor, member }),
          metadata: conversationMemberRemovedMetadata({ actor, member }),
        });
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: { code: refusalOrRethrow<RemoveConversationHumanMemberRefusal>(err) },
    };
  }
  if (message) {
    const removedMessage = message;
    await runPostCommitEffects(
      [() => publishMemberRemoved(deps.ctx, deps.conversations, conversation, removedMessage)],
      deps.ctx.logger,
    );
  }
  return { ok: true, members: deps.membership.listMembers(conversation.id) };
}

/**
 * The VIEWER-SCOPED `member_removability` carrier for
 * `GET /api/conversations/:id/members` — one entry per roster row, in the roster
 * order, keyed by `(kind, id)` because a client cache may hold a filtered
 * `members` array against an unfiltered carrier (see `MemberRemovabilityDto`).
 *
 * Computed per ROW, never as one "am I an admin" boolean: the two arms answer
 * different questions (an agent's creator may remove that agent while having no
 * governance role at all; an admin may remove three humans but not the workspace
 * owner and not the last human of a private channel), so a single flag would be
 * wrong in both directions. Each arm calls the SAME predicate as its write path
 * ({@link mayRemoveConversationAgent} / {@link evaluateChannelHumanMemberRemoval}).
 *
 * Advisory display only (§12.1#5): the DELETE routes re-evaluate and stay
 * authoritative. `false` for the viewer's own row — self-exit is Leave, a
 * different verb — and `false` for every row when the caller cannot see the
 * conversation, which the route has already refused before reaching here.
 */
export function buildConversationMemberRemovability(
  deps: { ctx: BackendContext; conversations: ConversationRepo },
  principal: Principal,
  conversation: {
    id: string;
    kind: ConversationKind;
    workspace_id: string;
    visibility: ConversationVisibility;
    archived_at: number | null;
    closed_at: number | null;
  },
  members: ReturnType<MembershipService['listMembers']>,
): MemberRemovabilityDto[] {
  return members.map(member =>
    member.kind === 'agent'
      ? {
          kind: 'agent' as const,
          id: member.agent_id,
          can_remove:
            conversation.kind === 'channel'
            && conversation.closed_at === null
            && mayRemoveConversationAgent(
              deps.ctx,
              principal,
              conversation.workspace_id,
              member.agent_id,
            ),
        }
      : {
          kind: 'human' as const,
          id: member.user_id,
          can_remove:
            evaluateChannelHumanMemberRemoval(
              deps,
              principal,
              conversation,
              member.user_id,
            ).outcome === 'allowed',
        },
  );
}

// ── pure target resolver (spec §1.1, constraint ③) ──────────────────
// Was a route helper returning a Hono `Response`; now a pure resolver so the
// use case can call it without leaking the HTTP adapter. The route maps the
// named error to a status code.

type ResolvedConversationMemberInput =
  | { kind: 'agent'; agent_id: string }
  | { kind: 'human'; user_id: string };

function resolveConversationMemberInput(
  deps: { agents: AgentRepo; users: UserRepo; workspaces: WorkspaceRepo },
  input: {
    workspaceId: string;
    member: AddConversationMemberInput;
    mayAttemptNonWorkspaceCandidate: (candidate: { kind: 'agent' | 'human'; id: string }) => boolean;
  },
):
  | { ok: true; member: ResolvedConversationMemberInput }
  | { ok: false; error: AddConversationMemberError } {
  if (!('handle' in input.member)) {
    return { ok: true, member: input.member };
  }

  const handle = normalizeHandle(input.member.handle);
  const candidates: Array<HandleCandidate & { workspaceMember: boolean }> = [];

  const agent = deps.agents.getByName(handle);
  if (agent) {
    candidates.push({
      kind: 'agent',
      id: agent.id,
      display_name: agent.display_name,
      handle: `@${agent.name}`,
      workspaceMember: deps.workspaces.isMember(input.workspaceId, agent.id),
    });
  }

  const user = deps.users.getByName(handle);
  if (user) {
    candidates.push({
      kind: 'human',
      id: user.id,
      display_name: user.display_name,
      handle: `@${user.name}`,
      workspaceMember: deps.workspaces.isUserMember(input.workspaceId, user.id),
    });
  }

  if (candidates.length === 0) {
    return { ok: false, error: { code: 'candidate_not_found', message: 'candidate not found' } };
  }

  // Narrowing NARROWS an ambiguous handle; it does NOT answer authorization.
  // A candidate that is not a workspace member yet stays in the running only when
  // THIS caller could get as far as the workspace-side write for THAT candidate —
  // a per-candidate question since #task:1683 (own agent: any channel member;
  // human or someone else's agent: admin), so it cannot be one boolean for two
  // data classes. It is deliberately not named "can place": for someone else's
  // not-yet-enrolled agent an admin passes here and is still refused
  // `agent_not_owned` by the creator-only enrollment gate (#task:1681).
  //
  // When NOTHING survives narrowing we deliberately fall back to the full
  // candidate set instead of answering here (Cindy, #task:1683 review): otherwise
  // the same target would get a different typed contract purely from the INPUT
  // SHAPE — a plain member reaching for someone else's non-workspace agent got
  // `agent_not_owned` by id but `workspace_membership_required` by handle. The
  // refusal belongs to the ONE authorization path downstream (target-kind /
  // ownership grading, then the per-leg workspace-membership check), which is
  // also what keeps `workspace_membership_required` a single-authority answer:
  // an agent principal still gets it from its leg, since it can never
  // auto-provision.
  const narrowedCandidates = candidates.filter(
    candidate =>
      candidate.workspaceMember
      || input.mayAttemptNonWorkspaceCandidate({ kind: candidate.kind, id: candidate.id }),
  );
  const consideredCandidates =
    narrowedCandidates.length > 0 ? narrowedCandidates : candidates;

  if (consideredCandidates.length > 1) {
    return {
      ok: false,
      error: {
        code: 'handle_ambiguous',
        candidates: consideredCandidates.map(candidate => ({
          kind: candidate.kind,
          id: candidate.id,
          display_name: candidate.display_name,
          handle: candidate.handle,
        })),
      },
    };
  }

  const candidate = consideredCandidates[0];
  if (!candidate) {
    throw new Error('resolveConversationMemberInput: expected exactly one candidate');
  }
  return {
    ok: true,
    member: candidate.kind === 'agent'
      ? { kind: 'agent', agent_id: candidate.id }
      : { kind: 'human', user_id: candidate.id },
  };
}

// ── member-added system-message snapshots (shared with the remove path) ──
//
// The pure language — the two snapshot types, the agent/human snapshots and the
// added/removed content + metadata builders — lives in
// `conversation-member-audit.ts` so a use case can compose an audit message
// without importing this module's repos. Only the principal → snapshot
// resolution stays here: it is a directory read, not wording.

export function conversationMemberAddedActorSnapshot(
  deps: { agents: AgentRepo; users: UserRepo },
  principal: Principal,
): ConversationMemberAddedActorSnapshot {
  if (principal.kind === 'agent') {
    const agent = deps.agents.get(principal.agentId);
    return {
      kind: 'agent',
      id: principal.agentId,
      name: agent?.name ?? principal.agentId,
      displayName: agent?.display_name ?? null,
    };
  }
  if (principal.kind === 'user') {
    const user = deps.users.get(principal.userId);
    return {
      kind: 'user',
      id: principal.userId,
      name: user?.name ?? principal.userId,
      displayName: user?.display_name ?? null,
    };
  }
  return {
    kind: 'system',
    id: 'system',
    name: 'system',
    displayName: null,
  };
}
