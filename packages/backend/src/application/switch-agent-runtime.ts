import {
  runtimeCatalogEntry,
  type SwitchAgentRuntimeInput,
  type SwitchAgentRuntimeResponse,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
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
  conversations: ConversationRepo;
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

    const bindings = deps.agents.listRuntimeConversations(input.agentId);
    for (const row of bindings) {
      if (row.status === 'active' || row.status === 'starting') {
        liveBefore.add(row.conversation_id);
      }
    }
    const toClear = bindings.filter(row => {
      const session = deps.conversations.getAgent(
        row.conversation_id,
        input.agentId,
      );
      return liveBefore.has(row.conversation_id) || session?.cli_session_id != null;
    });

    // A claim made before the lock is no longer valid custody. Returning it to
    // pending lets the post-transition restart deliver under the target runtime.
    const reclaimedConversationIds =
      deps.conversationInboxes.rollbackInFlightForAgent(input.agentId);

    const cleared = await Promise.allSettled(
      toClear.map(row =>
        deps.ctx.runtimeHost.clearSession(
          row.conversation_id,
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
        clearedSessions: toClear.length,
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
      await Promise.allSettled(
        [...liveBefore].map(conversationId =>
          deps.ctx.runtimeHost.start(conversationId, input.agentId),
        ),
      );
    }
    throw err;
  }
}
