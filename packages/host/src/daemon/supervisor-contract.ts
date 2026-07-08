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
 * `runtime_delivery_consumed`, `runtime_exit`, ...) via the
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
  RuntimeDeliverParams,
  RuntimeDeliverResult,
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
} from '../protocol.js';

/**
 * Daemon-internal delivery context (#task:1417 Stage 3, §11.4.1). Carries the
 * *delivery-owner token* — the identity of the connection a `runtime_deliver`
 * arrived on, semantically aligned with the backend DB's `in_flight_owner`.
 *
 * It is **never** part of `RuntimeDeliverParamsSchema` (the wire): a sender
 * declaring its own owner would be redundant and spoofable. Each ingress
 * (`DaemonServer` per control socket, `LocalOutboundFrameServer` per socket,
 * `OutboundDaemonClient` per active WS generation) mints the owner and threads
 * it here; the supervisor never mints or guesses it.
 *
 * The owner is the load-bearing half of deferred-queue crash-safety: on that
 * connection's drop the ingress calls `cleanupDeferredForOwner(owner)` so the
 * daemon discards *only* that owner's queued (unwritten) batches — the backend
 * has already rolled those rows back to `pending`, so a later flush would
 * double-deliver, and a blind clear-all would discard other owners' custody.
 */
export interface DeliveryOwnerContext {
  owner: string;
}

/**
 * Resolve the delivery-owner token an ingress minted for a connection, or
 * throw if it is missing (#task:1417 Stage 3, §11.4.1).
 *
 * `owner` is a **load-bearing custody key**, not logging metadata: every
 * ingress mints one for a connection *before* any command on it can be read,
 * so its absence is a broken-connection invariant, never a normal case. A
 * fallback sentinel here would be a crash-safety hole — a `deferred` entry
 * enqueued under a guessed owner is one that the connection's close cleanup
 * can never reclaim (the sentinel is not in any owner map), so the DB row
 * stays in-flight forever with no daemon custody. Fail loud instead: each
 * ingress turns this throw into an `internal_error` response or drops the
 * offending connection — but it never dispatches `runtime_deliver` under a
 * guessed owner.
 */
export function resolveDeliveryOwner(
  owner: string | undefined,
  ingress: string,
): string {
  if (owner === undefined || owner.length === 0) {
    throw new Error(
      `${ingress}: command has no minted delivery owner — refusing to dispatch under a guessed owner (#task:1417 §11.4.1)`,
    );
  }
  return owner;
}

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
  /**
   * Daemon-authoritative delivery (#task:1417). The single delivery command
   * that subsumes the backend start-vs-wake fork: the daemon inspects the real
   * handle and picks spawn / write / defer / refuse. The synchronous
   * `RuntimeDeliverResult` transfers or refuses CUSTODY only — `delivered_at`
   * moves solely on the async `runtime_delivery_consumed`/`_failed` events the
   * supervisor emits.
   *
   * `ctx.owner` (Stage 3, §11.4.1) is the connection identity, injected by the
   * dispatcher/ingress — the supervisor stamps it onto any `deferred` queue
   * entry and NEVER mints or guesses it. Required: a delivery with no owner
   * could not be safely cleaned up on disconnect.
   */
  deliver(
    params: RuntimeDeliverParams,
    ctx: DeliveryOwnerContext,
  ): RuntimeDeliverResult | Promise<RuntimeDeliverResult>;
  /**
   * Owner-scoped deferred-queue cleanup (#task:1417 Stage 3, §11.4.1). Called
   * by an ingress when its connection drops (socket close / WS close /
   * reconnect / stop): discard ONLY the deferred (unwritten) batches this owner
   * enqueued, emitting NOTHING — the backend rolls the matching in-flight rows
   * back to `pending` on its own disconnect handler, and reconnect replay
   * re-drives them. Never clears another owner's custody; idempotent.
   */
  cleanupDeferredForOwner(owner: string): void;
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
