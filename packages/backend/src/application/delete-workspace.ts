import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { StoredFileRef } from '../storage/blob-file-storage.js';
import type { BlobSweepOutcome } from '../services/attachment-service.js';
import { canGovernWorkspace } from '../permissions.js';
import {
  dispatchWorkspaceUnbind,
  resolveRegistryReconcileOutbound,
} from '../runtime/workspace-data-plane.js';

/**
 * DeleteWorkspace use case (#task:983 — P13a spec).
 *
 * Owns the full `DELETE /api/workspaces/:id` destructive cascade that previously
 * lived in the route body: idempotency / kind guard, owner-gate authorization,
 * the runtime stop fan-out (`resolveConversationRuns('conversation_closed')` +
 * per-agent hard `stop`, fire-and-forget), the best-effort attachment-blob
 * sweep, and the final workspace-row delete (DB rows cascade via FK).
 *
 * HTTP-agnostic by construction (mirror of `delete-agent.ts`): it returns a typed
 * {@link DeleteWorkspaceResult}; the route maps kind → HTTP status + body with an
 * exhaustive `switch` + `never` fallback. It never imports Hono `Context` and
 * never builds a `Response`.
 *
 * The unit of work is a single repo `delete` + FK CASCADE, so this use case
 * needs no `db.transaction` of its own. The delete-computer cascade
 * (`delete-computer.ts`) DOES need one — it commits workspaces + agents + the
 * host row as one atomic unit — which is why the pieces below are exported
 * separately: the plan/stop/sweep/publish steps are cross-process or
 * best-effort and must stay OUTSIDE a transaction, while `deleteWorkspaceRow`
 * is the only synchronous DB step and is safe to call inside one.
 */
export interface DeleteWorkspaceDeps {
  ctx: BackendContext;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  /** Needed only to capture each member agent's owning computer BEFORE the rows
   *  go away — see {@link WorkspaceTeardownPlan.runtimeStops}. */
  agents: AgentRepo;
}

export interface DeleteWorkspaceCommand {
  workspaceId: string;
  /** Route passes `getUserPrincipal(c).userId`. */
  requesterUserId: string;
}

export type DeleteWorkspaceResult =
  | { kind: 'deleted' } //                         → 204
  | { kind: 'idempotentNoop' } //                  unknown id → 204
  | { kind: 'notDeletableKind' } //                existing non-regular workspace → 409
  | { kind: 'forbidden' }; //                      owner-gate → 403

export async function deleteWorkspace(
  deps: DeleteWorkspaceDeps,
  cmd: DeleteWorkspaceCommand,
): Promise<DeleteWorkspaceResult> {
  const { ctx, workspaces } = deps;

  const workspace = workspaces.get(cmd.workspaceId);
  if (!workspace) {
    return { kind: 'idempotentNoop' };
  }
  if (workspace.workspace_kind !== 'regular') {
    return { kind: 'notDeletableKind' };
  }
  const principal: UserPrincipal = { kind: 'user', userId: cmd.requesterUserId };
  if (!canGovernWorkspace(ctx, principal, workspace.id, 'owner')) {
    return { kind: 'forbidden' };
  }

  const plan = collectWorkspaceTeardownPlan(deps, workspace.id);

  // Cross-computer slice 2 (#task:1600): the old D4.c C3 placement preflight
  // (every member agent's host must equal `workspace_host_id`) is gone — a
  // workspace's members may legitimately live on other computers. Runtime
  // stops below already route per agent (`runtimeHost.stop` resolves each
  // agent's own host), and the delete removes no daemon-side directories or
  // file contents: home AND guest computers' local roots stay behind (#1594:
  // zero implicit deletion of user data). What IS torn down now is the
  // registry IDENTITY BINDING (#task:1719): after the row delete, each
  // captured host gets a best-effort `workspace_unbind` so its
  // workspace-registry.json mapping stops participating in path-overlap
  // validation as a ghost. Unreachable hosts keep their orphan entries
  // awaiting explicit cleanup — the dispatch never blocks or reverses the
  // delete.
  stopWorkspaceRuntime(deps, plan);
  await sweepWorkspaceAttachments(deps, plan);
  deleteWorkspaceRow(deps, workspace.id);
  publishWorkspaceRemoved(deps, plan);
  await unbindWorkspaceBindings(deps, plan);
  return { kind: 'deleted' };
}

