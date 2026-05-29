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
  'agent runtime is unavailable: no outbound daemon transport is attached for this host';

export interface OutboundAgentRuntimeProjection {
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
  /**
   * D5.a-3 P1-4 — dispatch `runtime_stop_all` to every connected
   * outbound host on backend shutdown. Replaces the old embedded
   * `bridge.runtimeStopAll()`; never a silent no-op (orphaned daemon
   * children otherwise).
   */
  stopAll(): Promise<void>;
  /**
   * D5.a-3 P1-4 — flush every connected host's runtime buffers via
   * `runtime_close_activity_log`, then close the backend-owned activity
   * JSONL writer. Replaces the old embedded
   * `bridge.runtimeCloseActivityLog()` + writer close.
   */
  closeActivityLog(): Promise<void>;
}

export class HostRuntimeDisabledError extends Error {
  readonly code = 'host_runtime_disabled';

  constructor(method: string) {
    super(`${method}: ${UNAVAILABLE_REASON}`);
    this.name = 'HostRuntimeDisabledError';
  }
}

/**
 * Unified backend runtime host over the outbound daemon transport.
 *
 * D5.a-3 unified embedded and standalone onto ONE host: both modes wire
 * `new OutboundAgentRuntimeHost(logger, () => outboundFanout)`, and the
 * fanout's `transport` is the deployment-specific `OutboundFrameAdapter`
 * (standalone = WSS-backed; embedded = local Unix socket). The host owns
 * no runtime state itself — every method delegates to the
 * {@link OutboundAgentRuntimeProjection} (the fanout). When no daemon is
 * attached the projection's dispatch path throws a typed
 * `transport_no_connection`, which routes map to 503 `host_attach_pending`;
 * `start` additionally returns false-then-throws `HostRuntimeDisabledError`
 * (409) when there is nothing delivery-backed to start.
 *
 * (Formerly `ControlPlaneRuntimeHost`; renamed in D5.a-3 once embedded and
 * standalone became one path — the "control-plane only" framing no longer
 * fit.)
 */
export class OutboundAgentRuntimeHost implements AgentRuntimeHost {
  constructor(
    private readonly logger: BackendLogger,
    private readonly projection?: () => OutboundAgentRuntimeProjection | null,
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
    // Delegate to the projection, which dispatches `runtime_stop_all` to
    // every connected outbound host (P1-4). No connection → projection
    // no-ops; never silently drops the stop like the old control-plane stub.
    await this.projection?.()?.stopAll();
  }

  async setConversationLogDebug(
    _conversationId: string,
    _enabled: boolean,
    _expiresAt?: number | null,
  ): Promise<void> {
    // D5.a-3 P1-4 — DELIBERATELY backend-only; NOT a TODO gap. The
    // outbound command set has no `conversation_log_debug` intent (it
    // lives only in the legacy local IPC protocol), and adding one would
    // widen the formal server↔daemon surface for a fail-safe we don't
    // need. The route (`/api/conversations/:id/log-debug`) already
    // toggled `ctx.logControl`, which is the source of truth for the
    // local logger window; we intentionally retire the daemon-side TTL
    // mirror. Enabling/disabling log-debug therefore succeeds with or
    // without an attached daemon — see the backend-only pin in the tests.
  }

  async closeActivityLog(): Promise<void> {
    // Delegate to the projection: flush every connected host via
    // `runtime_close_activity_log`, then close the backend-owned writer
    // (P1-4). Was a silent no-op in the old control-plane stub.
    await this.projection?.()?.closeActivityLog();
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
