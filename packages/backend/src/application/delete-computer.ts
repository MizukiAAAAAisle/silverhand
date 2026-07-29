import type {
  HostAgentResource,
  HostDeleteDependents,
  HostWorkspaceResource,
} from '@silverhand/shared';
import type { AgentDto, WorkspaceDto, WorkspaceRoleDto } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { HostRepo } from '../repos/host-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { StoredFileRef } from '../storage/blob-file-storage.js';
import { canGovernWorkspace, workspaceRole } from '../permissions.js';
import {
  computeDeleteImpact,
  type AgentDeleteImpact,
} from '../read-model/agent-delete-impact.js';
import {
  toHostAgentResource,
  toHostWorkspaceResource,
} from '../read-model/host-resources.js';
import {
  collectAgentDmBlobRefs,
  deleteFailedAgentRowOnly,
  purgeAgentHostLocalFiles,
  teardownAgentControlPlaneRows,
  type DeleteAgentDeps,
} from './delete-agent.js';
import {
  collectWorkspaceTeardownPlan,
  deleteWorkspaceRow,
  publishWorkspaceRemoved,
  stopWorkspaceRuntime,
  sweepWorkspaceAttachments,
  unbindWorkspaceBindings,
  type DeleteWorkspaceDeps,
  type WorkspaceTeardownPlan,
} from './delete-workspace.js';

/**
 * DeleteComputer use case (#task:1616 + #task:1617).
 *
 * Owns `DELETE /api/hosts/:id` for user-managed computers, including the
 * explicit cascade of everything rooted on that computer: its agents and its
 * `regular` workspaces (channels, messages, memberships and attachments
 * included).
 *
 * ## Why this exists as one use case
 *
 * The route previously deleted agents one at a time and then deleted the host
 * row, with no transaction around the sequence: a mid-loop refusal left some
 * agents irreversibly gone while the computer stayed, and the 409 it returned
 * re-listed the already-deleted agents as dependents. Cascading workspaces on
 * top of that would have widened the same partial failure from "some agents" to
 * "some channels and their message history".
 *
 * ## Two phases, one authoritative read — the atomicity contract
 *
 *  1. **commit** (ONE synchronous `db.transaction`): read the CURRENT dependency
 *     set, check every precondition against it (`pending_materialization`, the
 *     per-workspace owner gate, the cascade confirmation), CAPTURE everything the
 *     teardown will need (runtime-stop pairs *and their routing*, purge targets,
 *     attachment storage refs, viewer ids), then delete the workspace rows, the
 *     agent rows and the host row as a single atomic unit. A failed precondition
 *     rolls the whole transaction back.
 *  2. **post-commit teardown** (best-effort, unrollbackable): runtime stops, the
 *     host-local `agent_files_purge`, the attachment blob deletes and the
 *     `viewer_workspaces_changed` fan-out — all of it off the captures, never off
 *     a fresh query, because the rows are gone by now.
 *
 * The read and the capture live INSIDE the transaction on purpose. The cascade
 * deletes whatever belongs to the computer at execution time (see the consent
 * note below), so a set read before the transaction could differ from the set
 * deleted inside it: the drifted-in workspace would be deleted with no captured
 * blob refs and no captured runtime pairs — leaked bytes and an orphan daemon
 * child. One authoritative read point makes that class of mismatch unstateable.
 *
 * "Off the captures" includes ROUTING, not just identity: `runtimeHost.stop`
 * normally resolves `agents.host_id` → `hosts` to pick the daemon, which
 * post-commit resolves to nothing, so every stop passes the captured `hostId`
 * (#task:1616 round-3). A capture that names WHAT to stop but not WHERE is the
 * same silent no-op in a different disguise.
 *
 * Best-effort is also not unobservable: the summary log carries
 * `purgeAttempts`/`purgeFailures` and `blobsAttempted`/`blobsFailed`, because
 * residue left by this phase can no longer be found from the DB.
 *
 * ## Non-2xx means NOTHING happened — including bytes
 *
 * Every cross-process or unrollbackable effect lives in phase 2, *after* the
 * commit. That ordering is the contract, not an optimization: the commit is the
 * single decision point, so a refusal (`hasDependents`, `pendingAgents`,
 * `workspaceForbidden`, an unmodeled FK violation) leaves the DB, the daemon's disk and the
 * blob store exactly as they were. Nothing before the commit may destroy
 * anything — an agent whose L2 tree was purged while the request then failed
 * would be a half-delete no retry can undo, which is precisely the failure mode
 * this use case exists to remove.
 *
 * The price is that phase 2 cannot report failure: by then the delete is
 * committed and the objects that could name those bytes are gone. That is the
 * right trade for a computer delete — see the purge note below — and it is
 * bounded to *leaving* residue, never to destroying more than was confirmed.
 *
 * ## Consent is one boolean, and it is not authorization
 *
 * `cascadeDependents` says "delete this computer and everything on it". It is not
 * an id snapshot: everything this cascade can reach is rooted on the computer the
 * user just condemned, so a dependency that appears between the dialog and the
 * request cannot change the CLASS of what is destroyed — an exact-id snapshot
 * would have bought only that, at the price of a second consent model (set
 * equality, a `dependents_changed` refusal, a re-confirmation screen). Discovery
 * is not this use case's job either: the dialog reads the computer's agents and
 * workspaces from `GET /api/hosts/:id/resources` first, and the `hasDependents`
 * refusal here is only a guard for a caller that skipped that step.
 *
 * What the flag does NOT do is authorize: the owner gate and the
 * pending-materialization check are re-evaluated inside the transaction against
 * current state, because those are legality questions, not consent questions.
 *
 * ## Host-local bytes are best-effort, control-plane rows are not
 *
 * Phase 2's `agent_files_purge` never blocks the delete: an unreachable daemon
 * is the very case this route exists for, and a purge failure leaves files
 * behind rather than destroying extra ones. This deliberately diverges from
 * `DELETE /api/agents/:id`'s fail-closed rule: there, refusing keeps the DB rows
 * so a retry can re-target an L2 tree that would otherwise be orphaned by a live
 * control plane. Here the control plane that could reference those bytes is
 * itself being deleted, and refusing would recreate the undeletable-computer
 * dead end (#task:1617).
 */
