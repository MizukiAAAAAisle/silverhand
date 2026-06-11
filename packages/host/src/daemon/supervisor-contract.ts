/**
 * SupervisorContract — daemon-side abstraction over the (conversation,
 * agent) runtime.
 *
 * The production implementation is `Supervisor`; tests may provide
 * test-only implementations such as `FakeSupervisor`. The dispatcher
 * depends only on this contract so protocol routing stays independent
 * from the concrete execution-plane implementation.
 *
 * Method names + shapes mirror the wire intents 1:1 so the
 * dispatcher can route by intent name without translation. Async
 * behaviour: every handler returns the *synchronous* result (e.g.
 * `runtime_start` returns the pid + started_at immediately) and
 * schedules any follow-up events (`runtime_ready_for_drain`,
 * `runtime_startup_delivery_consumed`, `runtime_exit`, ...) via the
 * supervisor's own emit channel — those are not part of the request
 * / response cycle.
 */
import type {
  AgentMessageSendParams,
  AgentMessageSendResult,
  AgentStaleResolveParams,
  AgentStaleResolveResult,
  AgentStreamObservedParams,
  AgentStreamObservedResult,
  RuntimeClearSessionParams,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogParams,
  RuntimeCloseActivityLogResult,
  RuntimeOutputPauseParams,
  RuntimeOutputPauseResult,
  RuntimeOutputResumeParams,
  RuntimeOutputResumeResult,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStatusParams,
  RuntimeStatusResult,
  RuntimeStopAllParams,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
  RuntimeWakeParams,
  RuntimeWakeResult,
} from '../protocol.js';

export interface SupervisorContract {
  agentMessageSend(
    params: AgentMessageSendParams,
  ): AgentMessageSendResult | Promise<AgentMessageSendResult>;
  agentStaleResolve(
    params: AgentStaleResolveParams,
  ): AgentStaleResolveResult | Promise<AgentStaleResolveResult>;
  agentStreamObserved(
    params: AgentStreamObservedParams,
  ): AgentStreamObservedResult | Promise<AgentStreamObservedResult>;
  start(params: RuntimeStartParams): RuntimeStartResult | Promise<RuntimeStartResult>;
  stop(params: RuntimeStopParams): RuntimeStopResult | Promise<RuntimeStopResult>;
  wake(params: RuntimeWakeParams): RuntimeWakeResult | Promise<RuntimeWakeResult>;
  status(
    params: RuntimeStatusParams,
  ): RuntimeStatusResult | Promise<RuntimeStatusResult>;
  clearSession(
    params: RuntimeClearSessionParams,
  ): RuntimeClearSessionResult | Promise<RuntimeClearSessionResult>;
  stopAll(
    params: RuntimeStopAllParams,
  ): RuntimeStopAllResult | Promise<RuntimeStopAllResult>;
  closeActivityLog(
    params: RuntimeCloseActivityLogParams,
  ): RuntimeCloseActivityLogResult | Promise<RuntimeCloseActivityLogResult>;
  /**
   * Pause/resume runtime_output streaming for one (conv, agent). v0
   * backend never calls these, but the protocol surface is locked in
   * step 1: when called, the supervisor must emit
   * `runtime_output_paused` / `runtime_output_resumed` so subscribers
   * see the flow-control transition. Cindy `_YD0KJF-YAQXlcki`
   * requires this to route through the SupervisorContract interface
   * (NOT inline dispatcher emit) so the protocol boundary stays
   * stable.
   */
  pauseOutput(
    params: RuntimeOutputPauseParams,
  ): RuntimeOutputPauseResult | Promise<RuntimeOutputPauseResult>;
  resumeOutput(
    params: RuntimeOutputResumeParams,
  ): RuntimeOutputResumeResult | Promise<RuntimeOutputResumeResult>;
}
