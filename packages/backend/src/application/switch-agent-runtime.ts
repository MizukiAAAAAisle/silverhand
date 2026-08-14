import {
  runtimeCatalogEntry,
  type SwitchAgentRuntimeInput,
  type SwitchAgentRuntimeResponse,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { RuntimeSlotRepo } from '../repos/runtime-slot-repo.js';
import type { RuntimePrincipalScope } from '../auth/runtime-principal.js';
import type { ClearSessionResult } from '../runtime/agent-runtime-host.js';
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
  conversations: Pick<ConversationRepo, 'isAgentParticipant'>;
  conversationInboxes: ConversationInboxRepo;
  runtimeSlots: RuntimeSlotRepo;
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
  let agentSlotWasLive = false;
  let agentResumeFocus: string | null = null;
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
    const toClear: RuntimePrincipalScope[] = [];
    for (const seat of seats) {
      const live = seat.status === 'active' || seat.status === 'starting';
      // Nothing running and nothing resumable — the old runtime holds no
      // session behind this seat, so there is nothing for the transition to
      // clear through it.
      if (!live && seat.cliSessionId === null) continue;
      if (seat.scope.kind === 'agent') {
        // One aggregate session serves every origin. Clear it once by its
        // semantic scope; conversation focus is captured only as a possible
        // restart presentation target after the transition commits.
        agentSlotWasLive = live;
        toClear.push(seat.scope);
      } else {
        if (live) liveBefore.add(seat.scope.conversationId);
        toClear.push(seat.scope);
      }
    }
    // A claim made before the lock is no longer valid custody. Returning it to
    // pending lets the post-transition restart deliver under the target runtime.
    const reclaimedConversationIds =
      deps.conversationInboxes.rollbackInFlightForAgent(input.agentId);

    const cleared = await Promise.allSettled(toClear.map(scope =>
      deps.ctx.runtimeHost.clearSession(scope, input.actorUserId),
    ));
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
    if (lockedRow.session_scope === 'agent') {
      const successful = cleared.find(
        (result): result is PromiseFulfilledResult<ClearSessionResult> =>
          result.status === 'fulfilled',
      );
      const focus = successful?.value.focusConversationId ?? null;
      // A focus captured before clear is only a presentation coordinate, not
      // durable ownership. It may have been deleted or the agent may have lost
      // participation while the clear was in flight. Reuse that exact focus
      // only while the placement-aware participant authority still accepts it;
      // never substitute another visible binding.
      agentResumeFocus = focus !== null
        && deps.conversations.isAgentParticipant(focus, input.agentId)
        ? focus
        : null;
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
        clearedSessions: toClear.length,
      },
      'agent runtime transition committed',
    );

    const newlyPending = deps.conversationInboxes.listPendingConversationIdsForAgentSince(
      input.agentId,
      transitionStartedAt,
    );
    let resumeIds: Set<string>;
    if (lockedRow.session_scope === 'agent') {
      // One AgentSlot gets one restart target. Origin is presentation only:
      // prefer the oldest durable pending origin, otherwise reuse the focus
      // observed before clear. Starting once is enough; AgentSlot ready replay
      // drains every remaining origin in global inbox order.
      const shouldResume = agentSlotWasLive
        || reclaimedConversationIds.length > 0
        || newlyPending.length > 0;
      const oldestPending = shouldResume
        ? deps.conversationInboxes.listPendingConversationIdsForAgent(input.agentId)[0]
        : undefined;
      const target = oldestPending
        ?? (shouldResume ? agentResumeFocus : null);
      resumeIds = new Set(target ? [target] : []);
    } else {
      resumeIds = new Set([
        ...liveBefore,
        ...reclaimedConversationIds,
        // Deliberately nudge only messages created while this transition held
        // the spawn gate. Older never-live pending rows remain demand-driven and
        // will be claimed with the pair's next inbox trigger; a config change
        // must not turn historical backlog into an unbounded restart herd.
        ...newlyPending,
      ]);
    }
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
      cleared_sessions: toClear.length,
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
      const restoreTargets = existing.session_scope === 'agent'
        ? agentSlotWasLive && agentResumeFocus
          ? [agentResumeFocus]
          : []
        : [...liveBefore];
      await Promise.allSettled(restoreTargets.map(conversationId =>
        deps.ctx.runtimeHost.start(conversationId, input.agentId),
      ));
    }
    throw err;
  }
}
