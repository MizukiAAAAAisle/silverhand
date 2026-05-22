#!/usr/bin/env node
/**
 * `silverhand-daemon` process entry. Thinnest possible argv shim
 * around `runDaemon`. Spawned by Electron main (and `dev:headless`)
 * before the backend boots; can also be invoked directly by an
 * operator for diagnostics.
 *
 * Argv contract:
 *
 *   --socket-path <abs>   (required) where to bind the Unix socket
 *   --pid-file   <abs>    (required) where to write the pid lock file
 *   --log-dir    <abs>    (required) where to write daemon-*.log
 *   --stderr              optional; mirror log lines to stderr too
 *
 * Stdout:
 *   one NDJSON line on successful bind:
 *     {"event":"ready","socket_path":"...","daemon_pid":...,...}
 *   followed by nothing — stdout is reserved for the handshake.
 *
 * Stderr:
 *   parse errors before bind; nothing else unless `--stderr` is set.
 *
 * Exit codes:
 *   0  clean shutdown via SIGINT/SIGTERM
 *   1  argv parse failure / pre-bind error
 *   2  another daemon already owns the pid file
 *
 * Why all paths are required and absolute: the spawn helper builds
 * them deterministically and tests inject them. We don't apply
 * defaults in the entry — that would let a misconfigured operator
 * silently write the pid file under `process.cwd()` and rebuild every
 * dev run.
 */
import { runDaemon } from './run.js';
import { Supervisor } from './supervisor/index.js';

interface ParsedArgv {
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  alsoStderr: boolean;
}

function parseArgv(argv: readonly string[]): ParsedArgv | { error: string } {
  let socketPath: string | null = null;
  let pidFilePath: string | null = null;
  let logDir: string | null = null;
  let alsoStderr = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--socket-path':
        socketPath = argv[++i] ?? null;
        break;
      case '--pid-file':
        pidFilePath = argv[++i] ?? null;
        break;
      case '--log-dir':
        logDir = argv[++i] ?? null;
        break;
      case '--stderr':
        alsoStderr = true;
        break;
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }
  if (!socketPath) return { error: '--socket-path is required' };
  if (!pidFilePath) return { error: '--pid-file is required' };
  if (!logDir) return { error: '--log-dir is required' };
  if (!socketPath.startsWith('/')) return { error: '--socket-path must be absolute' };
  if (!pidFilePath.startsWith('/')) return { error: '--pid-file must be absolute' };
  if (!logDir.startsWith('/')) return { error: '--log-dir must be absolute' };
  return { socketPath, pidFilePath, logDir, alsoStderr };
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`silverhand-daemon: ${parsed.error}\n`);
    process.exit(1);
  }
  try {
    await runDaemon({
      socketPath: parsed.socketPath,
      pidFilePath: parsed.pidFilePath,
      logDir: parsed.logDir,
      installSignals: true,
      writeStdoutHandshake: true,
      alsoStderr: parsed.alsoStderr,
      // Production wire: Supervisor owns spawn/wake/stop and the
      // per-(conv, agent) AgentRunState lifecycle. Without this factory
      // `runDaemon` boots a PR-1 surface (ping/status/echo) only, and
      // every `runtime_*` intent returns `internal_error: runtime_*
      // intent reached dispatcher with no supervisor wired` — the
      // exact daemon-mode boot bug Cindy diagnosed in `MlwnvOfs-L5Nv_x2`.
      // The test helper supervisor validates protocol wiring without a
      // real CLI child; production wires Supervisor.
      supervisorFactory: deps => new Supervisor(deps),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(`silverhand-daemon: ${e.message}\n`);
    process.exit(e.code === 'EALREADY' ? 2 : 1);
  }
  // We deliberately do NOT call process.stdin.resume() here — the
  // shutdown handler installed by runDaemon takes care of keeping the
  // process alive (the listening socket has open handles); when it
  // tears down via process.exit() we want a clean exit, not an event-
  // loop wait.
}

void main();