export interface DeleteComputerDeps {
  ctx: BackendContext;
  hosts: HostRepo;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
}

export interface DeleteComputerCommand {
  hostId: string;
  /** Route passes the session-bearer user id; the host must be theirs. */
  requesterUserId: string;
  /** The user confirmed "delete this computer and everything on it". Without it
   *  a computer that still has dependents is refused, never partially deleted. */
  cascadeDependents: boolean;
}

/** The named dependency lists carried by the `hasDependents` guard, so a caller
 *  that skipped the confirmation step still learns what it would destroy. */
export interface ComputerDeleteDependentsPayload {
  dependents: HostDeleteDependents;
  agents: HostAgentResource[];
  workspaces: HostWorkspaceResource[];
}

export type DeleteComputerResult =
  | { kind: 'deleted' }
  | { kind: 'notFound' }
  | { kind: 'provisioningSourceNotSupported' }
  | { kind: 'pendingAgents'; pendingAgents: number }
  | { kind: 'hasDependents'; payload: ComputerDeleteDependentsPayload }
  | { kind: 'workspaceForbidden'; workspaces: HostWorkspaceResource[] };

/**
 * Thrown inside the commit transaction to roll it back when a precondition fails.
 * Never escapes this module: every refusal is raised from the same authoritative
 * read, so each reason maps straight to its typed result and the caller cannot
 * tell a mid-request change from a pre-request one.
 */
type CommitRefusal =
  | { reason: 'hasDependents'; payload: ComputerDeleteDependentsPayload }
  | { reason: 'pendingAgents'; pendingAgents: number }
  | { reason: 'workspaceForbidden'; workspaces: HostWorkspaceResource[] }
  | { reason: 'hostGone' };

class CommitPreconditionFailed extends Error {
  constructor(readonly refusal: CommitRefusal) {
    super(refusal.reason);
  }
}

interface ComputerDeletePlan {
  hostAgents: AgentDto[];
  pendingAgents: number;
  hostWorkspaces: WorkspaceDto[];
  /** workspace id → the requester's membership role (the resource fact the
   *  refusal payloads carry). */
  workspaceRoles: Map<string, WorkspaceRoleDto | null>;
  /** workspace id → owner-gate verdict for the requester (the legality answer,
   *  taken from the same ACL the workspace-delete route uses). */
  workspaceDeletable: Map<string, boolean>;
}

