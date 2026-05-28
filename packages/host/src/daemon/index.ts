/**
 * Public daemon API for in-process consumers. The CLI entry
 * (`./entry.ts`) wraps `runDaemon` with argv parsing; tests can call
 * `runDaemon` directly with a config object to spin up + tear down a
 * real daemon inside the test process.
 */
export { runDaemon, type RunDaemonOptions, type RunningDaemon } from './run.js';
export { IntentDispatcher } from './dispatcher.js';
export { DaemonServer } from './server.js';
export { createDaemonLogControl, createDaemonLogger, type DaemonLogger } from './logger.js';
export { claimPidFile, releasePidFile, installShutdownHandlers } from './lifecycle.js';
export {
  OutboundDaemonClient,
  defaultDaemonHostConfigPath,
  hostConnectWebSocketUrl,
  readHostConfig,
  writeHostConfigAtomic,
  type HeartbeatOptions,
  type OutboundDaemonClientOptions,
  type OutboundWriteBufferOptions,
  type ReconnectBackoffOptions,
} from './outbound-client.js';
export { DAEMON_VERSION, createDaemonHelloResult } from './version.js';
