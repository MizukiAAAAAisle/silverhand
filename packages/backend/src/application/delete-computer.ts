import type {
  HostAgentResource,
  HostDeleteDependents,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type {
  AgentTeardownCapture,
  AgentTeardownFacts,
  AgentTeardownPersistence,
  AgentRuntimeSessionFacts,
} from './agent-teardown-ports.js';
import { teardownFactsToHostAgentResource } from '../read-model/host-resources.js';
import {
  isRunningSession,
  purgeAgentHostLocalFiles,
  sweepStoredBlobs,
} from './delete-agent.js';

/**
 * DeleteComputer use case (#task:1616 + #task:1617).
 *
 * Owns `DELETE /api/hosts/:id` for user-managed computers, including the
 * explicit cascade of everything rooted on that computer: its agents (their
 * conversations, memberships and DM attachments included).
 *
 * relocation-v1 §7-4 — a `regular` workspace is NO LONGER rooted on a computer.
 * It has no `workspace_host_id` and no host-local directory: its per-agent
 * bundles resolve to a terminal deterministic agent-centric coordinate on each
 * MEMBER's own computer. So deleting a computer no longer cascades workspaces —
 * there is no workspace whose files live here, and the DB-backed workspace /
 * channel / message content is computer-independent. The member agents placed
 * here are still deleted (below), which is the same outcome as deleting those
 * agents individually; a workspace left with no members survives exactly as it
 * does today in that case. §6 removed the last workspace-shaped field from the
 * refusal payloads with the epoch cut, so nothing here counts or names a
 * workspace.
 *
 * ## Why this exists as one use case
 *
 * The route previously deleted agents one at a time and then deleted the host
 * row, with no transaction around the sequence: a mid-loop refusal left some
 * agents irreversibly gone while the computer stayed, and the 409 it returned
 * re-listed the already-deleted agents as dependents.
 *
 * ## Two phases, one authoritative read — the atomicity contract
 *
 *  1. **commit** (ONE `atomicallyForComputer` scope — the SAME teardown
 *     UnitOfWork `DELETE /api/agents/:id` uses, #task:1987 D): read the CURRENT
 *     dependency set UNDER the write lock, check every precondition against it
 *     (`pending_materialization`, the cascade confirmation), CAPTURE everything
 *     the teardown will need (runtime-stop pairs *and their routing*, attachment
 *     storage refs, log counts), then delete the agent rows and the host row as a
 *     single atomic unit. A failed precondition rolls the whole scope back.
 *  2. **post-commit teardown** (best-effort, unrollbackable): runtime stops, the
 *     host-local `agent_files_purge` and the attachment blob deletes — all of it
 *     off the captures, never off a fresh query, because the rows are gone by
 *     now.
 *
 * The read and the capture live INSIDE the scope on purpose. The cascade deletes
 * whatever belongs to the computer at execution time (see the consent note
 * below), so a set read before the transaction could differ from the set deleted
 * inside it: the drifted-in agent would be deleted with no captured blob refs and
 * no captured runtime pairs — leaked bytes and an orphan daemon child. One
 * authoritative read point makes that class of mismatch unstateable, and it is
 * why the pre-flight read above is only an ownership/lifecycle HINT.
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
 * single decision point, so a refusal (`hasDependents`, `pendingAgents`, an
 * unmodeled FK violation) leaves the DB, the daemon's disk and the blob store
 * exactly as they were. Nothing before the commit may destroy anything — an
 * agent whose L2 tree was purged while the request then failed would be a
 * half-delete no retry can undo, which is precisely the failure mode this use
 * case exists to remove.
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
 * is not this use case's job either: the dialog reads the computer's agents from
 * `GET /api/hosts/:id/resources` first, and the `hasDependents` refusal here is
 * only a guard for a caller that skipped that step.
 *
 * What the flag does NOT do is authorize: the pending-materialization check is
 * re-evaluated inside the transaction against current state, because that is a
 * legality question, not a consent question.
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
  teardown: AgentTeardownPersistence;
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
 *  that skipped the confirmation step still learns what it would destroy.
 *
 *  Agents only (relocation-v1 §7-4): a regular workspace is not rooted on a
 *  computer, so this cascade can never reach one. */
export interface ComputerDeleteDependentsPayload {
  dependents: HostDeleteDependents;
  agents: HostAgentResource[];
}

export type DeleteComputerResult =
  | { kind: 'deleted' }
  | { kind: 'notFound' }
  | { kind: 'provisioningSourceNotSupported' }
  | { kind: 'pendingAgents'; pendingAgents: number }
  | { kind: 'deletionInProgress'; deletingAgents: number }
  | { kind: 'hasDependents'; payload: ComputerDeleteDependentsPayload };

/**
 * Thrown inside the commit scope to roll it back when a precondition fails.
 * Never escapes this module: every refusal is raised from the same authoritative
 * read, so each reason maps straight to its typed result and the caller cannot
 * tell a mid-request change from a pre-request one.
 */
type CommitRefusal =
  | { reason: 'hasDependents'; payload: ComputerDeleteDependentsPayload }
  | { reason: 'pendingAgents'; pendingAgents: number }
  | { reason: 'deletionInProgress'; deletingAgents: number }
  | { reason: 'hostGone' };

class CommitPreconditionFailed extends Error {
  constructor(readonly refusal: CommitRefusal) {
    super(refusal.reason);
  }
}

/** One agent's teardown, fully captured before its rows are deleted. */
interface AgentTeardown {
  agent: AgentTeardownFacts;
  capture: AgentTeardownCapture;
}

/** Everything the post-commit phase acts on, captured inside the scope because
 *  every source row it derives from is deleted there. */
interface ComputerTeardownCapture {
  /** Every agent the cascade deleted — the `agent_changed` fan-out set. */
  deletedAgents: AgentTeardownFacts[];
  /** The `failed` rows, deleted row-only: no dependents, no runtime, no tree. */
  rowOnlyAgents: AgentTeardownFacts[];
  /** The full cascades, with their post-commit facts. */
  agentTeardowns: AgentTeardown[];
}

export async function deleteComputer(
  deps: DeleteComputerDeps,
  cmd: DeleteComputerCommand,
): Promise<DeleteComputerResult> {
  const { ctx, teardown } = deps;

  // Pre-flight ownership / lifecycle refusals — answered WITHOUT taking a write
  // lock, because saying "not yours" or "not user-managed" needs no coordination.
  // Only a hint: `deleteComputerRow` re-checks both conditions in its own WHERE.
  const host = teardown.read.readComputerFacts(cmd.hostId);
  if (!host || host.userId !== cmd.requesterUserId) {
    return { kind: 'notFound' };
  }
  if (host.provisioningSource !== 'user_invite' || host.kind !== 'remote') {
    return { kind: 'provisioningSourceNotSupported' };
  }

  // ── phase 1: read, check, capture and delete — one scope ────────────
  let capture: ComputerTeardownCapture;
  try {
    capture = teardown.uow.atomicallyForComputer(
      { hostId: cmd.hostId, userId: cmd.requesterUserId },
      tx => {
        // THE authoritative read, under the write lock. Every refusal below is
        // raised from this one snapshot and rolls the scope back, and the
        // capture phase 2 acts on is derived from the very same snapshot the
        // deletes consume.
        const hostAgents = tx.computer.listAgentsForUpdate();

        // A materialization still in flight cannot be torn down safely (the
        // reserve → flip transaction would race). Transient, so it answers
        // "retry" rather than offering a cascade.
        const pendingAgents = hostAgents.filter(
          agent => agent.materializationStatus === 'pending_materialization',
        ).length;
        if (pendingAgents > 0) {
          throw new CommitPreconditionFailed({
            reason: 'pendingAgents',
            pendingAgents,
          });
        }
        // A single-agent deletion marker is the durable anchor for its purge
        // resumer. The computer cascade must not delete that row underneath the
        // worker (or strand a daemon fence with no control-plane attempt).
        const deletingAgents = hostAgents.filter(
          agent => agent.deletionStartedAt !== null,
        ).length;
        if (deletingAgents > 0) {
          throw new CommitPreconditionFailed({
            reason: 'deletionInProgress',
            deletingAgents,
          });
        }
        if (hostAgents.length > 0 && !cmd.cascadeDependents) {
          throw new CommitPreconditionFailed({
            reason: 'hasDependents',
            payload: {
              dependents: { agents: hostAgents.length },
              agents: hostAgents.map(teardownFactsToHostAgentResource),
            },
          });
        }

        // Capture BEFORE any delete and inside the same scope: after the FK
        // cascade there is no row left to derive a storage key or a runtime pair
        // from. Read-only, so it cannot destroy anything even though the host-row
        // precondition below could still roll all of this back.
        const rowOnlyAgents: AgentTeardownFacts[] = [];
        const agentTeardowns: AgentTeardown[] = [];
        const doomed: Array<{ face: ReturnType<typeof tx.computer.forAgent> }> = [];
        for (const agent of hostAgents) {
          const face = tx.computer.forAgent(agent.id);
          const facts = face.readFacts();
          if (!facts) continue; // concurrent delete won — nothing left to tear down
          doomed.push({ face });
          if (facts.materializationStatus === 'failed') {
            rowOnlyAgents.push(facts);
            continue;
          }
          agentTeardowns.push({ agent: facts, capture: face.capture() });
        }

        for (const entry of doomed) {
          entry.face.deleteAgentRow();
        }
        if (!tx.computer.deleteComputerRow()) {
          // Someone deleted the host row concurrently, or it was never
          // user-managed. Roll back and answer 404 rather than reporting a
          // success this request did not cause.
          throw new CommitPreconditionFailed({ reason: 'hostGone' });
        }
        return {
          deletedAgents: [
            ...rowOnlyAgents,
            ...agentTeardowns.map(entry => entry.agent),
          ],
          rowOnlyAgents,
          agentTeardowns,
        };
      },
    );
  } catch (err) {
    if (err instanceof CommitPreconditionFailed) {
      return refusalToResult(err.refusal);
    }
    // Anything else rolled the whole scope back — including an FK violation,
    // which here can only mean the schema holds a RESTRICT reference this
    // cascade does not model (drift or a bug), and the coordination violation
    // `forAgent` throws for an agent this computer does not own. It FAILS LOUD:
    // dressing either up as a user-actionable `has_dependents` would hand the UI
    // a dead end (blocked, nothing to remove, retry forever) and hide the broken
    // invariant.
    throw err;
  }

  // ── phase 2: post-commit teardown (best-effort, capture-driven) ────
  for (const agent of capture.rowOnlyAgents) {
    ctx.logger.info(
      {
        agentId: agent.id,
        agentName: agent.name,
        failedCode: agent.failedCode,
      },
      'failed agent row deleted (D5: row-only, no dependents)',
    );
  }
  // Post-commit identity-change fan-out (#task:1791): the scope deleted every
  // agent row (active via the full cascade, failed via row-only), so publish the
  // terminal `agent_changed` for each. Post-commit by construction — a
  // rolled-back precondition returned above without reaching here, so clients
  // are never told an agent is deleted while its row survives.
  for (const agent of capture.deletedAgents) {
    ctx.agentService.publishDeleted(agent.id);
  }
  let blobsAttempted = 0;
  let blobsFailed = 0;
  // One stop per (conversation, agent) pair: an agent may be running in several
  // conversations, and the captured runtime sessions are now the ONLY teardown
  // authority — relocation-v1 §7-4 removed the workspace-cascade half, so there
  // is no second source to union with.
  const stopped = new Set<string>();
  const stopKey = (live: AgentRuntimeSessionFacts): string =>
    live.runtimeScope.kind === 'agent'
      ? `agent\u0000${live.runtimeScope.agentId}`
      : `conversation\u0000${live.runtimeScope.conversationId}\u0000${live.runtimeScope.agentId}`;
  let purgeAttempts = 0;
  let purgeFailures = 0;
  for (const entry of capture.agentTeardowns) {
    for (const live of entry.capture.runtimeSessions.filter(isRunningSession)) {
      if (stopped.has(stopKey(live))) continue;
      stopped.add(stopKey(live));
      // `{ hostId }` is the captured routing authority: the dispatcher would
      // otherwise re-read `agents`/`hosts`, which this cascade has just
      // deleted, and the stop would degrade to a warning while the daemon's
      // child keeps running.
      await ctx.runtimeHost
        .stop(live.conversationId, entry.agent.id, {
          hostId: entry.agent.hostId,
          runtimeGeneration: live.runtimeGeneration,
          runtimeScope: live.runtimeScope,
        })
        .catch(err =>
          ctx.logger.warn(
            {
              conversationId: live.conversationId,
              agentId: entry.agent.id,
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
    const purge = await purgeAgentHostLocalFiles(ctx, entry.agent).catch(
      (err: unknown) =>
        ({ kind: 'failClosed', code: 'purge_threw', error: String(err) }) as const,
    );
    if (purge.kind === 'failClosed') {
      purgeFailures += 1;
      ctx.logger.warn(
        {
          hostId: cmd.hostId,
          agentId: entry.agent.id,
          code: purge.code,
          err: purge.error,
        },
        'delete computer cascade: host-local purge failed (continuing; files stay on that computer)',
      );
    }
    const swept = await sweepStoredBlobs(ctx, entry.capture.dmBlobRefs);
    blobsAttempted += swept.attempted;
    blobsFailed += swept.failed;
    if (swept.failed > 0) {
      ctx.logger.warn(
        {
          hostId: cmd.hostId,
          agentId: entry.agent.id,
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
      cascadedAgents: capture.deletedAgents.length,
      purgeAttempts,
      purgeFailures,
      blobsAttempted,
      blobsFailed,
    },
    'user-managed computer deleted with its dependents',
  );
  return { kind: 'deleted' };
}

/** Map a rolled-back commit precondition to its typed result. The lists it
 *  carries were read inside the scope, so they describe the state the refusal
 *  was actually decided on. */
function refusalToResult(refusal: CommitRefusal): DeleteComputerResult {
  switch (refusal.reason) {
    case 'hasDependents':
      return { kind: 'hasDependents', payload: refusal.payload };
    case 'pendingAgents':
      return { kind: 'pendingAgents', pendingAgents: refusal.pendingAgents };
    case 'deletionInProgress':
      return {
        kind: 'deletionInProgress',
        deletingAgents: refusal.deletingAgents,
      };
    case 'hostGone':
      return { kind: 'notFound' };
  }
}
