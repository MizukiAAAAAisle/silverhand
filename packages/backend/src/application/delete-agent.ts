import {
  DeleteAgentInputSchema,
  type AgentMaterializationStatus,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { StoredFileRef } from '../storage/blob-file-storage.js';
import { canEditAgent, canViewAgent } from '../permissions.js';
import {
  dispatchAgentFilesPurge,
  resolveOutboundForHost,
  type DataPlaneHttpStatus,
} from '../runtime/workspace-data-plane.js';
import type {
  AgentRuntimeSessionFacts,
  AgentTeardownCapture,
  AgentTeardownFacts,
  AgentTeardownPersistence,
  AgentTeardownUnitOfWork,
} from './agent-teardown-ports.js';
import type { AgentDeletionRunner } from './agent-deletion-resumer.js';

/**
 * DeleteAgent use case (#task:982 — P11a spec).
 *
 * Owns the full `DELETE /api/agents/:id` destructive cascade. Active deletion
 * is a durable lifecycle: persist the intent, let the host worker establish its
 * terminal fence + quiescence barrier and purge, then CAS-delete the DB row.
 *
 * HTTP-agnostic by construction (spec §1.1): it returns a typed
 * {@link DeleteAgentResult}; the route maps kind → HTTP status + body. It never
 * imports Hono `Context` and never builds a `Response`. The confirm gate parses
 * the raw command body with `DeleteAgentInputSchema` INSIDE the active branch —
 * exactly mirroring the route, which only validated confirm after the
 * pending/failed dispatch, so a failed row + malformed body stays 204 (not 400).
 *
 * Remote IO never runs under the SQLite write lock. The daemon fence, not an
 * optimistic pre-stop, closes already-admitted commands and live children. The
 * durable marker closes new backend dispatch and makes every failure
 * fail-forward through {@link AgentDeletionRunner}. Failed materialization rows
 * retain their pre-existing row-only behavior; they may still have partial
 * host-local bytes, a named residual of this task.
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
  teardown: AgentTeardownPersistence;
  deletionRunner: AgentDeletionRunner;
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
  retry?: boolean;
}

/**
 * Named result — no HTTP status policy. The route maps kind → status/body with
 * an exhaustive `switch` + `never` fallback. Once the durable marker exists,
 * every daemon/worker failure is `deletionPendingRetry` (202), never an
 * ephemeral fail-closed response that loses scheduling ownership.
 */
export type DeleteAgentResult =
  | { kind: 'deleted' }
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'pendingInFlight' }
  | { kind: 'deletionInProgress' }
  | { kind: 'deletionPendingRetry'; code: string; error: string }
  | { kind: 'confirmRequired' };

/** Which conversation-agent statuses still own a live runtime child. A DOMAIN
 *  rule, deliberately not pushed into the adapter: the teardown port hands back
 *  raw `(conversation, status)` pairs so this predicate stays testable here. */
export function isRunningSession(session: AgentRuntimeSessionFacts): boolean {
  return session.status === 'starting' || session.status === 'active';
}

