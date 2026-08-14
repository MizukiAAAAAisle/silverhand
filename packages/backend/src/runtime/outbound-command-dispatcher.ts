import type {
  RuntimeClearSessionParams,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogResult,
  RuntimeOutputPauseParams,
  RuntimeOutputPauseResult,
  RuntimeOutputResumeParams,
  RuntimeOutputResumeResult,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStatusParams,
  RuntimeStatusResult,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
} from '@silverhand/host';
import { HostWsCommandTransportError, type HostWsServerController } from '../ws/host-ws-server.js';
import type { RuntimeHostPlacement } from './host-placement.js';

export interface OutboundRuntimeCommandDispatcherOptions {
  transport: HostWsServerController;
  placement: RuntimeHostPlacement;
  /** Host target for host-wide commands with no `(conversation_id, agent_id)`. */
  defaultHostId?: () => string | null;
}

/**
 * Placement-aware server -> daemon command dispatcher for the outbound WS path.
 *
 * D2.c intentionally stops at fail-fast command dispatch. It does not replay
 * delivery-backed commands from DB inbox and does not project daemon events;
 * D2.d/D2.e own those integrations.
 */
export class OutboundRuntimeCommandDispatcher {
  constructor(private readonly opts: OutboundRuntimeCommandDispatcherOptions) {}

  async runtimeStart(params: RuntimeStartParams): Promise<RuntimeStartResult> {
    return this.sendAgentCommand('runtime_start', params);
  }

  async runtimeStop(params: RuntimeStopParams): Promise<RuntimeStopResult> {
    return this.sendAgentCommand('runtime_stop', params);
  }

  async runtimeStatus(params: RuntimeStatusParams = {}): Promise<RuntimeStatusResult> {
    const hostId = params.agent_id
      ? this.hostIdForAgent(params.agent_id)
      : this.defaultHostId('runtime_status');
    return this.opts.transport.sendCommand(hostId, 'runtime_status', params);
  }

  async runtimeClearSession(
    params: RuntimeClearSessionParams,
  ): Promise<RuntimeClearSessionResult> {
    return this.sendAgentCommand('runtime_clear_session', params);
  }

  async runtimeStopAll(): Promise<RuntimeStopAllResult> {
    return this.opts.transport.sendCommand(
      this.defaultHostId('runtime_stop_all'),
      'runtime_stop_all',
      {},
    );
  }

  async runtimeCloseActivityLog(): Promise<RuntimeCloseActivityLogResult> {
    return this.opts.transport.sendCommand(
      this.defaultHostId('runtime_close_activity_log'),
      'runtime_close_activity_log',
      {},
    );
  }

  async runtimeOutputPause(
    params: RuntimeOutputPauseParams,
  ): Promise<RuntimeOutputPauseResult> {
    return this.sendAgentCommand('runtime_output_pause', params);
  }

  async runtimeOutputResume(
    params: RuntimeOutputResumeParams,
  ): Promise<RuntimeOutputResumeResult> {
    return this.sendAgentCommand('runtime_output_resume', params);
  }

  private sendAgentCommand<
    K extends
      | 'runtime_start'
      | 'runtime_stop'
      | 'runtime_clear_session'
      | 'runtime_output_pause'
      | 'runtime_output_resume',
  >(
    kind: K,
    params: ExtractAgentParams<K>,
  ): Promise<ExtractAgentResult<K>> {
    const agentId = 'agent_id' in params
      ? params.agent_id
      : params.runtime_scope.agent_id;
    const hostId = this.hostIdForAgent(agentId);
    return this.opts.transport.sendCommand(hostId, kind, params) as Promise<
      ExtractAgentResult<K>
    >;
  }

  private hostIdForAgent(agentId: string): string {
    return this.opts.placement.resolveForAgent(agentId).host.id;
  }

  private defaultHostId(commandKind: string): string {
    const hostId = this.opts.defaultHostId?.() ?? null;
    if (hostId) return hostId;
    throw new HostWsCommandTransportError(
      'transport_no_connection',
      `no default outbound host target for ${commandKind}`,
      { hostId: 'unknown' },
    );
  }
}

type ExtractAgentParams<K> =
  K extends 'runtime_start' ? RuntimeStartParams :
  K extends 'runtime_stop' ? RuntimeStopParams :
  K extends 'runtime_clear_session' ? RuntimeClearSessionParams :
  K extends 'runtime_output_pause' ? RuntimeOutputPauseParams :
  K extends 'runtime_output_resume' ? RuntimeOutputResumeParams :
  never;

type ExtractAgentResult<K> =
  K extends 'runtime_start' ? RuntimeStartResult :
  K extends 'runtime_stop' ? RuntimeStopResult :
  K extends 'runtime_clear_session' ? RuntimeClearSessionResult :
  K extends 'runtime_output_pause' ? RuntimeOutputPauseResult :
  K extends 'runtime_output_resume' ? RuntimeOutputResumeResult :
  never;
