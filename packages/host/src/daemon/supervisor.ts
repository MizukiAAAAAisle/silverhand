/**
 * Supervisor — daemon-side abstraction over the (conversation, agent)
 * runtime. PR-2 step 1 ships a fake implementation
 * (`FakeSupervisor`); step 2 will ship a real one carved out of
 * `packages/backend/src/conversation-manager.ts`.
 *
 * The interface is the contract both implementations honor. By
 * pinning it before step 2, we guarantee step 2 is a drop-in swap —
 * no dispatcher / server / HostClient code paths change.
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
  RuntimeClearSessionParams,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogParams,
  RuntimeCloseActivityLogResult,
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

export interface Supervisor {
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
}
