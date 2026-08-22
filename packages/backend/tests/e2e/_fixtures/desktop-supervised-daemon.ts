#!/usr/bin/env node
/**
 * Isolated daemon subprocess used by lifecycle-integration tests.
 *
 * The parent launches this file through production `spawnDaemonChild`, so the
 * process tree is the same shape as Desktop main -> daemon -> runtime child.
 * Every filesystem coordinate is supplied by the test's temporary root.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import {
  runDaemon,
  Supervisor,
  type SupervisorOptions,
} from '@silverhand/host/daemon';
import type {
  Driver,
  DriverSpawnContext,
  ParsedEvent,
} from '@silverhand/host/drivers';

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO_FIXTURE = join(
  HERE,
  '../../../../host/tests/_fixtures/echo-runtime.cjs',
);
const SILENT_FIXTURE = join(
  HERE,
  '../../../../host/tests/_fixtures/no-output-runtime.cjs',
);
const SESSION_PREFIX = '__LIFECYCLE_SESSION_INIT__:';

interface ParsedArgs {
  socketPath: string;
  pidFilePath: string;
  logDir: string;
  hostConfigPath: string;
  runtimePidRootDir: string;
  agentHomeRootDir: string;
  shortWatchdogs: boolean;
}

function required(map: Map<string, string>, flag: string): string {
  const value = map.get(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--stderr') continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    i += 1;
  }
  return {
    socketPath: required(values, '--socket-path'),
    pidFilePath: required(values, '--pid-file'),
    logDir: required(values, '--log-dir'),
    hostConfigPath: required(values, '--host-config'),
    runtimePidRootDir: required(values, '--runtime-pid-root-dir'),
    agentHomeRootDir: required(values, '--test-agent-home-root'),
    shortWatchdogs: values.get('--test-short-watchdogs') === 'true',
  };
}

function streamJsonUser(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

function runtimeArgs(ctx: DriverSpawnContext): string[] {
  if (ctx.agentId.includes('duringinit')) {
    return [SILENT_FIXTURE];
  }
  if (ctx.agentId.includes('preinit')) {
    return [ECHO_FIXTURE, '--sleep', '15', '--exit-code', '41'];
  }
  if (ctx.agentId.includes('auth')) {
    return [
      ECHO_FIXTURE,
      '--echo-stderr',
      'Not logged in',
      '--sleep',
      '25',
      '--exit-code',
      '42',
    ];
  }
  const args = [
    ECHO_FIXTURE,
    '--emit-line',
    `${SESSION_PREFIX}session-${ctx.agentId}`,
    '--echo-stdin',
  ];
  if (ctx.agentId.includes('runningcrash')) {
    args.push('--sleep', '600', '--exit-code', '42');
  }
  return args;
}

function makeDriver(): Driver {
  return {
    kind: 'claude',
    binary: execPath,
    kickoffMode: 'self_inits',
    releaseProfile: 'native-steer',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    // Keep the failure matrix fast without making a healthy child lose a
    // scheduler race when this test runs beside the full backend suite.
    initLivenessSilenceMs: 500,
    initPreProtocolCapMs: 1_000,
    initPostProtocolMs: 500,
    buildArgs: runtimeArgs,
    applyEnv: env => ({ ...env }),
    encodeStdinMessage: text => streamJsonUser(text),
    encodeInterruptControl: () => null,
    parseLine: (line: string): ParsedEvent[] => {
      const index = line.indexOf(SESSION_PREFIX);
      if (index < 0) return [];
      return [{
        kind: 'session_init',
        sessionId: line.slice(index + SESSION_PREFIX.length).trim(),
      }];
    },
    classifyInitProgress: line =>
      line.includes(SESSION_PREFIX) ? 'session_ready' : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spawnFn: NonNullable<SupervisorOptions['spawnFn']> = (
    binary,
    childArgs,
    options,
  ) => nodeSpawn(binary, childArgs, options);
  await runDaemon({
    socketPath: args.socketPath,
    pidFilePath: args.pidFilePath,
    logDir: args.logDir,
    hostConfigPath: args.hostConfigPath,
    runtimePidRootDir: args.runtimePidRootDir,
    agentHomeRootDir: args.agentHomeRootDir,
    daemonIdentityPath: null,
    installSignals: true,
    writeStdoutHandshake: true,
    alsoStderr: false,
    supervisorFactory: deps => new Supervisor({
      ...deps,
      driverFor: () => makeDriver(),
      resolveRuntime: async (_kind, fallback) => ({
        binary: fallback,
        version: null,
      }),
      spawnFn,
      localSilverhandCliLauncher: { command: 'true', args: [] },
      initMaxRetries: 1,
      initFailureCooldownThreshold: 2,
      initFailureCooldownMs: 60_000,
      initLivenessSilenceMs: args.shortWatchdogs ? 1_000 : 60_000,
      initPreProtocolCapMs: args.shortWatchdogs ? 1_500 : 60_000,
      initPostProtocolMs: args.shortWatchdogs ? 1_000 : 60_000,
      sigtermToSigkillMs: 30,
      sigkillTimeoutMs: 300,
    }),
  });
}

void main().catch(error => {
  process.stderr.write(
    `desktop-supervised-daemon fixture failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