/**
 * Everything the teardown needs to know BEFORE any row is deleted.
 *
 * EVERY field here is a capture, not a hint: after the cascade the
 * `workspace_users` rows are gone (so the viewers could no longer be
 * addressed), the `conversation_agents` rows are gone (so the runtime-stop set
 * could no longer be enumerated) and the `attachments` rows are gone (so no
 * `storageKey` could be derived — a post-delete `listByChannel` returns empty
 * and the blobs would leak forever). The delete-computer cascade
 * (`delete-computer.ts`) deletes its rows inside a transaction and runs every
 * step below AFTER the commit, so a step that re-queried the DB would silently
 * become a no-op there.
 */
export interface WorkspaceTeardownPlan {
  workspaceId: string;
  conversationIds: string[];
  /**
   * The `(conversation, agent)` runs to hard-stop, each carrying the computer it
   * runs on. Members may live on other computers (#task:1600), so routing is
   * per agent — and it is CAPTURED, not looked up at stop time: the dispatcher
   * resolves `agents.host_id` → `hosts` from the DB, which is empty by the time
   * a post-commit teardown runs (#task:1616). Identity without routing is still
   * a silent no-op.
   */
  runtimeStops: { conversationId: string; agentId: string; hostId: string }[];
  /**
   * #task:1719 — the distinct hosts whose daemon registries may hold a binding
   * for this workspace: the home computer (`workspace_host_id`) plus every
   * member agent's computer (guest hosts provision local roots for
   * cross-computer members, #task:1600). CAPTURED, not looked up at unbind
   * time — after the cascade the workspace row and the membership rows are
   * gone, so a post-delete query could enumerate nothing.
   */
  unbindHostIds: string[];
  /** Storage objects to remove, captured while the rows still exist. */
  blobRefs: StoredFileRef[];
  viewerUserIds: string[];
}

export function collectWorkspaceTeardownPlan(
  deps: DeleteWorkspaceDeps,
  workspaceId: string,
): WorkspaceTeardownPlan {
  const { ctx, workspaces, conversations } = deps;
  const workspaceConversations = conversations
    .list()
    .filter(conversation => conversation.workspace_id === workspaceId);
  const conversationIds = workspaceConversations.map(conversation => conversation.id);
  // Top-level channels only — `attachments.channel_id` never points at a thread
  // (threads upload via their parent).
  const sweepChannelIds = workspaceConversations
    .filter(
      conversation =>
        conversation.kind === 'channel' || conversation.kind === 'dm_channel',
    )
    .map(conversation => conversation.id);
  const runtimeStops = conversationIds.flatMap(conversationId =>
    conversations.listAgents(conversationId).flatMap(ca => {
      const agent = deps.agents.get(ca.agent_id);
      // No agent row means nothing to route to; the run cannot exist either.
      return agent
        ? [{ conversationId, agentId: ca.agent_id, hostId: agent.host_id }]
        : [];
    }),
  );
  // #task:1719 — capture the distinct registry-binding hosts BEFORE any
  // deletion (same capture-not-hint invariant as every field above). Guest
  // daemons provision their local roots at WORKSPACE membership
  // establishment (#1594/#1600), not at conversation membership, so the
  // authoritative guest set is `workspace_members` — an agent member with no
  // conversation in this workspace still holds a binding. The runtime-stop
  // hosts are unioned in as a belt (they are always a subset in a consistent
  // DB). `workspaces.get` still answers here because the row is not deleted
  // yet.
  const workspaceRow = workspaces.get(workspaceId);
  const memberAgentHostIds = workspaces
    .listMemberAgents(workspaceId)
    .flatMap(agentId => {
      const agent = deps.agents.get(agentId);
      return agent ? [agent.host_id] : [];
    });
  const unbindHostIds = [
    ...new Set([
      ...(workspaceRow ? [workspaceRow.workspace_host_id] : []),
      ...memberAgentHostIds,
      ...runtimeStops.map(stop => stop.hostId),
    ]),
  ];
  return {
    workspaceId,
    conversationIds,
    runtimeStops,
    unbindHostIds,
    blobRefs: ctx.attachmentService.collectChannelBlobRefs(sweepChannelIds),
    viewerUserIds: workspaces.listUserMemberIds(workspaceId),
  };
}

