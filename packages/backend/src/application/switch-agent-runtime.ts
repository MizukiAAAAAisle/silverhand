import {
  runtimeCatalogEntry,
  type SwitchAgentRuntimeInput,
  type SwitchAgentRuntimeResponse,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { RuntimeSlotRepo } from '../repos/runtime-slot-repo.js';
import { dispatchHostRuntimeCatalog } from '../runtime/host-runtime-catalog-dispatch.js';
import type {
  DataPlaneFailureCode,
  DataPlaneHttpStatus,
} from '../runtime/workspace-data-plane.js';

export type SwitchAgentRuntimeErrorCode =
  | 'agent_not_found'
  | 'runtime_unchanged'
  | 'runtime_not_selectable'
  | 'runtime_not_installed'
  | 'runtime_transition_in_progress'
  | 'agent_deletion_in_progress'
  | 'runtime_transition_lost'
  | 'runtime_session_clear_failed'
  | 'runtime_session_clear_scope_unsupported'
  | DataPlaneFailureCode;

export class SwitchAgentRuntimeError extends Error {
  constructor(
    public readonly code: SwitchAgentRuntimeErrorCode,
    public readonly status: DataPlaneHttpStatus | 500,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SwitchAgentRuntimeError';
  }
}

export interface SwitchAgentRuntimeDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  runtimeSlots: RuntimeSlotRepo;
  conversationInboxes: ConversationInboxRepo;
}

/**
 * Transition one agent to another runtime without changing its identity.
 * Runtime/tuning remain unchanged until every old-runtime session has been
 * cleared; the durable lock blocks new spawn/delivery throughout that window.
 */
