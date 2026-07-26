import {
  DeleteAgentInputSchema,
  type AgentMaterializationStatus,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { StoredFileRef } from '../storage/blob-file-storage.js';
import { canEditAgent, canViewAgent } from '../permissions.js';
import {
  dispatchAgentFilesPurge,
  resolveOutboundForHost,
  type DataPlaneHttpStatus,
} from '../runtime/workspace-data-plane.js';
import {
  computeDeleteImpact,
  type AgentDeleteImpact,
} from '../read-model/agent-delete-impact.js';

/**
 * DeleteAgent use case (#task:982 — P11a spec).
 *
 * Owns the full `DELETE /api/agents/:id` destructive cascade that previously
 * lived in the route body: materialization-status dispatch, authorization,
 * confirm gate, hard-stop of running conversation agents, the fail-closed
 * daemon `agent_files_purge` sequence (no DB row is deleted until the purge
 * acks), the regular-membership/conversation teardown, the DM
 * attachment sweep, and the final agent-row delete.
 *
 * HTTP-agnostic by construction (spec §1.1): it returns a typed
 * {@link DeleteAgentResult}; the route maps kind → HTTP status + body. It never
 * imports Hono `Context` and never builds a `Response`. The confirm gate parses
 * the raw command body with `DeleteAgentInputSchema` INSIDE the active branch —
 * exactly mirroring the route, which only validated confirm after the
 * pending/failed dispatch, so a failed row + malformed body stays 204 (not 400).
 *
 * There is intentionally NO outer `db.transaction` here: the original handler
 * tore down sequentially (per-conversation `removeAgent`, then `removeMember`,
 * then `agents.delete` relying on FK cascade), and this route deletes exactly
 * one agent, so a partial teardown cannot straddle two independent objects.
 * The delete-computer cascade is different — it deletes N agents plus the
 * computer as ONE user-visible act — so `teardownAgentControlPlaneRows` below
 * is factored out as a synchronous, transaction-safe step it can commit
 * together with the workspace and host rows (`delete-computer.ts`).
 */

// DELETE opts in to ALL three materialization statuses so the dispatch below can
// reach `pending_materialization → 409` and `failed → 204`. Without the opt-in,
// `canViewAgent`'s default-active filter would 204 (idempotent unknown id) every
// DELETE on a non-active row, hiding the management surface. Intrinsic to the
// delete dispatch semantics, so it lives with the use case (Cindy ruling).
const DELETE_INCLUDE_STATUSES: AgentMaterializationStatus[] = [
  'active',
  'pending_materialization',
  'failed',
];

export interface DeleteAgentDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
}

export interface DeleteAgentCommand {
  agentId: string;
  /** Route passes `getUserPrincipal(c).userId`. */
  requesterUserId: string;
  /**
   * Raw parsed JSON body (`await c.req.json().catch(() => ({}))`). The use case
   * validates it with `DeleteAgentInputSchema` only inside the active branch, so
   * the parse ordering matches the route exactly (HTTP-agnostic: it touches no
   * Hono/Response, just the command body).
   */
  body: unknown;
}

/**
 * Named result — no HTTP status policy. The route maps kind → status/body with
 * an exhaustive `switch` + `never` fallback. The fail-closed sources
 * (outbound resolve / purge dispatch / partial purge) all
 * collapse into `failClosed`, whose body is uniformly `{ error, code }` at the
 * carried `status`.
 */
export type DeleteAgentResult =
  | { kind: 'deleted' }
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'pendingInFlight' }
  | { kind: 'confirmRequired' }
  | { kind: 'failClosed'; error: string; code: string; status: DataPlaneHttpStatus };

