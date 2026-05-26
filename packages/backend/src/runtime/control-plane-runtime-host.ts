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
  constructor(private readonly logger: BackendLogger) {}

  async start(
    conversationId: string,
    agentId: string,
    _opts: StartOptions = {},
  ): Promise<void> {
    throw this.unavailable('start', { conversationId, agentId });
  }

  async stop(
    conversationId: string,
    agentId: string,
    _mode: 'soft' | 'hard' = 'hard',
    _softDirective?: string,
  ): Promise<void> {
    throw this.unavailable('stop', { conversationId, agentId });
  }

  async clearSession(
    conversationId: string,
    agentId: string,
    _actorUserId?: string | null,
  ): Promise<ClearSessionResult> {
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
    // Backend-local logging still changes; there is no daemon mirror to sync.
  }

  async closeActivityLog(): Promise<void> {
    // No daemon activity stream exists in control-plane mode.
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    throw this.unavailable('deliverMessage', { conversationId, agentId, messageId });
  }

  reconcileOnBoot(): void {
    // No daemon snapshot exists yet; D2 owns remote daemon reconciliation.
  }

  getAgentRunStates(_conversationId: string): AgentRunState[] {
    return [];
  }

  resolveRun(
    _conversationId: string,
    _agentId: string,
    _reason: AgentRunTerminalReason,
    _runId?: string,
  ): void {
    // No active runs exist in control-plane mode.
  }

  resolveConversationRuns(
    _conversationId: string,
    _reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    // No active runs exist in control-plane mode.
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