/** One agent's teardown, fully captured before its rows are deleted. */
interface AgentTeardown {
  agent: AgentDto;
  impact: AgentDeleteImpact;
  blobRefs: StoredFileRef[];
}

/** Everything the post-commit teardown will act on, captured inside the
 *  transaction because every source row it derives from is deleted there. */
interface ComputerTeardownCapture {
  workspacePlans: WorkspaceTeardownPlan[];
  agentTeardowns: AgentTeardown[];
}

export async function deleteComputer(
  deps: DeleteComputerDeps,
  cmd: DeleteComputerCommand,
): Promise<DeleteComputerResult> {
  const { ctx, hosts } = deps;

  const host = hosts.get(cmd.hostId);
  if (!host || host.user_id !== cmd.requesterUserId) {
    return { kind: 'notFound' };
  }
  if (host.provisioning_source !== 'user_invite' || host.kind !== 'remote') {
    return { kind: 'provisioningSourceNotSupported' };
  }

  const agentDeps: DeleteAgentDeps = {
    ctx,
    agents: deps.agents,
    workspaces: deps.workspaces,
    conversations: deps.conversations,
    conversationInboxes: deps.conversationInboxes,
  };
  const workspaceDeps: DeleteWorkspaceDeps = {
    ctx,
    workspaces: deps.workspaces,
    conversations: deps.conversations,
    agents: deps.agents,
  };

  // ── phase 1: read, check, capture and delete — one transaction ─────
  let capture: ComputerTeardownCapture;
  let plan: ComputerDeletePlan;
  try {
    const committed = ctx.db.transaction(() => {
      // THE authoritative read. Every refusal below is raised from this one
      // snapshot and rolls the transaction back, and the capture that phase 2
      // acts on is derived from the very same snapshot the deletes consume.
      const txPlan = buildPlan(deps, cmd);

      // A materialization still in flight cannot be torn down safely (the
      // reserve → flip transaction would race). Transient, so it answers
      // "retry" rather than offering a cascade.
      if (txPlan.pendingAgents > 0) {
        throw new CommitPreconditionFailed({
          reason: 'pendingAgents',
          pendingAgents: txPlan.pendingAgents,
        });
      }
      if (
        (txPlan.hostAgents.length > 0 || txPlan.hostWorkspaces.length > 0) &&
        !cmd.cascadeDependents
      ) {
        throw new CommitPreconditionFailed({
          reason: 'hasDependents',
          payload: buildPayload(txPlan),
        });
      }
      const unauthorized = unauthorizedWorkspaces(txPlan);
      if (unauthorized.length > 0) {
        throw new CommitPreconditionFailed({
          reason: 'workspaceForbidden',
          workspaces: unauthorized,
        });
      }

      // Capture BEFORE the deletes and inside the same transaction: after the
      // FK cascade there is no row left to derive a storage key, a runtime pair
      // or a viewer id from (read-only, so it cannot destroy anything even
      // though a later precondition could still roll this back).
      const txCapture = captureTeardown(agentDeps, workspaceDeps, txPlan);

      for (const workspacePlan of txCapture.workspacePlans) {
        deleteWorkspaceRow(workspaceDeps, workspacePlan.workspaceId);
      }
      for (const agent of txPlan.hostAgents) {
        const current = deps.agents.get(agent.id);
        if (!current) continue;
        if (current.materialization_status === 'failed') {
          deleteFailedAgentRowOnly(ctx, deps.agents, current);
          continue;
        }
        // Recomputed here rather than reused from the capture: the workspace
        // rows deleted just above are already gone, so the membership teardown
        // must not work off a pre-delete impact.
        const impact: AgentDeleteImpact = computeDeleteImpact(agentDeps, agent.id);
        teardownAgentControlPlaneRows(agentDeps, agent.id, impact);
      }
      if (!hosts.deleteOwnedUserInvite({ hostId: cmd.hostId, userId: cmd.requesterUserId })) {
        // Someone deleted the host row concurrently. Roll back and answer 404
        // rather than reporting a success this request did not cause.
        throw new CommitPreconditionFailed({ reason: 'hostGone' });
      }
      return { capture: txCapture, plan: txPlan };
    })();
    capture = committed.capture;
    plan = committed.plan;
  } catch (err) {
    if (err instanceof CommitPreconditionFailed) {
      return refusalToResult(err.refusal);
    }
    // Anything else rolled the whole transaction back — including an FK
    // violation, which here can only mean the schema holds a RESTRICT reference
    // this cascade does not model (drift or a bug). It FAILS LOUD. Dressing it
    // up as a user-actionable `has_dependents` would hand the UI a dead end
    // (blocked, nothing to remove, retry forever) and hide the invariant
    // violation.
    throw err;
  }

  // ── phase 2: post-commit teardown (best-effort, capture-driven) ────
  let blobsAttempted = 0;
  let blobsFailed = 0;
  // The two teardown authorities overlap on the MAIN path: an on-host agent that
  // is a member of a channel in a deleted workspace appears in the workspace
  // plan's captured pairs AND in its own live runs. Neither loop can be dropped
  // (the workspace plan also stops agents placed on OTHER computers; the agent
  // teardown also stops runs in workspaces not rooted here), so the union is
  // dispatched exactly once per pair rather than twice-and-idempotent.
  const stopped = new Set<string>();
  const stopKey = (conversationId: string, agentId: string): string =>
    `${conversationId}\u0000${agentId}`;
  for (const workspacePlan of capture.workspacePlans) {
    for (const pair of workspacePlan.runtimeStops) {
      stopped.add(stopKey(pair.conversationId, pair.agentId));
    }
    stopWorkspaceRuntime(workspaceDeps, workspacePlan);
    const swept = await sweepWorkspaceAttachments(workspaceDeps, workspacePlan);
    blobsAttempted += swept.attempted;
    blobsFailed += swept.failed;
    publishWorkspaceRemoved(workspaceDeps, workspacePlan);
    // #task:1719 — best-effort registry unbind on OTHER hosts' daemons (guest
    // entries from cross-computer members). The host being deleted is skipped:
    // its whole registry leaves with the computer, and its daemon is exactly
    // the unreachable one this route exists for.
    await unbindWorkspaceBindings(workspaceDeps, workspacePlan, {
      skipHostId: cmd.hostId,
    });
  }
  let purgeAttempts = 0;
  let purgeFailures = 0;
  for (const teardown of capture.agentTeardowns) {
    for (const live of teardown.impact.running_conversation_agents) {
      if (stopped.has(stopKey(live.conversation_id, teardown.agent.id))) continue;
      stopped.add(stopKey(live.conversation_id, teardown.agent.id));
      // `{ hostId }` is the captured routing authority: the dispatcher would
      // otherwise re-read `agents`/`hosts`, which this cascade has just
      // deleted, and the stop would degrade to a warning while the daemon's
      // child keeps running.
      await ctx.runtimeHost
        .stop(live.conversation_id, teardown.agent.id, {
          hostId: teardown.agent.host_id,
        })
        .catch(err =>
          ctx.logger.warn(
            {
              conversationId: live.conversation_id,
              agentId: teardown.agent.id,
              err,
            },
            'delete computer cascade: stop failed (continuing)',
          ),
        );
    }
    // The whole computer is going away, so the host-local purge is BEST-EFFORT
    // — for an unreachable daemon (exactly the lost-computer case this delete
    // exists for) AND for a reachable daemon that only purges part of the set.
    // See the module header: it runs after the commit precisely so it can never
    // destroy bytes for a request that then fails.
    purgeAttempts += 1;
    const purge = await purgeAgentHostLocalFiles(
      agentDeps,
      teardown.agent,
      teardown.impact,
    ).catch(
      (err: unknown) =>
        ({ kind: 'failClosed', code: 'purge_threw', error: String(err) }) as const,
    );
    if (purge.kind === 'failClosed') {
      purgeFailures += 1;
      ctx.logger.warn(
        {
          hostId: cmd.hostId,
          agentId: teardown.agent.id,
          code: purge.code,
          err: purge.error,
        },
        'delete computer cascade: host-local purge failed (continuing; files stay on that computer)',
      );
    }
    const swept = await ctx.attachmentService
      .deleteBlobs(teardown.blobRefs)
      .catch((err: unknown) => ({
        attempted: teardown.blobRefs.length,
        failed: teardown.blobRefs.length,
        firstError: err,
      }));
    blobsAttempted += swept.attempted;
    blobsFailed += swept.failed;
    if (swept.failed > 0) {
      ctx.logger.warn(
        {
          hostId: cmd.hostId,
          agentId: teardown.agent.id,
          blobs: swept.attempted,
          failed: swept.failed,
          err: swept.firstError,
        },
        'delete computer cascade: DM attachment sweep left blobs behind (continuing)',
      );
    }
  }
  ctx.logger.info(
    {
      hostId: cmd.hostId,
      cascadedAgents: plan.hostAgents.length,
      cascadedWorkspaces: plan.hostWorkspaces.length,
      purgeAttempts,
      purgeFailures,
      blobsAttempted,
      blobsFailed,
    },
    'user-managed computer deleted with its dependents',
  );
  return { kind: 'deleted' };
}

