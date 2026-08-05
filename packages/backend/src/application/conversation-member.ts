import {
  type AddConversationMemberInput,
  type ChannelDetailResponse,
  type ChannelLeaveBlockedReason,
  type ChannelLikeDto,
  type ConversationKind,
  type ConversationVisibility,
  type MemberRemovabilityDto,
  type WorkspaceRoleDto,
  normalizeHandle,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ChannelAttentionPreferenceRepo } from '../repos/channel-attention-preference-repo.js';
import type { MembershipService } from '../services/membership-service.js';
import {
  canAddConversationMember,
  canEditAgent,
  canEnrollAgent,
  canGovernWorkspace,
  canJoinPublicChannel,
  canViewConversation,
  userWorkspaceRole,
  workspaceRole,
  workspaceRoleOutranks,
} from '../permissions.js';
import { addWorkspaceAgentMember } from './add-workspace-agent-member.js';
import { type PostCommitEffect, runPostCommitEffects } from './post-commit.js';

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
  messages: MessageRepo;
  channelAttentionPrefs: ChannelAttentionPreferenceRepo;
  membership: MembershipService;
};

/**
 * The membership-transition write-core for "an existing workspace human enters
 * a channel", SHARED by {@link addConversationMember}'s human leg and
 * {@link joinPublicChannel} so the join invariants live in ONE place and cannot
 * drift into two models. The CALLER owns the enclosing DB transaction and any
 * visible system message / post-commit effects — this does only the membership
 * writes.
 *
 * PRECONDITION: call ONLY inside a transition the caller has confirmed to be a
 * fresh entry (target is NOT already a member). This is NOT a re-entrant upsert:
 * the read baseline uses `markRead` (monotonic max), which never regresses but
 * WOULD advance the cursor past new messages if re-run after the first entry —
 * so re-invoking it on an already-member is a silent cursor bug, not a no-op.
 * Zero-increment on an idempotent retry is the CALLER's `alreadyMember` guard,
 * not a property of this function.
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
 * A caller that also inserts a member-added system message MUST insert it BEFORE
 * calling this, so the baseline's `listStreamHeads` read includes it.
 */