/** Hard-stop every captured run in the workspace. Runtime-only and idempotent,
 *  and it stops by CAPTURED pairs — so it is correct both before the row delete
 *  (single-workspace path) and after a committed transaction
 *  (delete-computer cascade), where the membership rows no longer exist. */
export function stopWorkspaceRuntime(
  deps: DeleteWorkspaceDeps,
  plan: WorkspaceTeardownPlan,
): void {
  const { ctx } = deps;
  for (const conversationId of plan.conversationIds) {
    ctx.runtimeHost.resolveConversationRuns(conversationId, 'conversation_closed');
  }
  for (const { conversationId, agentId, hostId } of plan.runtimeStops) {
    void ctx.runtimeHost.stop(conversationId, agentId, { hostId }).catch(err =>
      ctx.logger.warn(
        {
          workspaceId: plan.workspaceId,
          conversationId,
          agentId,
          err,
        },
        'delete workspace: runtime stop failed (continuing)',
      ),
    );
  }
}

/** Delete physical attachment blobs by captured ref. DB rows go via CASCADE;
 *  blobs need an explicit pass. Best-effort — never blocks or reverses the
 *  delete. */
export async function sweepWorkspaceAttachments(
  deps: DeleteWorkspaceDeps,
  plan: WorkspaceTeardownPlan,
): Promise<BlobSweepOutcome> {
  const { ctx } = deps;
  const outcome = await ctx.attachmentService
    .deleteBlobs(plan.blobRefs)
    .catch((err: unknown) => ({
      attempted: plan.blobRefs.length,
      failed: plan.blobRefs.length,
      firstError: err,
    }));
  if (outcome.failed > 0) {
    // Best-effort, but never invisible: these bytes now have no row that names
    // them, so the log line is the only trace of the residue.
    ctx.logger.warn(
      {
        workspaceId: plan.workspaceId,
        blobs: outcome.attempted,
        failed: outcome.failed,
        err: outcome.firstError,
      },
      'delete workspace: attachment sweep left blobs behind (continuing)',
    );
  }
  return outcome;
}

/** The single synchronous DB step — transaction-safe by construction. */
export function deleteWorkspaceRow(
  deps: DeleteWorkspaceDeps,
  workspaceId: string,
): void {
  deps.workspaces.delete(workspaceId);
}

/**
 * The workspace is gone — tell every viewer member so their UI drops it whole,
 * list AND unread contribution (#task:1404). delete-workspace previously
 * emitted NOTHING to viewers, so a viewer with unread in the deleted workspace
 * kept a phantom workspace/total badge (the #1284 summary cache is patched in
 * place, never refetched, until this signal or a manual reload). Post-commit,
 * per-viewer on the `viewer:<id>` scope, mirroring conversation-member's
 * `viewer_workspaces_changed` shape (change/workspace_id; the wire stays
 * `unknown` and each side validates independently —
 * docs/viewer-visibility-sync-v1.md). The renderer half (#task:1404) drops the
 * removed workspace's unread contribution from the summary on this same event.
 */
export function publishWorkspaceRemoved(
  deps: DeleteWorkspaceDeps,
  plan: WorkspaceTeardownPlan,
): void {
  for (const userId of plan.viewerUserIds) {
    deps.ctx.events.publishToScope(`viewer:${userId}`, 'viewer_workspaces_changed', {
      change: 'removed',
      workspace_id: plan.workspaceId,
    });
  }
}