function buildPlan(
  deps: DeleteComputerDeps,
  cmd: DeleteComputerCommand,
): ComputerDeletePlan {
  const { ctx, agents, workspaces } = deps;
  const principal: UserPrincipal = { kind: 'user', userId: cmd.requesterUserId };
  const hostAgents = agents.listByHost(cmd.hostId);
  const hostWorkspaces = workspaces.listRegularByHost(cmd.hostId);
  const workspaceDeletable = new Map<string, boolean>(
    hostWorkspaces.map(workspace => [
      workspace.id,
      canGovernWorkspace(ctx, principal, workspace.id, 'owner'),
    ]),
  );
  return {
    hostAgents,
    pendingAgents: hostAgents.filter(
      agent => agent.materialization_status === 'pending_materialization',
    ).length,
    hostWorkspaces,
    workspaceRoles: new Map(
      hostWorkspaces.map(workspace => [
        workspace.id,
        workspaceRole(ctx, principal, workspace.id),
      ]),
    ),
    workspaceDeletable,
  };
}

/**
 * Snapshot every source row the post-commit teardown will need. Read-only and
 * synchronous: it must not be able to change anything, because it runs before
 * the commit decides whether the delete happens at all.
 */
function captureTeardown(
  agentDeps: DeleteAgentDeps,
  workspaceDeps: DeleteWorkspaceDeps,
  plan: ComputerDeletePlan,
): ComputerTeardownCapture {
  const agentTeardowns: AgentTeardown[] = [];
  for (const agent of plan.hostAgents) {
    // A `failed` agent has no dependent rows, no runtime and no host-local tree
    // (`deleteFailedAgentRowOnly`) — nothing to capture or tear down.
    if (agent.materialization_status === 'failed') continue;
    const impact = computeDeleteImpact(agentDeps, agent.id);
    agentTeardowns.push({
      agent,
      impact,
      blobRefs: collectAgentDmBlobRefs(agentDeps, impact),
    });
  }
  return {
    workspacePlans: plan.hostWorkspaces.map(workspace =>
      collectWorkspaceTeardownPlan(workspaceDeps, workspace.id),
    ),
    agentTeardowns,
  };
}