export async function deleteAgent(
  deps: DeleteAgentDeps,
  cmd: DeleteAgentCommand,
): Promise<DeleteAgentResult> {
  const { ctx, teardown } = deps;
  const id = cmd.agentId;
  const principal: UserPrincipal = { kind: 'user', userId: cmd.requesterUserId };

  const agent = teardown.read.readAgentFacts(id);
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
  if (agent.materializationStatus === 'pending_materialization') {
    return { kind: 'pendingInFlight' };
  }
  if (agent.materializationStatus === 'failed') {
    // No host-local work is dispatched on this branch, so no computer was
    // purged and placement is not part of its eligibility (see
    // `AgentTeardownEligibility.purgedHostId`).
    const commit = commitAgentTeardown(teardown.uow, id, {
      materializationStatus: 'failed',
      purgedHostId: null,
    });
    if (commit.kind === 'gone') return { kind: 'notFound' };
    if (commit.kind === 'eligibilityMoved') return eligibilityRefusal(commit);
    ctx.logger.info(
      {
        agentId: commit.facts.id,
        agentName: commit.facts.name,
        failedCode: commit.facts.failedCode,
      },
      'failed agent row deleted (D5: row-only, no dependents)',
    );
    // Post-commit identity-change fan-out: the row is gone, so historical author
    // carriers reconcile to the `deleted` snapshot (#task:1791).
    ctx.agentService.publishDeleted(agent.id);
    return { kind: 'deleted' };
  }

  // ── active branch: full destructive flow ────────────────────────────
  // confirm gate — parsed here (not in the route) so it only fires on the active
  // branch, preserving the failed-row-with-malformed-body → 204 behavior.
  const parsed = DeleteAgentInputSchema.safeParse(cmd.body);
  if (!parsed.success) {
    return { kind: 'confirmRequired' };
  }

  // Persist the fail-forward intent BEFORE any daemon work. This is the crash
  // recovery and new-dispatch gate; remote IO never runs inside the write lock.
  const begun = teardown.deletion.begin(id, Date.now());
  if (begun.kind === 'notFound') return { kind: 'notFound' };
  if (begun.kind === 'notActive' || begun.kind === 'runtimeTransitionInProgress') {
    return { kind: 'pendingInFlight' };
  }
  if (begun.kind === 'alreadyPending' && !cmd.retry) {
    return { kind: 'deletionInProgress' };
  }
  const run = await deps.deletionRunner.tryNow(begun.attempt);
  if (run.kind === 'alreadyRunning') return { kind: 'deletionInProgress' };
  if (run.kind === 'pending') {
    return {
      kind: 'deletionPendingRetry',
      code: run.code,
      error: run.message,
    };
  }
  return { kind: 'deleted' };
}

/**
 * The outcome of the ONE transactional teardown step both row-deleting branches
 * take. `gone` / `eligibilityMoved` are the in-lock eligibility re-read talking:
 * the request decided its sequence (stop, purge, row-only) against a pre-lock
 * snapshot, and a row that vanished or whose eligibility moved since is NOT the
 * row that decision was made for.
 */
export type AgentTeardownCommit =
  | { kind: 'gone' }
  | {
      kind: 'eligibilityMoved';
      /** Which fact moved — the caller maps it to its refusal. */
      moved: 'materialization' | 'placement';
      /** The facts as read UNDER the lock, i.e. the state the refusal is about. */
      facts: AgentTeardownFacts;
    }
  | { kind: 'committed'; facts: AgentTeardownFacts; capture: AgentTeardownCapture };

/**
 * What the pre-lock phase already acted on, re-checked under the write lock.
 *
 * Not "this looked true a moment ago" but "this request has ALREADY done
 * something irreversible for this fact": the status chose the sequence (row-only
 * vs stop+purge+cascade), and `purgedHostId` names the computer whose host-local
 * tree was already destroyed.
 *
 * A DISCRIMINATED UNION, so the write core cannot be asked for a delete that
 * skipped a phase it owes. `commitAgentTeardown` is exported and load-bearing, so
 * caller discipline is not an acceptable substitute for the type:
 *  - `active` + `null` would be an active graph deleted with NO host-local purge
 *    and no placement re-check — expressible only if the two facts are
 *    independent fields, which is why they are not;
 *  - `failed` + a host id would claim a purge the row-only branch never
 *    dispatches;
 *  - `pending_materialization` is absent entirely: a materialization in flight is
 *    refused BEFORE any of this, so "commit a pending teardown" is not a thing
 *    this port can be asked for.
 * Adding a third eligible status therefore means adding an arm here, where its
 * host-local obligation has to be stated.
 */
export type AgentTeardownEligibility =
  | {
      /** The row-only branch: no runtime stops, no purge, nothing routed — so
       *  placement cannot be wrong and is not part of the eligibility. */
      materializationStatus: 'failed';
      purgedHostId: null;
    }
  | {
      /** The destructive branch, which has ALREADY destroyed this computer's
       *  host-local tree. It MUST still match in-scope: deleting a row that has
       *  since been placed elsewhere would delete an agent whose current computer
       *  was never purged — a half-delete with no row left to retry from. The
       *  check is deliberately not conditioned on "does anything move
       *  `agents.host_id` today": the port owes this contract to every engine and
       *  every future placement writer, and a UnitOfWork whose safety rests on
       *  the absence of a writer documents nothing. */
      materializationStatus: 'active';
      purgedHostId: string;
    };