/**
 * #task:1719 — best-effort `workspace_unbind` fan-out to every captured host,
 * AFTER the row delete: remove each daemon's workspace-registry.json mapping
 * so the deleted id stops participating in path-overlap validation as a
 * ghost. Mapping removal ONLY — the daemon never touches directories or file
 * contents (#1594: zero implicit deletion of user data).
 *
 * Capability gate (P0-2): each dispatch first passes
 * `resolveRegistryReconcileOutbound` — current-generation attachment must
 * advertise `workspace.registry_reconcile.v1` AND still carry the pinned
 * connectionId. A host without the capability gets ZERO new traffic (an old
 * daemon strict-rejects the unknown command and drops the connection); it is
 * skipped with a structured `workspace_unbind_skipped_no_capability` log and
 * converges via the first ready-generation reconcile after upgrade.
 *
 * Concurrency (P1-1): the hosts are dispatched CONCURRENTLY (`Promise.all`,
 * each branch with its own catch), so the total added latency of this
 * fan-out is bounded by ONE dispatch timeout — not N sequential timeouts
 * when several captured daemons are unreachable.
 *
 * NEVER throws and never blocks the deleted result: an offline host (resolve
 * failed) or a failed dispatch is logged and skipped — that daemon keeps its
 * orphan entry awaiting the next ready-generation reconcile, and the unbind
 * is idempotent daemon-side, so any later re-dispatch is safe.
 *
 * `skipHostId`: the delete-computer cascade passes the host being deleted —
 * its whole registry is going away with the computer, so only OTHER hosts'
 * guest entries matter there.
 */
export async function unbindWorkspaceBindings(
  deps: DeleteWorkspaceDeps,
  plan: WorkspaceTeardownPlan,
  opts?: { skipHostId?: string },
): Promise<void> {
  const { ctx } = deps;
  const adapter = ctx.outboundFrameAdapter?.() ?? null;
  const targets = plan.unbindHostIds.filter(
    hostId => opts?.skipHostId === undefined || hostId !== opts.skipHostId,
  );
  await Promise.all(
    targets.map(async hostId => {
      try {
        const outbound = resolveRegistryReconcileOutbound(adapter, hostId);
        if (outbound.kind === 'no_capability') {
          ctx.logger.info(
            {
              event: 'workspace_unbind_skipped_no_capability',
              host_id: hostId,
              connection_id: outbound.connectionId,
              workspace_id: plan.workspaceId,
            },
            'delete workspace: daemon lacks workspace.registry_reconcile.v1; unbind withheld (converges on first post-upgrade reconcile)',
          );
          return;
        }
        if (outbound.kind === 'failed') {
          ctx.logger.warn(
            {
              event: 'workspace_unbind_failed',
              host_id: hostId,
              workspace_id: plan.workspaceId,
              code: outbound.code,
            },
            'delete workspace: host offline, registry entry stays orphaned (continuing)',
          );
          return;
        }
        const dispatched = await dispatchWorkspaceUnbind(
          outbound.adapter,
          hostId,
          outbound.connectionId,
          { workspace_ids: [plan.workspaceId] },
        );
        if (dispatched.kind === 'failed') {
          ctx.logger.warn(
            {
              event: 'workspace_unbind_failed',
              host_id: hostId,
              workspace_id: plan.workspaceId,
              code: dispatched.code,
            },
            'delete workspace: registry unbind failed, entry stays orphaned (continuing)',
          );
          return;
        }
        ctx.logger.info(
          {
            event: 'workspace_unbind',
            host_id: hostId,
            workspace_id: plan.workspaceId,
            removed: dispatched.result.removed,
            absent: dispatched.result.absent,
          },
          'delete workspace: daemon registry binding unbound',
        );
      } catch (err) {
        // Per-host containment: one host's unexpected throw must never
        // truncate the other branches or surface into the delete result.
        ctx.logger.warn(
          {
            event: 'workspace_unbind_failed',
            host_id: hostId,
            workspace_id: plan.workspaceId,
            err,
          },
          'delete workspace: registry unbind threw, entry stays orphaned (continuing)',
        );
      }
    }),
  );
}