/** Map a rolled-back commit precondition to its typed result. The lists it
 *  carries were read inside the transaction, so they describe the state the
 *  refusal was actually decided on. */
function refusalToResult(refusal: CommitRefusal): DeleteComputerResult {
  switch (refusal.reason) {
    case 'hasDependents':
      return { kind: 'hasDependents', payload: refusal.payload };
    case 'pendingAgents':
      return { kind: 'pendingAgents', pendingAgents: refusal.pendingAgents };
    case 'workspaceForbidden':
      return { kind: 'workspaceForbidden', workspaces: refusal.workspaces };
    case 'hostGone':
      return { kind: 'notFound' };
  }
}

function unauthorizedWorkspaces(
  plan: ComputerDeletePlan,
): HostWorkspaceResource[] {
  return plan.hostWorkspaces
    .filter(workspace => !plan.workspaceDeletable.get(workspace.id))
    .map(workspace =>
      toHostWorkspaceResource(workspace, plan.workspaceRoles.get(workspace.id) ?? null),
    );
}

function buildPayload(plan: ComputerDeletePlan): ComputerDeleteDependentsPayload {
  return {
    dependents: {
      agents: plan.hostAgents.length,
      workspaces: plan.hostWorkspaces.length,
    },
    agents: plan.hostAgents.map(toHostAgentResource),
    workspaces: plan.hostWorkspaces.map(workspace =>
      toHostWorkspaceResource(workspace, plan.workspaceRoles.get(workspace.id) ?? null),
    ),
  };
}