function seedChannelHumanMembership(
  deps: {
    ctx: BackendContext;
    conversations: ConversationRepo;
    messages: MessageRepo;
    channelAttentionPrefs: ChannelAttentionPreferenceRepo;
  },
  conversationId: string,
  userId: string,
): void {
  deps.conversations.addUser(conversationId, userId);
  deps.channelAttentionPrefs.insertIfAbsent({
    viewerUserId: userId,
    conversationId,
    mode: 'mentions',
  });
  const reads = new ConversationReadRepo(deps.ctx.db);
  for (const head of deps.messages.listStreamHeads(conversationId)) {
    reads.markRead({
      viewerUserId: userId,
      conversationId,
      threadRootId: head.threadRootId,
      seq: head.latestSeq,
    });
  }
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
  // this use case does not hold enrollment authority — `addWorkspaceAgentMember`
  // does (creator-only, #task:1681: not even an admin enrolls someone else's
  // agent). What we decide here is only ROUTING: whether to walk the enrollment
  // path and let it answer with its own typed refusal, or to stop with
  // `workspace_membership_required` because that path can never run for this
  // principal at all. Hence the name — an admin gets `true` and may still be
  // refused with `agent_not_owned` one call later; that is a two-stage refusal,
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
      // this principal". `addWorkspaceAgentMember` below owns the real gate and
      // answers `agent_not_owned` for anyone but the creator, admin included.
      if (!mayAttemptAgentEnrollment(agent.id)) {
        return {
          ok: false,
          error: {
            code: 'workspace_membership_required',
            message: 'agent is not a member of this workspace',
          },
        };
      }
      const workspace = deps.workspaces.get(conversation.workspace_id);
      if (!workspace) {
        throw new Error(`conversation ${conversation.id} references missing workspace ${conversation.workspace_id}`);
      }
      const workspaceMember = await addWorkspaceAgentMember(
        { ctx: deps.ctx, agents: deps.agents, workspaces: deps.workspaces },
        {
          principal: input.principal,
          workspace: {
            id: workspace.id,
          },
          agentId: agent.id,
        },
      );
      if (!workspaceMember.ok) {
        switch (workspaceMember.error.code) {
          case 'agent_not_found':
            return {
              ok: false,
              error: { code: 'candidate_not_found', message: 'agent not found' },
            };
          case 'agent_not_owned':
            // #task:1681 — this door auto-provisions WORKSPACE membership, so it
            // is bound by the same enrollment authority as the workspace
            // member-add route: a workspace admin may not pull a teammate's
            // agent in. An agent already in the workspace is unaffected (the
            // gate only runs on the auto-provision branch).
            return { ok: false, error: { code: 'agent_not_owned' } };
        }
      }
    }
    const alreadyMember = deps.conversations.getAgent(conversation.id, agent.id) !== null;
    if (!alreadyMember) {
      const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
      const memberSnap = conversationMemberAddedAgentSnapshot(agent);
      const message = deps.ctx.db.transaction(() => {
        deps.conversations.addAgent(conversation.id, agent.id);
        return deps.messages.insertForConversation({
          conversationId: conversation.id,
          fromKind: 'system',
          content: conversationMemberAddedContent({ actor, member: memberSnap }),
          metadata: conversationMemberAddedMetadata({ actor, member: memberSnap }),
        });
      })();
      effects.push(() => publishMemberAdded(deps.ctx, deps.conversations, conversation, message));
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
  const alreadyMember = deps.conversations.getUser(conversation.id, user.id) !== null;
  if (!workspaceWasMember || !alreadyMember) {
    const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
    const memberSnap = conversationMemberAddedHumanSnapshot(user);
    const write = deps.ctx.db.transaction(() => {
      const workspaceMember = workspaceWasMember
        ? null
        : deps.workspaces.addUserMember(conversation.workspace_id, user.id);
      let message: ReturnType<MessageRepo['insertForConversation']> | null = null;
      if (!alreadyMember) {
        // Insert the member-added system message FIRST, THEN run the shared
        // membership transition. Order is load-bearing: seedChannelHumanMembership
        // baselines the read cursor to each stream's CURRENT head, so the message
        // must already be on the mainline for the new member to not see "X added
        // you" as unread. The visible system message is admin-add-specific and
        // stays HERE in the caller; the addUser + attention-pref + per-stream
        // baseline write-core is shared with self-join so the join invariants
        // cannot drift into two models.
        message = deps.messages.insertForConversation({
          conversationId: conversation.id,
          fromKind: 'system',
          content: conversationMemberAddedContent({ actor, member: memberSnap }),
          metadata: conversationMemberAddedMetadata({ actor, member: memberSnap }),
        });
        seedChannelHumanMembership(deps, conversation.id, user.id);
      }
      return { workspaceMember, message };
    })();
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
  }
  await runPostCommitEffects(effects, deps.ctx.logger);
  return { ok: true, members: deps.membership.listMembers(conversation.id) };
}

type ViewerWorkspaceChange = 'added' | 'role_changed' | 'removed';

function publishViewerWorkspacesChanged(
  ctx: BackendContext,
  userId: string,
  payload: {
    change: ViewerWorkspaceChange;
    workspace_id: string;
    role?: WorkspaceRoleDto;
  },
): void {
  ctx.events.publishToScope(
    `viewer:${userId}`,
    'viewer_workspaces_changed',
    payload,
  );
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
  message: ReturnType<MessageRepo['insertForConversation']>,
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
  messages: MessageRepo;
  channelAttentionPrefs: ChannelAttentionPreferenceRepo;
};

export type JoinPublicChannelResult =
  | { ok: true }
  | { ok: false; error: { code: 'channel_not_found' } | { code: 'forbidden' } };

