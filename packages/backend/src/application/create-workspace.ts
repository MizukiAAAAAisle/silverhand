import {
  type AgentDto,
  type CanonicalWorkspaceName,
  formatReferenceToken,
  inlineCode,
  fixedConversationTitle,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { MembershipPersistence } from './membership-ports.js';
import { canEnrollAgent } from '../permissions.js';
import { enrollAgentIntoWorkspace } from './add-workspace-agent-member.js';
import { isWorkspaceNameAvailable } from './name-availability.js';
import { logWorkspaceAddressAssignment } from '../observability/workspace-address-log.js';

/**
 * CreateWorkspace saga.
 *
 * Owns the whole `POST /api/workspaces` orchestration: dup-name guard,
 * enrollment authority for initial member agents, the workspace row + owner/
 * member writes, the per-agent `insertMembership + seedDefaults` unit-of-work,
 * and the onboarding fan-out.
 *
 * relocation-v1 §3.4 / §7-4 — registry demotion: a regular workspace no longer
 * owns a working directory and has no home computer, so create NO LONGER does
 * provision-at-create. There is no workspace directory to provision — each
 * agent materializes its own agent-centric bundle lazily at spawn time (the
 * existing agent-materialize path); member L2 is seeded lazily at first spawn
 * (`AgentL2SeedEnsurer`). Creation is therefore a pure set of DB writes: no
 * daemon dispatch, no provision barrier, no path or host input to forward — the
 * `workspace_path` / `workspace_host_id` / `requested_path` inputs are gone from
 * the contract (§6 epoch cut), not merely ignored.
 *
 * HTTP-agnostic by construction (spec §1.1 / §4): it returns a typed
 * {@link CreateWorkspaceResult}; the route maps result kind → HTTP status +
 * body. It never imports Hono `Context` and never builds a `Response`.
 *
 * This is NOT a single-commit use case: it is a multi-step saga with several
 * DB writes. The workspace row + owner/user members are written, then each
 * agent gets its own `insertMembership + seedDefaults` transaction. Member L2
 * memory is not part of this saga (materialized lazily at first spawn).
 *
 * The onboarding fan-out deliberately does NOT use the post-commit-effect
 * batch shape (spec §2.2): `deliverMessage` is `await`ed on the critical path
 * (a failure propagates and truncates the fan-out) while only `start` is
 * fire-and-forget — behavior-preserved verbatim, not reshaped toward P5.
 */

export type CreateWorkspaceDeps = {
  ctx: BackendContext;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  membershipPersistence: MembershipPersistence;
};

export type CreateWorkspaceCommand = {
  name: CanonicalWorkspaceName;
  description: string | null;
  memberAgentIds: string[];
  memberUserIds: string[];
  /**
   * The creator. Route passes `getUserPrincipal(c)`; the workspace owner and
   * every placement decision below read `principal.userId`. ONE field on
   * purpose — a separate `viewerUserId` alongside a principal would be two
   * readable identities that could disagree.
   */
  principal: UserPrincipal;
};

export type CreateWorkspaceSuccess = {
  workspace: NonNullable<ReturnType<WorkspaceRepo['get']>>;
  onboardingChannelId: string;
  channel: ReturnType<ConversationRepo['insertChannel']>;
};

/**
 * Named result — no HTTP status policy (spec §3.1). The route maps kind →
 * status/body with an exhaustive `switch` + `never` fallback.
 */
export type CreateWorkspaceResult =
  | { kind: 'created'; success: CreateWorkspaceSuccess }
  | { kind: 'nameTaken' }
  /**
   * #task:1681 — one or more requested initial member agents were not created
   * by the caller. Creating a workspace is the THIRD door into agent workspace
   * membership, so it carries the same enrollment authority as the two
   * member-add doors; without this arm the popover gate would be trivially
   * bypassable by naming a teammate's agent at create time.
   */
  | { kind: 'agentNotOwned'; agentIds: string[] };

export async function createWorkspace(
  deps: CreateWorkspaceDeps,
  cmd: CreateWorkspaceCommand,
): Promise<CreateWorkspaceResult> {
  const { ctx, agents, users, workspaces, conversations, messages } = deps;

  // Domain rule: workspace names are unique (among regular workspaces).
  // SHARED predicate with the name-availability probe endpoint.
  if (!isWorkspaceNameAvailable({ workspaces }, cmd.name)) {
    return { kind: 'nameTaken' };
  }

  // #task:1600 — initial members may live on any computer: membership is a
  // pure DB write and each member materializes its own bundle lazily at first
  // spawn, so there is no per-member host gate here. A regular workspace has no
  // owning host (relocation-v1 §7-4), so there is no placement step at all.
  const memberAgents = cmd.memberAgentIds
    .map(id => agents.get(id))
    .filter((agent): agent is AgentDto => agent !== null);
  const memberUserIds = cmd.memberUserIds.filter(id => users.get(id) !== null);

  // Enrollment authority (#task:1681): the SAME rule the member-add doors
  // enforce — only an agent's creator may place it in a workspace. Rejected
  // loudly rather than filtered out: a silent drop would leave the creator with
  // a workspace missing the members they asked for and no way to learn why.
  // (Unknown ids stay silently filtered above — pre-existing behavior, and
  // "does not exist" carries no rule the caller could act on.)
  //
  // Runs BEFORE the row insert, so a rejection leaves no workspace and no
  // membership.
  const notOwned = memberAgents.filter(agent => !canEnrollAgent(ctx, cmd.principal, agent.id));
  if (notOwned.length > 0) {
    return { kind: 'agentNotOwned', agentIds: notOwned.map(agent => agent.id) };
  }

  const workspaceId = workspaces.newWorkspaceId();
  const workspace = workspaces.insert({
    id: workspaceId,
    name: cmd.name,
    description: cmd.description,
  });
  // Address allocation is the successful workspace INSERT, not completion of
  // this multi-step saga. Record it before any later membership/onboarding
  // effect can throw: those failures leave the allocated row committed, so an
  // HTTP-success-only observation would misclassify the next attempt as a pure
  // conflict with no preceding assignment.
  logWorkspaceAddressAssignment(ctx.logger, {
    workspaceId: workspace.id,
    action: 'create',
    oldKey: null,
    newKey: cmd.name.key,
  });

  // Graded-permissions (v40): the creator is the workspace OWNER; additional
  // members join as plain `member` (no implicit admin). `setOwnerUserId` stamps
  // the denormalized pointer AND promotes the role in one tx.
  workspaces.addUserMember(workspace.id, cmd.principal.userId, 'owner');
  workspaces.setOwnerUserId(workspace.id, cmd.principal.userId);
  for (const userId of memberUserIds) {
    workspaces.addUserMember(workspace.id, userId);
  }

  // Provisioning collapse (relocation-v1 §7 task 4): member L2 memory is NOT
  // seeded here. Each member's L2 is materialized lazily at that member's first
  // spawn (`AgentL2SeedEnsurer`), so membership below is a pure DB write and a
  // member added-but-never-spawned is a legal no-dir/no-L2 state. Guest members
  // (on another computer) get nothing on their daemon until they first spawn —
  // symmetric with the member-add door, no eager guest realization.

  // Per-agent membership + capability default-seed as one unit-of-work, through
  // the SAME keyed write-core the two member-add doors use (#task:1987) — one
  // owner of "a member always has a cap set", not a third copy. The `created`
  // flag inside it preserves no-silent-re-widen; on create it is always true.
  for (const agent of memberAgents) {
    deps.membershipPersistence.uow.atomically(
      { workspaceId: workspace.id, member: { kind: 'agent', id: agent.id } },
      tx => enrollAgentIntoWorkspace(tx.membership),
    );
  }

  const onboarding = conversations.insertChannel({
    workspaceId: workspace.id,
    // The title IS the channel's address (#task:2016). A code-owned literal, so
    // the canonical pair is taken with the throwing helper: this workspace's
    // address space was created empty a few statements ago, which is why there is
    // no 409 arm on this saga.
    title: fixedConversationTitle('Onboarding'),
  });
  for (const userId of workspaces.listUserMemberIds(workspace.id)) {
    conversations.addUser(onboarding.id, userId);
  }
  for (const agent of memberAgents) {
    conversations.addAgent(onboarding.id, agent.id);
  }
  for (const agent of memberAgents) {
    const others = memberAgents.filter(m => m.id !== agent.id);
    const onboardingMsg = messages.insertForConversation({
      conversationId: onboarding.id,
      fromKind: 'system',
      content: onboardingBody(workspace.name, agent, others),
      metadata: { subtype: systemSubtype('onboarding') },
    });
    // Deliver is on the critical path (awaited, uncaught) — a failure
    // propagates and truncates the fan-out. Only start is fire-and-forget.
    await ctx.runtimeHost.deliverMessage(onboarding.id, agent.id, onboardingMsg.id);
    ctx.runtimeHost
      .start(onboarding.id, agent.id)
      .catch(err =>
        ctx.logger.error(
          { conversationId: onboarding.id, agentId: agent.id, err },
          'onboarding spawn failed',
        ),
      );
  }

  return {
    kind: 'created',
    success: {
      // Refetch so the body reflects the owner stamped by setOwnerUserId (the
      // `workspace` DTO was captured at insert time, before the owner write).
      workspace: workspaces.get(workspace.id) ?? workspace,
      onboardingChannelId: onboarding.id,
      channel: onboarding,
    },
  };
}

/**
 * Onboarding system-message body for a newly-created workspace member. Moved
 * verbatim from the route (`onboardingBody`); pure (AgentDto → string).
 */
function onboardingBody(
  workspaceName: string,
  recipient: AgentDto,
  others: AgentDto[],
): string {
  return [
    // The workspace name is a free-text label (#task:1827) and this body goes
    // to an agent verbatim on stdin: no `#` sigil (it would spell a channel
    // reference), and a code span so a label cannot fabricate Markdown
    // structure or a reference destination.
    //
    // Participants are named with canonical references (#task:2000). This is the
    // first message an agent ever reads, and the roster below is the list it
    // will address peers from, so the token it can copy is the token that
    // actually delivers — the plain `@name` alias renders but addresses nobody.
    `You (${formatReferenceToken({ kind: 'agent', handle: recipient.name })}) just joined workspace ${inlineCode(workspaceName)}.`,
    others.length === 0
      ? `You're the only agent here right now.`
      : `Other agents in this workspace:\n${others.map(m => `- ${formatReferenceToken({ kind: 'agent', handle: m.name })} (${m.runtime})`).join('\n')}`,
    ``,
    `Your role contract is auto-loaded above (sourced from L1 system_prompt.md, shared across every workspace), and this workspace's MEMORY.md is auto-loaded as Active Workspace Memory.`,
    `Send one short greeting introducing yourself by your global role. Write global identity / role / working-style guidance to L1 system_prompt.md. Use this workspace's L2 only for durable, workspace-specific knowledge absent from the codebase, task board, and channel/thread history. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');
}
