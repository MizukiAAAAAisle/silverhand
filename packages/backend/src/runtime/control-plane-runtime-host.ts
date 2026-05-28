import type {
  AgentRunState,
  AgentRunTerminalReason,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type {
  AgentRuntimeHost,
  ClearSessionResult,
  StartOptions,
} from './agent-runtime-host.js';

const UNAVAILABLE_REASON =
  'agent runtime is unavailable in standalone server control-plane mode; daemon outbound is D2';

export interface ControlPlaneRuntimeProjection {
  startDeliveryBacked(conversationId: string, agentId: string): Promise<boolean>;
  /**
   * D4.b-4: dispatch `runtime_stop` to the daemon over the outbound
   * WS. The standalone server owns the projection of the resulting
   * `runtime_exit` event (`RuntimeStatusProjector.runtimeExit`),
   * which clears pid and flips status while preserving
   * `cli_session_id` for the next `--resume`.
   */
  stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard',
    softDirective?: string,
  ): Promise<void>;
  /**
   * D4.c C7 — dispatch `runtime_clear_session` over the outbound
   * WS, bounded-wait for the resulting `runtime_exit` projection
   * landed, then atomically clear `cli_session_id` + insert audit
   * row in one DB tx. Throws typed
   * {@link import('./agent-runtime-host.js').ClearSessionExitTimeoutError}
   * /
   * {@link import('./agent-runtime-host.js').ClearSessionInProgressError}
   * the route translates to 503 / 409.
   */
  clearSession(
    conversationId: string,
    agentId: string,
    actorUserId: string | null,
  ): Promise<ClearSessionResult>;
  deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void>;
  getAgentRunStates(conversationId: string): AgentRunState[];
  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void;
  resolveConversationRuns(
    conversationId: string,
    reason?: AgentRunTerminalReason,
  ): void;
}

export class HostRuntimeDisabledError extends Error {
  readonly code = 'host_runtime_disabled';

  constructor(method: string) {
    super(`${method}: ${UNAVAILABLE_REASON}`);
    this.name = 'HostRuntimeDisabledError';
  }
}

/**
 * Standalone server D1 runtime boundary.
 *
 * The remote server can own auth/data/control-plane state without pretending it
 * can spawn user-machine agent processes. Daemon-backed execution is wired by
 * the embedded desktop path today and by D2 outbound daemon-host transport
 * later.
 */
export class ControlPlaneRuntimeHost implements AgentRuntimeHost {
  constructor(
    private readonly logger: BackendLogger,
    private readonly projection?: () => ControlPlaneRuntimeProjection | null,
  ) {}

  async start(
    conversationId: string,
    agentId: string,
    _opts: StartOptions = {},
  ): Promise<void> {
    const handled = await this.projection?.()?.startDeliveryBacked(
      conversationId,
      agentId,
    );
    if (handled) return;
    throw this.unavailable('start', { conversationId, agentId });
  }

  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    softDirective?: string,
  ): Promise<void> {
    const projection = this.projection?.();
    if (projection) {
      await projection.stop(conversationId, agentId, mode, softDirective);
      return;
    }
    throw this.unavailable('stop', { conversationId, agentId });
  }

  async clearSession(
    conversationId: string,
    agentId: string,
    actorUserId?: string | null,
  ): Promise<ClearSessionResult> {
    const projection = this.projection?.();
    if (projection) {
      return projection.clearSession(conversationId, agentId, actorUserId ?? null);
    }
    throw this.unavailable('clearSession', { conversationId, agentId });
  }

  async stopAll(): Promise<void> {
    // No daemon-owned handles exist in control-plane mode.
  }

  async setConversationLogDebug(
    _conversationId: string,
    _enabled: boolean,
    _expiresAt?: number | null,
  ): Promise<void> {
    // Caller (`/api/conversations/:id/log-debug`) already toggled ctx.logControl;
    // standalone mode has no daemon mirror to sync.
  }

  async closeActivityLog(): Promise<void> {
    // No daemon activity stream exists in control-plane mode.
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    const projection = this.projection?.();
    if (projection) {
      await projection.deliverMessage(conversationId, agentId, messageId);
      return;
    }
    throw this.unavailable('deliverMessage', { conversationId, agentId, messageId });
  }

  reconcileOnBoot(): void {
    // No daemon snapshot exists yet; D2 owns remote daemon reconciliation.
  }

  getAgentRunStates(_conversationId: string): AgentRunState[] {
    return this.projection?.()?.getAgentRunStates(_conversationId) ?? [];
  }

  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    this.projection?.()?.resolveRun(conversationId, agentId, reason, runId);
  }

  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    this.projection?.()?.resolveConversationRuns(conversationId, reason);
  }

  private unavailable(
    method: string,
    meta: { conversationId?: string; agentId?: string; messageId?: string },
  ): Error {
    this.logger.warn(
      { runtime: 'control-plane', method, ...meta },
      'control-plane runtime: agent runtime method unavailable',
    );
    return new HostRuntimeDisabledError(method);
  }
}
