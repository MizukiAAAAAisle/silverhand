/**
 * Public daemon API for in-process consumers. The CLI entry
 * (`./entry.ts`) wraps `runDaemon` with argv parsing; tests can call
 * `runDaemon` directly with a config object to spin up + tear down a
 * real daemon inside the test process.
 */
export { runDaemon, type RunDaemonOptions, type RunningDaemon } from './run.js';
export { IntentDispatcher } from './dispatcher.js';
export { DaemonServer } from './server.js';
/**
 * @internal Exposed for backend e2e harnesses that need to inject a
 * real `Supervisor` with test `driverFor` / `spawnFn` seams (see
 * `packages/backend/tests/e2e/g2-harness.ts`'s
 * `bootDaemonWithSupervisor`). Production code MUST go through
 * `runDaemon({ supervisorFactory: ... })` — never `new Supervisor`
 * directly, since `runDaemon` is what wires the dispatcher +
 * outbound supervisor + lifecycle around it. A future re-organize
 * may move these behind a `./daemon/testing` subpath export.
 */
export { Supervisor, type SupervisorOptions } from './supervisor/index.js';
export type { SupervisorContract } from './supervisor-contract.js';
export { createDaemonLogControl, createDaemonLogger, type DaemonLogger } from './logger.js';
export { claimPidFile, releasePidFile, installShutdownHandlers } from './lifecycle.js';
export {
  OutboundDaemonClient,
  hostConnectWebSocketUrl,
  readHostConfig,
  writeHostConfigAtomic,
  type HeartbeatOptions,
  type OutboundDaemonClientOptions,
  type OutboundWriteBufferOptions,
  type ReconnectBackoffOptions,
} from './outbound-client.js';
export { DAEMON_VERSION, createDaemonHelloResult } from './version.js';