export async function deleteAgent(
  deps: DeleteAgentDeps,
  cmd: DeleteAgentCommand,
): Promise<DeleteAgentResult> {
  const { ctx, agents } = deps;
  const id = cmd.agentId;
  const principal: UserPrincipal = { kind: 'user', userId: cmd.requesterUserId };

  const agent = agents.get(id);
  if (!agent) return { kind: 'notFound' }; // idempotent on unknown id
  if (
    !canViewAgent(ctx, principal, agent.id, {
      includeStatuses: DELETE_INCLUDE_STATUSES,
    })
  ) {
    return { kind: 'notFound' };
  }
  if (!canEditAgent(ctx, principal, agent.id)) {
    return { kind: 'forbidden' };
  }

  // Materialization-aware dispatch:
  //   pending_materialization → 409 (a reserve→flip is mid-flight; deleting now
  //     would race the L3a/L3b tx).
  //   failed → 204 row-only delete (failed rows have NO dependent rows; skip the
  //     entire stop/sweep/purge flow, just drop the agents row — DB-only, no
  //     remote demolish).
  //   active → full destructive flow below.
  if (agent.materialization_status === 'pending_materialization') {
    return { kind: 'pendingInFlight' };
  }
  if (agent.materialization_status === 'failed') {
    deleteFailedAgentRowOnly(ctx, agents, agent);
    return { kind: 'deleted' };
  }

  // ── active branch: full destructive flow (verbatim) ──────────────
  // confirm gate — parsed here (not in the route) so it only fires on the active
  // branch, preserving the failed-row-with-malformed-body → 204 behavior.
  const parsed = DeleteAgentInputSchema.safeParse(cmd.body);
  if (!parsed.success) {
    return { kind: 'confirmRequired' };
  }

  const impact = computeDeleteImpact(deps, id);

  // 1. Hard-stop every running conversation_agent. Must precede any DB delete.
  //    Runtime-only (does not mutate membership / delete the agent row), so it
  //    is safe to run before the purge fail-closed gate.
  for (const live of impact.running_conversation_agents) {
    await ctx.runtimeHost
      .stop(live.conversation_id, id)
      .catch(err =>
        ctx.logger.warn(
          { conversationId: live.conversation_id, agentId: id, err },
          'delete: stop failed (continuing)',
        ),
      );
  }

  // 2. Purge the agent's host-local files on the OWNING daemon BEFORE any DB
  //    mutation. §3.3 fail-fast commit boundary: DB rows are NOT deleted until
  //    the purge acks. The daemon resolves each regular workspace from its
  //    registry alone; a membership it never provisioned comes back as
  //    `skipped_unprovisioned`, which fails the delete closed instead of
  //    silently leaving an L2 tree on disk while we delete the DB row.
  const purge = await purgeAgentHostLocalFiles(deps, agent, impact);
  if (purge.kind === 'failClosed') return purge;

  // 3. Purge acked — commit the DB teardown. The same control-plane teardown is
  //    reused by delete-computer's explicit agent cascade after the user has
  //    chosen to remove the whole computer; that path may skip host-local purge
  //    when the daemon is permanently unreachable, but the DB teardown stays one
  //    source of truth.
  await teardownAgentControlPlane(deps, id, impact);

  ctx.logger.info(
    {
      agentId: id,
      agentName: agent.name,
      dmChannelId: impact.dm_channel?.id ?? null,
      regularWorkspaces: impact.regular_memberships.length,
      stoppedConversations: impact.running_conversation_agents.length,
      purgedCount: purge.purgedCount,
      skippedUnprovisioned: purge.skippedUnprovisioned,
    },
    'agent deleted',
  );
  return { kind: 'deleted' };
}

export function deleteFailedAgentRowOnly(
  ctx: BackendContext,
  agents: AgentRepo,
  agent: NonNullable<ReturnType<AgentRepo['get']>>,
): void {
  agents.delete(agent.id);
  ctx.logger.info(
    {
      agentId: agent.id,
      agentName: agent.name,
      failedCode: agent.materialization_failed_code,
    },
    'failed agent row deleted (D5: row-only, no dependents)',
  );
}

export async function purgeAgentHostLocalFiles(
  deps: DeleteAgentDeps,
  agent: NonNullable<ReturnType<AgentRepo['get']>>,
  impact: AgentDeleteImpact,
): Promise<
  | { kind: 'purged'; purgedCount: number; skippedUnprovisioned: number }
  | { kind: 'failClosed'; error: string; code: string; status: DataPlaneHttpStatus }
> {
  const { ctx } = deps;
  // #task:1612 — the purge performs NO workspace provision: the registry
  // is the sole authority, and the daemon's agent_files_purge already
  // reports an unbound workspace as skipped_unprovisioned (typed), which
  // keeps the DB rows and fails the delete closed. The retired pre-purge
  // backfill would have MINTED an empty root on the agent's computer just
  // to delete it.
  const outbound = resolveOutboundForHost(
    ctx.outboundFrameAdapter?.() ?? null,
    agent.host_id,
  );
  if (outbound.kind === 'failed') {
    return {
      kind: 'failClosed',
      error: outbound.message,
      code: outbound.code,
      status: outbound.status,
    };
  }
  const purge = await dispatchAgentFilesPurge(
    outbound.adapter,
    agent.host_id,
    outbound.connectionId,
    {
      agent_id: agent.id,
      scope: 'all',
      workspace_ids: impact.regular_memberships.map(ws => ws.id),
    },
  );
  if (purge.kind === 'failed') {
    return {
      kind: 'failClosed',
      error: purge.message,
      code: purge.code,
      status: purge.status,
    };
  }
  // An incomplete purge is a failure, not a success. If the daemon skipped any
  // targeted workspace, its L2 tree was NOT removed — keep the agent + membership
  // rows so the un-purged tree isn't orphaned and a retry can re-target it.
  if (purge.result.skipped_unprovisioned > 0) {
    return {
      kind: 'failClosed',
      error: `agent files purge incomplete: ${purge.result.skipped_unprovisioned} workspace(s) unresolved on the daemon`,
      code: 'partial_purge',
      status: 503,
    };
  }
  return {
    kind: 'purged',
    purgedCount: purge.result.purged_count,
    skippedUnprovisioned: purge.result.skipped_unprovisioned,
  };
}

