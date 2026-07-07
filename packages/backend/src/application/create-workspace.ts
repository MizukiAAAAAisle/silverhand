import { type AgentDto, systemSubtype } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';
import {
  type DataPlaneFailure,
  resolveOutboundForHost,
  dispatchWorkspaceProvision,
} from '../runtime/workspace-data-plane.js';
import { seedMemberAgentL2 } from './agent-l2-seed.js';
import { isWorkspaceNameAvailable } from './name-availability.js';

/**
 * CreateWorkspace provisioning saga.
 *
 * Owns the whole `POST /api/workspaces` orchestration that previously lived in
 * the route body: dup-name guard, placement resolution
 * (`assertOwnedActiveHost` / `resolveOwnedLocalForUser` / per-member
 * `assertAgentMatchesHost`), daemon `workspace_provision` BEFORE the row insert
 * (no orphan row), the workspace row + owner/member writes, the L2-seed-all-
 * before-any-agent-membership ordering red line, the per-agent
 * `insertMembership + seedDefaults` unit-of-work, and the onboarding fan-out.
 *
 * HTTP-agnostic by construction (spec §1.1 / §4): it returns a typed
 * {@link CreateWorkspaceResult}; the route maps result kind → HTTP status +
 * body. It never imports Hono `Context` and never builds a `Response`. The
 * `transportFailed` arm carries the shared {@link DataPlaneFailure} triple
 * (`code` / `message` / `status`) verbatim — that `status` is owned by the
 * `workspace-data-plane` taxonomy (`mapDataPlaneError`), a transport-failure
 * render hint, NOT an HTTP policy this use case invents (spec §3.2, decision A).
 *
 * This is NOT a single-commit use case: it is a multi-step saga with several
 * DB writes and explicit accepted residue (spec §2/§2.1). The transaction
 * granularity is preserved exactly — the workspace row + owner/user members are
 * written before the L2 seeds; a partial seed failure leaves them as accepted
 * residue with agent membership still at 0 and no onboarding; only after all
 * seeds succeed does each agent get its own `insertMembership + seedDefaults`
 * transaction. Nothing is collapsed into one big transaction.
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
};

export type CreateWorkspaceCommand = {
  name: string;
  description: string | null;
  /** Caller-PROPOSED root, forwarded verbatim as `requested_path`; never interpreted here. */
  workspacePath?: string;
  workspaceHostId?: string;
  memberAgentIds: string[];
  memberUserIds: string[];
  /** Route passes `requireViewerUserId(c)`. */
  viewerUserId: string;
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
  | { kind: 'placementError'; err: unknown }
  | { kind: 'transportFailed'; failure: DataPlaneFailure };

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

  // The backend NEVER interprets a caller-proposed path (no validate / stat /
  // mkdir): it forwards it verbatim as `requested_path`; the daemon binds it.
  const requestedPath = cmd.workspacePath?.trim() || undefined;

  // Placement (pure decision, may throw the placement layer's typed errors).
  // Caller host → assertOwnedActiveHost; omitted → resolveOwnedReadyForPlacement
  // (0/1/N policy across every ready computer). Member agents must all match the owning host. Order is
  // load-bearing — keep the resolve → member-filter → assert sequence verbatim.
  let workspaceHostId: string;
  let memberAgents: AgentDto[];
  let memberUserIds: string[];
  try {
    workspaceHostId = cmd.workspaceHostId
      ? ctx.placement.assertOwnedActiveHost(cmd.workspaceHostId, cmd.viewerUserId).id
      : ctx.placement.resolveOwnedReadyForPlacement(cmd.viewerUserId).id;
    memberAgents = cmd.memberAgentIds
      .map(id => agents.get(id))
      .filter((agent): agent is AgentDto => agent !== null);
    memberUserIds = cmd.memberUserIds.filter(id => users.get(id) !== null);
    for (const agent of memberAgents) {
      ctx.placement.assertAgentMatchesHost(agent.id, workspaceHostId);
    }
  } catch (err) {
    return { kind: 'placementError', err };
  }

  // Provision the workspace fs on the owning daemon BEFORE inserting the row:
  // pre-generate the id, persist only on a successful bind. Daemon offline /
  // typed failure → fail fast, NO orphan row (spec §2.1).
  const outbound = resolveOutboundForHost(
    ctx.outboundFrameAdapter?.() ?? null,
    workspaceHostId,
  );
  if (outbound.kind === 'failed') return { kind: 'transportFailed', failure: outbound };

  const workspaceId = workspaces.newWorkspaceId();
  const provision = await dispatchWorkspaceProvision(
    outbound.adapter,
    workspaceHostId,
    outbound.connectionId,
    {
      workspace_id: workspaceId,
      kind: 'regular',
      ...(requestedPath ? { requested_path: requestedPath } : {}),
    },
  );
  if (provision.kind === 'failed') return { kind: 'transportFailed', failure: provision };

  const workspace = workspaces.insert({
    id: workspaceId,
    name: cmd.name,
    description: cmd.description,
    workspacePath: provision.result.bound_workspace_path,
    workspaceHostId,
  });

  // Graded-permissions (v40): the creator is the workspace OWNER; additional
  // members join as plain `member` (no implicit admin). `setOwnerUserId` stamps
  // the denormalized pointer AND promotes the role in one tx.
  workspaces.addUserMember(workspace.id, cmd.viewerUserId, 'owner');
  workspaces.setOwnerUserId(workspace.id, cmd.viewerUserId);
  for (const userId of memberUserIds) {
    workspaces.addUserMember(workspace.id, userId);
  }

  // Ordering red line (spec §2.1): seed EVERY member's L2 on the owning daemon
  // BEFORE inserting ANY agent `workspace_members` row, so a late seed failure
  // never leaves a PARTIAL set. On failure the workspace row + user members
  // remain as accepted residue (no 2PC) and agent membership stays at 0.
  for (const agent of memberAgents) {
    const seed = await seedMemberAgentL2(
      ctx,
      workspaceHostId,
      { id: workspace.id, workspace_path: workspace.workspace_path },
      agent.id,
      { ensureProvisioned: false },
    );
    if (seed.kind === 'failed') return { kind: 'transportFailed', failure: seed };
  }

  // Per-agent membership + capability default-seed as one unit-of-work. The
  // `created` flag preserves no-silent-re-widen; on create it is always true.
  for (const agent of memberAgents) {
    ctx.db.transaction(() => {
      const { created } = workspaces.insertMembership(workspace.id, agent.id);
      if (created) {
        new AgentCapabilityRepo(ctx.db).seedDefaults(workspace.id, agent.id);
      }
    })();
  }

  const onboarding = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'Onboarding',
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
    `You (@${recipient.name}) just joined workspace #${workspaceName}.`,
    others.length === 0
      ? `You're the only agent here right now.`
      : `Other agents in this workspace:\n${others.map(m => `- @${m.name} (${m.runtime})`).join('\n')}`,
    ``,
    `Your role contract is auto-loaded above (sourced from L1 system_prompt.md, shared across every workspace), and this workspace's MEMORY.md is auto-loaded as Active Workspace Memory.`,
    `Send one short greeting introducing yourself by your global role. As you work, write by scope: global identity / role / working-style guidance → update L1 system_prompt.md; this workspace's collaboration, tasks, project facts, or work logs → update L2 MEMORY.md / notes/. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');
}
