import {
  type AddConversationMemberInput,
  type ChannelDetailResponse,
  type ChannelLeaveBlockedReason,
  type ChannelLikeDto,
  type ConversationKind,
  type ConversationVisibility,
  type UserDto,
  type WorkspaceRoleDto,
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
  canGovernWorkspace,
  canJoinPublicChannel,
  canViewConversation,
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
  | { code: 'workspace_agent_placement'; cause: unknown }
  | {
      code: 'workspace_agent_seed_failed';
      failure: {
        code: string;
        message: string;
        status: 400 | 403 | 404 | 409 | 502 | 503 | 504 | 507;
      };
    }
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

  // Authorization (spec §3, constraint ①). Human governance: adding a
  // conversation member is a governance write — require BOTH conversation
  // visibility AND the admin effective role. Agent/system: the agent route's
  // `manage_conversation_members` capability gate already runs before the
  // request enters this use case; here we keep the view-equivalent
  // membership check.
  if (input.principal.kind === 'user') {
    if (
      !canAddConversationMember(deps.ctx, input.principal, conversation.id)
      || !canGovernWorkspace(deps.ctx, input.principal, conversation.workspace_id, 'admin')
    ) {
      return { ok: false, error: { code: 'forbidden' } };
    }
  } else {
    if (!canAddConversationMember(deps.ctx, input.principal, conversation.id)) {
      return { ok: false, error: { code: 'forbidden' } };
    }
  }

  const canAutoProvisionWorkspaceMember =
    input.principal.kind === 'user'
    && canGovernWorkspace(deps.ctx, input.principal, conversation.workspace_id, 'admin');

  const resolved = resolveConversationMemberInput(deps, {
    workspaceId: conversation.workspace_id,
    member: input.member,
    allowAutoWorkspaceMembership: canAutoProvisionWorkspaceMember,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const effects: PostCommitEffect[] = [];

  if (resolved.member.kind === 'agent') {
    const agent = deps.agents.get(resolved.member.agent_id);
    if (!agent) {
      return { ok: false, error: { code: 'candidate_not_found', message: 'agent not found' } };
    }
    const workspaceWasMember = deps.workspaces.isMember(conversation.workspace_id, agent.id);
    if (!workspaceWasMember) {
      if (!canAutoProvisionWorkspaceMember) {
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
          workspace: {
            id: workspace.id,
            workspace_path: workspace.workspace_path,
            workspace_host_id: workspace.workspace_host_id,
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
          case 'placement':
            return {
              ok: false,
              error: { code: 'workspace_agent_placement', cause: workspaceMember.error.cause },
            };
          case 'seed_failed':
            return {
              ok: false,
              error: {
                code: 'workspace_agent_seed_failed',
                failure: workspaceMember.error.failure,
              },
            };
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
      effects.push(() => publishMemberAdded(deps.ctx, conversation, message));
    }
    await runPostCommitEffects(effects, deps.ctx.logger);
    return { ok: true, members: deps.membership.listMembers(conversation.id) };
  }

  const user = deps.ctx.userService.getDto(resolved.member.user_id);
  if (!user) {
    return { ok: false, error: { code: 'candidate_not_found', message: 'user not found' } };
  }
  const workspaceWasMember = deps.workspaces.isUserMember(conversation.workspace_id, user.id);
  if (!workspaceWasMember && !canAutoProvisionWorkspaceMember) {
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
      effects.push(() => publishMemberAdded(deps.ctx, conversation, message));
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
 * Post-commit publish for a member-added system message. Order is preserved
 * verbatim from the original route helper (spec §7 ruling ⑥): `message` →
 * `conversation_members_changed` → `workspace_channels_changed`.
 */
function publishMemberAdded(
  ctx: BackendContext,
  conversation: { id: string; workspace_id: string },
  message: ReturnType<MessageRepo['insertForConversation']>,
): void {
  ctx.events.publish(conversation.id, { kind: 'message', payload: { message } });
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
 * The SINGLE leave-eligibility rule, shared by the {@link leaveChannel} write
 * path (authoritative) and the channel-detail carrier (advisory display). It is
 * a pure predicate over the viewer + channel row — returns `can_leave` plus the
 * stable {@link ChannelLeaveBlockedReason} when blocked. Because both the
 * carrier and the write call THIS, the disabled-Leave hint the modal shows can
 * never disagree with what the POST enforces (advisory ≠ correctness, but same
 * source — docs/architecture-principles.md §12.1#5).
 *
 * Ordered so the most specific block wins:
 *  1. `not_member` — leave is member-only; a non-member's only channel mutation
 *     is Join (idempotency must not outrank the permission model).
 *  2. `channel_archived` — v1 freezes archived channels; restore before leaving
 *     (an archived channel is deliberately NOT folded into the public 0-human
 *     exception).
 *  3. `channel_owner` — the workspace OWNER of a PRIVATE channel anchors the
 *     owner-bound governance chain; leaving would make the channel invisible to
 *     them (private + non-member) and sever the chain from the resource even
 *     with other humans present. Authoritative `workspace_users.role='owner'`
 *     (`canGovernWorkspace(..,'owner')`) — the model has NO per-channel creator,
 *     so this never guesses from row order / first member. Public channels are
 *     exempt (owner re-browses + re-joins freely).
 *  4. `last_human_member` — leaving as the last HUMAN of a PRIVATE channel would
 *     strand it (no human, incl. admins, can see or re-join a private channel).
 *     `conversation_users` IS the human-membership table, so its row count is
 *     the human count. Active PUBLIC channels are exempt (0 humans stays
 *     discoverable + joinable).
 */
export function evaluateChannelLeaveEligibility(
  deps: { ctx: BackendContext; conversations: ConversationRepo },
  principal: UserPrincipal,
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
  if (deps.conversations.getUser(conversation.id, principal.userId) === null) {
    return { can_leave: false, reason: 'not_member' };
  }
  if (conversation.archived_at !== null) {
    return { can_leave: false, reason: 'channel_archived' };
  }
  // Owner-bound governance guard (private only): the workspace owner anchors
  // the governance chain. Leaving a PRIVATE channel would make it invisible to
  // them (private + non-member = no view / no re-join), severing the chain from
  // the resource even when other humans remain. Authoritative owner relation
  // (`workspace_users.role='owner'`) via canGovernWorkspace — never a
  // first-member/display-name guess (no per-channel creator is modeled).
  // Checked ABOVE last_human_member so the owner-specific reason wins when both
  // apply. Public channels are exempt (owner can re-browse + re-join).
  if (
    conversation.visibility === 'private'
    && canGovernWorkspace(deps.ctx, principal, conversation.workspace_id, 'owner')
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
 * {@link evaluateChannelLeaveEligibility} so the block reasons match the
 * detail-carrier hint exactly.
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
 * self-join). The renderer's single viewer-local cleanup handler keys off these
 * to re-derive the leaver's projections and route away if they were viewing a
 * now-invisible private channel.
 */
export async function leaveChannel(
  deps: LeaveChannelDeps,
  input: { conversationId: string; principal: UserPrincipal },
): Promise<LeaveChannelResult> {
  const conversation = deps.conversations.get(input.conversationId);
  if (!conversation || conversation.kind !== 'channel') {
    return { ok: false, error: { code: 'channel_not_found' } };
  }
  const eligibility = evaluateChannelLeaveEligibility(
    { ctx: deps.ctx, conversations: deps.conversations },
    input.principal,
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
  const leave = evaluateChannelLeaveEligibility({ ctx, conversations }, principal, channel);
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
    !canRemoveByWorkspaceRole
    && !canEditAgent(deps.ctx, input.principal, agent.id)
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
    .stop(conversation.id, agent.id, 'hard')
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

  const effects: PostCommitEffect[] = [() => publishMemberRemoved(deps.ctx, conversation, message)];
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
  conversation: { id: string; workspace_id: string },
  message: ReturnType<MessageRepo['insertForConversation']>,
): void {
  ctx.events.publish(conversation.id, { kind: 'message', payload: { message } });
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

// ── pure target resolver (spec §1.1, constraint ③) ──────────────────
// Was a route helper returning a Hono `Response`; now a pure resolver so the
// use case can call it without leaking the HTTP adapter. The route maps the
// named error to a status code.

type ResolvedConversationMemberInput =
  | { kind: 'agent'; agent_id: string }
  | { kind: 'human'; user_id: string };

function normalizeMemberHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

function resolveConversationMemberInput(
  deps: { agents: AgentRepo; users: UserRepo; workspaces: WorkspaceRepo },
  input: {
    workspaceId: string;
    member: AddConversationMemberInput;
    allowAutoWorkspaceMembership: boolean;
  },
):
  | { ok: true; member: ResolvedConversationMemberInput }
  | { ok: false; error: AddConversationMemberError } {
  if (!('handle' in input.member)) {
    return { ok: true, member: input.member };
  }

  const handle = normalizeMemberHandle(input.member.handle);
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

  const eligibleCandidates = candidates.filter(
    candidate =>
      candidate.workspaceMember
      || input.allowAutoWorkspaceMembership,
  );
  if (eligibleCandidates.length === 0) {
    return {
      ok: false,
      error: {
        code: 'workspace_membership_required',
        message: 'candidate is not a member of this workspace',
      },
    };
  }

  if (eligibleCandidates.length > 1) {
    return {
      ok: false,
      error: {
        code: 'handle_ambiguous',
        candidates: eligibleCandidates.map(candidate => ({
          kind: candidate.kind,
          id: candidate.id,
          display_name: candidate.display_name,
          handle: candidate.handle,
        })),
      },
    };
  }

  const candidate = eligibleCandidates[0];
  if (!candidate) {
    throw new Error('resolveConversationMemberInput: expected exactly one eligible candidate');
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
  user: UserDto,
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