export async function switchAgentRuntime(
  deps: SwitchAgentRuntimeDeps,
  input: {
    agentId: string;
    actorUserId: string;
    config: SwitchAgentRuntimeInput;
  },
): Promise<SwitchAgentRuntimeResponse> {
  const existing = deps.agents.getRow(input.agentId);
  if (!existing) {
    throw new SwitchAgentRuntimeError(
      'agent_not_found',
      404,
      `agent ${input.agentId} does not exist`,
    );
  }
  if (existing.runtime === input.config.runtime) {
    throw new SwitchAgentRuntimeError(
      'runtime_unchanged',
      409,
      `agent already uses runtime '${input.config.runtime}'`,
    );
  }
  if (!runtimeCatalogEntry(input.config.runtime).selectable) {
    throw new SwitchAgentRuntimeError(
      'runtime_not_selectable',
      400,
      `runtime '${input.config.runtime}' is not selectable`,
    );
  }

  // Availability is host-local truth. Only deterministic absence blocks the
  // transition; unknown/present_unverified still defer to the spawn boundary.
  const catalog = await dispatchHostRuntimeCatalog(
    deps.ctx.outboundFrameAdapter?.() ?? null,
    existing.host_id,
    { force: true },
  );
  if (catalog.kind === 'failed') {
    throw new SwitchAgentRuntimeError(
      catalog.code,
      catalog.status,
      catalog.message,
    );
  }
  const targetAvailability = catalog.catalog.runtimes.find(
    entry => entry.kind === input.config.runtime,
  );
  if (!targetAvailability || targetAvailability.state === 'absent') {
    throw new SwitchAgentRuntimeError(
      'runtime_not_installed',
      409,
      `runtime '${input.config.runtime}' is not available on this computer`,
    );
  }

  // Reasoning-effort product validity (incl. model-specific rules like Codex
  // `ultra` only on sol) is enforced by `SwitchAgentRuntimeInputSchema`; the
  // daemon's spawn last-line is the final guard. No host round-trip here.

  const transitionStartedAt = Date.now();
  const lock = deps.agents.beginRuntimeTransition(
    input.agentId,
    input.config.runtime,
    transitionStartedAt,
  );
  if (lock === 'not_found') {
    throw new SwitchAgentRuntimeError(
      'agent_not_found',
      404,
      `agent ${input.agentId} does not exist`,
    );
  }
  if (lock === 'in_progress') {
    throw new SwitchAgentRuntimeError(
      'runtime_transition_in_progress',
      409,
      `agent ${input.agentId} is already switching runtime`,
    );
  }
  if (lock === 'deleting') {
    throw new SwitchAgentRuntimeError(
      'agent_deletion_in_progress',
      409,
      `agent ${input.agentId} is being deleted`,
    );
  }

  const liveBefore = new Set<string>();
  try {
    // The preflight row can become stale while the host catalog round-trip is
    // in flight. Re-read under our durable lock so a transition that another
    // request just committed to the same target fails loudly instead of
    // overwriting its target-runtime tuning.
    const lockedRow = deps.agents.getRow(input.agentId);
    if (!lockedRow) {
      throw new SwitchAgentRuntimeError(
        'agent_not_found',
        404,
        `agent ${input.agentId} does not exist`,
      );
    }
    if (lockedRow.runtime === input.config.runtime) {
      throw new SwitchAgentRuntimeError(
        'runtime_unchanged',
        409,
        `agent already uses runtime '${input.config.runtime}'`,
      );
    }

    // SEATS, not conversations: what must be cleared before the runtime changes
    // is every live SESSION of this agent, wherever it sits. The slot table IS
    // that set — one row per seat, every placement, no conversation join — so a
    // session in a DM or an inbox cannot be silently excluded and the runtime
    // switched out from under it (@Cindy B3). `cliSessionId` is on the seat, so
    // there is also no second membership read that could disagree with the
    // status it is paired with (the roster read this replaced returned NULL for
    // every rosterless placement, which made a resumable DM session invisible).
    const seats = deps.runtimeSlots.listSeats(input.agentId);
    const clearTargets: string[] = [];
    for (const seat of seats) {
      const live = seat.status === 'active' || seat.status === 'starting';
      // Nothing running and nothing resumable — the old runtime holds no
      // session behind this seat, so there is nothing for the transition to
      // clear through it.
      if (!live && seat.cliSessionId === null) continue;
      if (seat.scope.kind === 'agent') {
        // An AgentSlot is ONE session serving N conversations, so there is no
        // conversation to clear it through: `clearSession` resolves custody by
        // scope but still needs a target conversation for its participation
        // check and its audit message. Choosing one would post a
        // session-cleared notice into an arbitrary channel and key the exit
        // waiter on a coordinate the session does not have. Refusing loudly
        // keeps the durable lock's promise — the runtime never changes under a
        // live session. Closing it is #task:2025 (the P2 runtime-scope lane): a
        // scope-keyed participation check, a scope-keyed coordinator key, and an
        // explicit decision about where an AgentSlot's clear is audited, since
        // an agent-scoped agent has neither an `agent_home` nor an inbox DM
        // (§9.2). A DORMANT AgentSlot is unaffected: it
        // is filtered out above, so an agent-scoped agent with no live session
        // and no resumable CLI session still switches.
        throw new SwitchAgentRuntimeError(
          'runtime_session_clear_scope_unsupported',
          409,
          `agent ${input.agentId} holds an agent-scoped session; clearing it is not supported yet, so the runtime was not changed`,
        );
      }
      if (live) liveBefore.add(seat.scope.conversationId);
      clearTargets.push(seat.scope.conversationId);
    }

    // A claim made before the lock is no longer valid custody. Returning it to
    // pending lets the post-transition restart deliver under the target runtime.
    const reclaimedConversationIds =
      deps.conversationInboxes.rollbackInFlightForAgent(input.agentId);

    const cleared = await Promise.allSettled(
      clearTargets.map(conversationId =>
        deps.ctx.runtimeHost.clearSession(
          conversationId,
          input.agentId,
          input.actorUserId,
        ),
      ),
    );
    const firstFailure = cleared.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure) {
      throw new SwitchAgentRuntimeError(
        'runtime_session_clear_failed',
        500,
        'failed to clear every old-runtime session; runtime was not changed',
        { cause: firstFailure.reason },
      );
    }

    const updated = deps.ctx.agentService.completeRuntimeTransition(
      input.agentId,
      input.config,
    );
    if (!updated) {
      throw new SwitchAgentRuntimeError(
        'runtime_transition_lost',
        409,
        'runtime transition ownership was lost before commit',
      );
    }
    deps.ctx.logger.info(
      {
        agentId: input.agentId,
        actorUserId: input.actorUserId,
        fromRuntime: lockedRow.runtime,
        toRuntime: input.config.runtime,
        clearedSessions: clearTargets.length,
      },
      'agent runtime transition committed',
    );

    const resumeIds = new Set([
      ...liveBefore,
      ...reclaimedConversationIds,
      // Deliberately nudge only messages created while this transition held
      // the spawn gate. Older never-live pending rows remain demand-driven and
      // will be claimed with the pair's next inbox trigger; a config change
      // must not turn historical backlog into an unbounded restart herd.
      ...deps.conversationInboxes.listPendingConversationIdsForAgentSince(
        input.agentId,
        transitionStartedAt,
      ),
    ]);
    const restarted = await Promise.allSettled(
      [...resumeIds].map(conversationId =>
        deps.ctx.runtimeHost.start(conversationId, input.agentId),
      ),
    );
    const restartFailures = restarted.filter(r => r.status === 'rejected');
    for (const failure of restartFailures) {
      deps.ctx.logger.warn(
        { agentId: input.agentId, err: failure.reason },
        'runtime transition committed but conversation restart failed',
      );
    }
    return {
      agent: updated,
      cleared_sessions: clearTargets.length,
      restarted_conversations: restarted.length - restartFailures.length,
      restart_failures: restartFailures.length,
    };
  } catch (err) {
    // A committed transition already cleared the lock; this is a harmless
    // target-guarded no-op in that branch.
    const aborted = deps.agents.abortRuntimeTransition(
      input.agentId,
      input.config.runtime,
    );
    if (aborted) {
      // Restore previously-live pairs under the unchanged old runtime after a
      // partial clear failure. Best effort: the original failure remains the
      // response and another retry can finish the transition.
      await Promise.allSettled(
        [...liveBefore].map(conversationId =>
          deps.ctx.runtimeHost.start(conversationId, input.agentId),
        ),
      );
    }
    throw err;
  }
}