/** Map an in-lock eligibility refusal to its typed result. Both arms are 409-
 *  shaped "nothing happened, re-read and retry" outcomes; they differ only in
 *  which fact moved, which is what the operator needs to see. */
function eligibilityRefusal(
  commit: Extract<AgentTeardownCommit, { kind: 'eligibilityMoved' }>,
): DeleteAgentResult {
  return { kind: 'pendingInFlight' };
}

/**
 * Delete ONE agent's control-plane rows inside the teardown UnitOfWork, and
 * capture what the post-commit phase needs from the same snapshot.
 *
 * `expected` is what the caller's pre-lock phase already acted on
 * ({@link AgentTeardownEligibility}). Re-reading it under the lock is what makes
 * those pre-lock decisions safe to have been taken outside it.
 *
 * The capture is taken unconditionally — it is read-only and cheap on a `failed`
 * row (no home, no runtime, no attachments), so there is ONE code path and no
 * second capture semantics for the branch that "does not need it".
 */
export function commitAgentTeardown(
  uow: AgentTeardownUnitOfWork,
  agentId: string,
  expected: AgentTeardownEligibility,
): AgentTeardownCommit {
  return uow.atomicallyForAgent({ agentId }, tx => {
    const facts = tx.agent.readFacts();
    if (!facts) return { kind: 'gone' };
    if (facts.materializationStatus !== expected.materializationStatus) {
      return { kind: 'eligibilityMoved', moved: 'materialization', facts };
    }
    // Only the destructive arm carries a purged computer, and it always carries
    // one — so this is a plain comparison, not a "if the caller bothered" guard.
    if (
      expected.materializationStatus === 'active' &&
      facts.hostId !== expected.purgedHostId
    ) {
      return { kind: 'eligibilityMoved', moved: 'placement', facts };
    }
    const capture = tx.agent.capture();
    tx.agent.deleteAgentRow();
    return { kind: 'committed', facts, capture };
  });
}

export async function purgeAgentHostLocalFiles(
  ctx: BackendContext,
  agent: Pick<AgentTeardownFacts, 'id' | 'hostId'>,
): Promise<
  | { kind: 'purged'; purgedCount: number }
  | { kind: 'failClosed'; error: string; code: string; status: DataPlaneHttpStatus }
> {
  // #task:1612 — the purge performs NO workspace provision (the retired
  // pre-purge backfill would have MINTED an empty root on the agent's computer
  // just to delete it). relocation-v1 §3.2 / §7 task 4: the daemon removes the
  // agent's TERMINAL MANAGED footprint — the whole agent home tree (L1 + every
  // nested `workspaces/<id>` L2) in one rm — so the backend forwards only
  // `{ agent_id }`; the daemon consults NO registry and enumerates no
  // per-workspace targets. (The retained legacy relocation source is a
  // product-decided permanent orphan; see step 2's comment above.)
  const outbound = resolveOutboundForHost(
    ctx.outboundFrameAdapter?.() ?? null,
    agent.hostId,
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
    agent.hostId,
    outbound.connectionId,
    {
      agent_id: agent.id,
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
  return {
    kind: 'purged',
    purgedCount: purge.result.purged_count,
  };
}

/**
 * Best-effort physical blob delete, shared by both cascades. Never throws: the
 * rows that could name these bytes are already gone, so the only useful outcome
 * is a count the caller can log.
 */
export async function sweepStoredBlobs(
  ctx: BackendContext,
  refs: StoredFileRef[],
): Promise<{ attempted: number; failed: number; firstError?: unknown }> {
  return await ctx.attachmentService.deleteBlobs(refs).catch((err: unknown) => ({
    attempted: refs.length,
    failed: refs.length,
    firstError: err,
  }));
}
