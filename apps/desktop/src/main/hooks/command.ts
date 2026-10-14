import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { HOOK_LIMITS, type HookRule, type HookRun } from '@silverhand/client';

export type CommandResult = Pick<
  HookRun,
  'status' | 'exitCode' | 'reason' | 'stdout' | 'stderr' | 'truncated'
>;
export interface RunningCommand {
  done: Promise<CommandResult>;
  cancel(): void;
}
const OUTPUT_BYTES = HOOK_LIMITS.outputBytes;

/** Executes trusted user commands, never user code in the Electron event loop. */
export function startCommand(action: HookRule['action'], input: string): RunningCommand {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('/bin/sh', ['-c', action.command], {
      cwd: action.cwd ?? homedir(),
      env: { ...process.env, ...action.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    return {
      cancel() {},
      done: Promise.resolve({
        status: 'failed',
        reason: String(error),
        stdout: '',
        stderr: '',
        truncated: false,
      }),
    };
  }
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let outBytes = 0,
    errBytes = 0,
    truncated = false,
    finished = false;
  let stopped: 'timed_out' | 'cancelled' | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (value: CommandResult) => void;
  const done = new Promise<CommandResult>((resolve) => {
    resolveDone = resolve;
  });
  const signal = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* Already reaped; no group left. */
    }
  };
  const finish = (code: number | null, reason?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    // Normal completion releases ownership; background children may finish independently.
    // Cancellation still reclaims the running job's process group.
    if (stopped) signal('SIGKILL');
    resolveDone({
      status: stopped ?? (code === 0 && !reason ? 'succeeded' : 'failed'),
      exitCode: code,
      reason,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      truncated,
    });
  };
  const stop = (status: 'timed_out' | 'cancelled') => {
    if (finished || stopped) return;
    stopped = status;
    signal('SIGTERM');
    killTimer = setTimeout(() => {
      signal('SIGKILL');
      // Bounded completion even if an escaped descendant kept a pipe open.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      finish(null, status === 'timed_out' ? 'Command timed out' : 'Command cancelled');
    }, 250);
  };
  const timeout = setTimeout(
    () => stop('timed_out'),
    action.timeoutMs ?? HOOK_LIMITS.defaultTimeoutMs,
  );
  child.stdout.on('data', (chunk: Buffer) => {
    if (finished) return;
    const keep = chunk.subarray(0, Math.max(0, OUTPUT_BYTES - outBytes));
    if (keep.length) stdout.push(Buffer.from(keep));
    outBytes += keep.length;
    if (keep.length < chunk.length) truncated = true;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (finished) return;
    const keep = chunk.subarray(0, Math.max(0, OUTPUT_BYTES - errBytes));
    if (keep.length) stderr.push(Buffer.from(keep));
    errBytes += keep.length;
    if (keep.length < chunk.length) truncated = true;
  });
  child.once('error', (error) => finish(null, error.message));
  child.once('close', (code, sig) => finish(code, sig ? `Terminated by ${sig}` : undefined));
  // A command is allowed to ignore stdin and exit before we finish writing.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return { done, cancel: () => stop('cancelled') };
}
