/**
 * Public daemon API for in-process consumers. The CLI entry
 * (`./entry.ts`) wraps `runDaemon` with argv parsing; tests can call
 * `runDaemon` directly with a config object to spin up + tear down a
 * real daemon inside the test process.
 */
export { runDaemon, type RunDaemonOptions, type RunningDaemon } from './run.js';
export { IntentDispatcher } from './dispatcher.js';
export { DaemonServer } from './server.js';
export { createDaemonLogger, type DaemonLogger } from './logger.js';
export { claimPidFile, releasePidFile, installShutdownHandlers } from './lifecycle.js';
export { DAEMON_VERSION } from './version.js';
