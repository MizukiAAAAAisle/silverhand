/**
 * RuntimeHandle — per-(conversation, agent) execution-plane state
 * owned by `RealSupervisor`.
 *
 * Step 2 commit 3a scope: this is the minimal handle for spawn /
 * output / hard-stop / exit. Subsequent commits will grow it with
 * parse-fanout state (3b), run-state lifecycle (3b), watchdog
 * timers (3c), retry/cooldown bookkeeping (3c), and lifecycle-lock
 * (3c). Each addition stays inside this file; consumers reach the
 * handle only through `RealSupervisor` methods.
 */
import type { ChildProcess } from 'node:child_process';
import type { Driver } from '../../drivers/index.js';

export type RuntimePhase =
  | 'spawning'
  | 'startup_pending'
  | 'ready'
  | 'draining'
  | 'exited';

export interface RuntimeHandle {
  readonly conversationId: string;
  readonly agentId: string;
  /** OS process id. Stable for the lifetime of the handle; `null` is
   *  not legal — if we don't have a pid the handle never gets
   *  created. */
  readonly pid: number;
  /** Wall-clock ms at spawn. Combined with `pid` to derive a stable
   *  `runId` for `runtime_state` events. */
  readonly startedAt: number;
  /** Live driver instance (per-spawn factory output). Holds any
   *  per-handle protocol counters codex/cursor accumulate. */
  readonly driver: Driver;
  /** The actual child process. Owned by the handle; cleanup releases
   *  stdio streams + removes listeners. */
  readonly child: ChildProcess;
  /** Current execution phase. Updated in-place by RealSupervisor as
   *  the process moves through its lifecycle. */
  phase: RuntimePhase;
  /** Output flow-control flag. `true` while `pauseOutput()` is in
   *  effect; raw stdout/stderr chunks are dropped silently while
   *  paused (no buffer-and-replay in 3a — 3b will revisit). */
  outputPaused: boolean;
  /** Final exit code observed via the child's `exit` event, or `null`
   *  if the process exited via signal without a code. Populated when
   *  phase transitions to `'exited'`; before then it is `null`. */
  exitCode: number | null;
  /** Whether the most recent transition to `draining` was caused by
   *  an intentional stop() / clearSession() / stopAll() request. Drives
   *  the `intentional` field on `runtime_exit`. Set true on stop;
   *  defaults to false (crash interpretation). */
  intentionalExit: boolean;
  /** Pending SIGTERM → SIGKILL timer, if a hard stop is in progress.
   *  Cleared when the child exits or the timer fires. */
  sigkillTimer: NodeJS.Timeout | null;
}
