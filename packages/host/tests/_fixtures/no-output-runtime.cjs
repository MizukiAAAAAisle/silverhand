#!/usr/bin/env node
/*
 * RealSupervisor 3c-b watchdog test fixture — a truly silent runtime.
 *
 * Unlike `echo-runtime.cjs`, this fixture writes NOTHING to stdout or
 * stderr at any point. It exists for tests that need to observe the
 * supervisor's "no bytes received at all" branch:
 *   - silence-tier init watchdog (no refresh → fires)
 *   - pre-protocol cap (no protocol line ever → fires)
 *   - global `initWatchdogMs` override (silence collapses to that value)
 *
 * Cindy `HyC05fC-FEs94uoZ` B1: the prior pattern reused `echo-runtime`
 * via `buildArgs: () => [execPath, '-e', 'setInterval(...);']`, which
 * collided with the test spawn seam (`[bin, ...args.slice(1)]`) and
 * actually ran `node echo-runtime.cjs -e setInterval(...)`. The
 * echo-runtime ignored the unknown `-e`/positional args and emitted
 * its usual `READY\n` line, which refreshed the silence timer and
 * made the test timing race against READY-arrival latency. This
 * fixture removes that ambiguity entirely: the spawn seam executes
 * `node no-output-runtime.cjs` and the child emits zero bytes until
 * it gets killed.
 *
 * Hard-stop behavior: default SIGTERM semantics. We do NOT install a
 * handler that swallows SIGTERM — the supervisor's normal hard-stop
 * cascade (and the watchdog kill path) MUST be able to take this
 * process down promptly. An explicit handler is registered only to
 * make the exit code deterministic across platforms (143 = 128+15)
 * since `process.exit(143)` is cleaner than the implicit-handler
 * exit code differences between macOS / Linux.
 */
'use strict';

// Argv parsing — keep minimal. The only optional flag is
// `--ignore-sigterm`, used by tests that need the SIGTERM grace
// window to stay open long enough to observe daemon behavior (e.g.
// the B3 wake-during-init-watchdog-kill regression). Default
// SIGTERM handling stays "exit 143 immediately" so the typical
// silence/pre-cap watchdog tests don't have to wait out the
// SIGTERM→SIGKILL cascade.
const args = process.argv.slice(2);
const ignoreSigterm = args.includes('--ignore-sigterm');

// Keep the event loop alive without producing any output. Unref'd so
// SIGTERM / SIGKILL can take us down immediately without waiting for
// this timer to drain.
setInterval(() => {}, 1000).unref();

if (ignoreSigterm) {
  // Deliberately swallow SIGTERM — exercises the supervisor's
  // SIGKILL escalation AND keeps the child alive during the
  // watchdog kill window so tests can observe `phase='draining'`
  // wake behavior between `failInitWatchdog` and `onChildExit`.
  process.on('SIGTERM', () => {
    /* swallow */
  });
} else {
  // Explicit SIGTERM handler — exits with 143 on every platform.
  // Pinned here so test assertions on exit_code/signal stay stable
  // across macOS and Linux. (Node's default action is also "exit
  // with signal", but the reported `exit` payload varies.)
  process.on('SIGTERM', () => {
    process.exit(143);
  });
}

// Read stdin so the supervisor's `wake` writes don't crash on EPIPE,
// but never echo or react. Tests that rely on watchdog firing don't
// write to stdin; tests that DO write (e.g. deferred-init arm) want
// the write to succeed without the child reacting.
process.stdin.resume();
process.stdin.on('data', () => {
  /* swallow */
});