/**
 * Self-join a PUBLIC channel — the ONLY non-member mutation the public model
 * allows: a workspace human pulls THEMSELVES into a public channel. The caller
 * is ALWAYS the joined member; the route takes no body, so there is no target
 * on the wire to forge.
 *
 * Admission (`canJoinPublicChannel`) is validated BEFORE the already-member
 * idempotency check, so an existing member of a private / `dm_channel` / legacy
 * thread / archived target cannot get a success from `/join`. On a fresh join
 * the membership transition runs through the SHARED
 * {@link seedChannelHumanMembership} primitive (same-source with admin-add).
 *
 * Post-commit fires ONLY `conversation_members_changed` (roster) +
 * `workspace_channels_changed` (discovery/list): NO `viewer_workspaces_changed`
 * (the joiner was already a workspace member — joining a channel does not change
 * workspace membership) and NO system message (self-join has no "actor added
 * member" semantic to reuse, and v1 has no distinct joined message). Every
 * effect is gated by `alreadyMember`, so an idempotent retry is zero-increment
 * on the row, the attention preference, the read cursors, AND the events.
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
  const alreadyMember = deps.conversations.getUser(conversation.id, userId) !== null;
  if (!alreadyMember) {
    deps.ctx.db.transaction(() => {
      seedChannelHumanMembership(deps, conversation.id, userId);
    })();
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
 * The SINGLE exit-eligibility rule for a human's `conversation_users` edge,
 * shared by every path that can end that membership: the {@link leaveChannel}
 * write (authoritative), the channel-detail `can_leave` carrier (advisory
 * display), and — since #task:1688 — third-party removal
 * ({@link evaluateChannelHumanMemberRemoval}) plus its per-member carrier.
 * Evaluated for the TARGET member (`userId`), which for self-leave is the
 * caller: whether the edge may end does not depend on who asked, so the rule
 * cannot fork into a "leave" copy and a "remove" copy. It is a pure predicate
 * over the member + channel row — returns `can_leave` plus the stable
 * {@link ChannelLeaveBlockedReason} when blocked (advisory ≠ correctness, but
 * same source — docs/architecture-principles.md §12.1#5).
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
 *     `workspace_users.role='owner'` (`userWorkspaceRole`) — the model has NO
 *     per-channel creator, so this never guesses from row order / first member.
 *     Public channels are exempt (owner re-browses + re-joins freely).
 *  4. `last_human_member` — ending the last HUMAN edge of a PRIVATE channel
 *     would strand it (no human, incl. admins, can see or re-join a private
 *     channel). `conversation_users` IS the human-membership table, so its row
 *     count is the human count. Active PUBLIC channels are exempt (0 humans
 *     stays discoverable + joinable).
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
  if (conversation.kind !== 'channel') {
    return { can_leave: false, reason: 'not_member' };
  }
  if (deps.conversations.getUser(conversation.id, userId) === null) {
    return { can_leave: false, reason: 'not_member' };
  }
  if (conversation.archived_at !== null) {
    return { can_leave: false, reason: 'channel_archived' };
  }
  // Owner-bound governance guard (private only): the workspace owner anchors
  // the governance chain. Losing membership of a PRIVATE channel would make it
  // invisible to them (private + non-member = no view / no re-join), severing
  // the chain from the resource even when other humans remain. Authoritative
  // owner relation (`workspace_users.role='owner'`) — never a
  // first-member/display-name guess (no per-channel creator is modeled).
  // Checked ABOVE last_human_member so the owner-specific reason wins when both
  // apply. Public channels are exempt (owner can re-browse + re-join).
  if (
    conversation.visibility === 'private'
    && userWorkspaceRole(deps.ctx, conversation.workspace_id, userId) === 'owner'
  ) {
    return { can_leave: false, reason: 'channel_owner' };
  }
  if (
    conversation.visibility === 'private'
    && deps.conversations.listUsers(conversation.id).length <= 1
  ) {
    return { can_leave: false, reason: 'last_human_member' };
  }
  return { can_leave: true, reason: null };
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
    // reason is non-null whenever can_leave is false.
    return { ok: false, error: { code: eligibility.reason as ChannelLeaveBlockedReason } };
  }
  deps.ctx.db.transaction(() => {
    deps.conversations.removeUser(conversation.id, input.principal.userId);
  })();
  await runPostCommitEffects(
    [() => publishSelfLeft(deps.ctx, conversation)],
    deps.ctx.logger,
  );
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
  messages: MessageRepo;
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

  const actor = conversationMemberAddedActorSnapshot(deps, input.principal);
  const member = conversationMemberAddedAgentSnapshot(agent);
  const message = deps.ctx.db.transaction(() => {
    deps.conversations.removeAgent(conversation.id, agent.id);
    return deps.messages.insertForConversation({
      conversationId: conversation.id,
      fromKind: 'system',
      content: conversationMemberRemovedContent({ actor, member }),
      metadata: conversationMemberRemovedMetadata({ actor, member }),
    });
  })();

  const effects: PostCommitEffect[] = [() => publishMemberRemoved(deps.ctx, deps.conversations, conversation, message)];
  await runPostCommitEffects(effects, deps.ctx.logger);
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
  message: ReturnType<MessageRepo['insertForConversation']>,
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
  messages: MessageRepo;
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
  const message = deps.ctx.db.transaction(() => {
    deps.conversations.removeUser(conversation.id, input.userId);
    return deps.messages.insertForConversation({
      conversationId: conversation.id,
      fromKind: 'system',
      content: conversationMemberRemovedContent({ actor, member }),
      metadata: conversationMemberRemovedMetadata({ actor, member }),
    });
  })();

  await runPostCommitEffects(
    [() => publishMemberRemoved(deps.ctx, deps.conversations, conversation, message)],
    deps.ctx.logger,
  );
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

export type ConversationMemberAddedActorSnapshot = {
  kind: 'user' | 'agent' | 'system';
  id: string;
  name: string;
  displayName: string | null;
};

export type ConversationMemberAddedMemberSnapshot = {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  displayName: string | null;
};

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

export function conversationMemberAddedAgentSnapshot(agent: {
  id: string;
  name: string;
  display_name?: string | null;
}): ConversationMemberAddedMemberSnapshot {
  return {
    kind: 'agent',
    id: agent.id,
    name: agent.name,
    displayName: agent.display_name ?? null,
  };
}

export function conversationMemberAddedHumanSnapshot(
  // Structural, like {@link conversationMemberAddedAgentSnapshot}: the snapshot
  // reads three identity fields, so a caller holding a `UserRow` (repo read) is
  // as valid as one holding a `UserDto` (resolved DTO) — the helper has no reason
  // to demand the wider shape.
  user: { id: string; name: string; display_name?: string | null },
): ConversationMemberAddedMemberSnapshot {
  return {
    kind: 'human',
    id: user.id,
    name: user.name,
    displayName: user.display_name ?? null,
  };
}

export function conversationMemberAddedContent(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): string {
  return `${conversationMemberAddedLabel(input.actor)} added ${conversationMemberAddedLabel(input.member)} to this conversation.`;
}

export function conversationMemberAddedLabel(
  participant:
    | ConversationMemberAddedActorSnapshot
    | ConversationMemberAddedMemberSnapshot,
): string {
  return participant.kind === 'system' ? 'system' : `@${participant.name}`;
}

export function conversationMemberAddedMetadata(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): Record<string, unknown> {
  return {
    subtype: systemSubtype('conversation_member_added'),
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_name: input.actor.name,
    actor_display_name: input.actor.displayName,
    member_kind: input.member.kind,
    member_id: input.member.id,
    member_name: input.member.name,
    member_display_name: input.member.displayName,
  };
}

export function conversationMemberRemovedContent(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): string {
  return `${conversationMemberAddedLabel(input.actor)} removed ${conversationMemberAddedLabel(input.member)} from this conversation.`;
}

export function conversationMemberRemovedMetadata(input: {
  actor: ConversationMemberAddedActorSnapshot;
  member: ConversationMemberAddedMemberSnapshot;
}): Record<string, unknown> {
  return {
    subtype: systemSubtype('conversation_member_removed'),
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_name: input.actor.name,
    actor_display_name: input.actor.displayName,
    member_kind: input.member.kind,
    member_id: input.member.id,
    member_name: input.member.name,
    member_display_name: input.member.displayName,
  };
}