async function teardownAgentControlPlane(
  deps: DeleteAgentDeps,
  agentId: string,
  impact: AgentDeleteImpact,
): Promise<void> {
  // Sweep DM blobs before dropping rows. DB rows cascade through
  // agent -> agent_home -> conversations, but physical files need an explicit
  // pass. Best-effort — must not block the 204.
  await sweepAgentDmAttachments(deps, agentId, impact);
  teardownAgentControlPlaneRows(deps, agentId, impact);
}

/** The DM channels whose attachment blobs the delete must sweep. Captured
 *  BEFORE any row delete: afterwards the conversation rows are gone and the
 *  sweep could no longer enumerate them. */
export function collectAgentDmChannelIds(
  deps: DeleteAgentDeps,
  impact: AgentDeleteImpact,
): string[] {
  const { conversations } = deps;
  return impact.owned_home
    ? conversations
        .listAllDmChannelsForWorkspace(impact.owned_home.id)
        .map(dm => dm.id)
    : [];
}

/** The DM storage objects the delete must remove, captured while the
 *  `attachments` rows still exist. Required by any caller that deletes its rows
 *  inside a transaction and sweeps after the commit (delete-computer): by then
 *  no row is left to derive a `storageKey` from. */
export function collectAgentDmBlobRefs(
  deps: DeleteAgentDeps,
  impact: AgentDeleteImpact,
): StoredFileRef[] {
  return deps.ctx.attachmentService.collectChannelBlobRefs(
    collectAgentDmChannelIds(deps, impact),
  );
}

/** Best-effort blob sweep for the single-agent path, whose rows still exist at
 *  call time. Never blocks or reverses the delete — but a swallowed storage
 *  failure is logged, because the rows that could name those bytes are gone. */
export async function sweepAgentDmAttachments(
  deps: DeleteAgentDeps,
  agentId: string,
  impact: AgentDeleteImpact,
): Promise<void> {
  const { ctx } = deps;
  const refs = collectAgentDmBlobRefs(deps, impact);
  const outcome = await ctx.attachmentService
    .deleteBlobs(refs)
    .catch((err: unknown) => ({
      attempted: refs.length,
      failed: refs.length,
      firstError: err,
    }));
  if (outcome.failed > 0) {
    ctx.logger.warn(
      { agentId, blobs: outcome.attempted, failed: outcome.failed, err: outcome.firstError },
      'delete agent: DM attachment sweep left blobs behind (continuing)',
    );
  }
}

/**
 * The agent's whole control-plane row teardown — SYNCHRONOUS by construction so
 * the delete-computer cascade can commit it inside one `db.transaction`
 * together with the workspace and host rows (`delete-computer.ts`). Anything
 * cross-process (runtime stop, host-local purge) or unrollbackable (blob sweep)
 * stays outside; putting it in the transaction would only manufacture a fake
 * atomicity where the DB rolls back but remote bytes are already gone.
 */
export function teardownAgentControlPlaneRows(
  deps: DeleteAgentDeps,
  agentId: string,
  impact: AgentDeleteImpact,
): void {
  const { workspaces, conversations, agents } = deps;

  // Remove from every regular workspace and its conversations.
  for (const ws of impact.regular_memberships) {
    const workspace = workspaces.get(ws.id);
    if (!workspace) continue;
    for (const conversation of conversations.list()) {
      if (conversation.workspace_id === workspace.id) {
        conversations.removeAgent(conversation.id, agentId);
      }
    }
    workspaces.removeMember(workspace.id, agentId);
  }

  // Drop the agent. owner_agent_id ON DELETE CASCADE removes its agent_home
  // subtree; regular conversation history keeps deleted sender rows via SET
  // NULL on messages.from_agent_id.
  agents.delete(agentId);
}
