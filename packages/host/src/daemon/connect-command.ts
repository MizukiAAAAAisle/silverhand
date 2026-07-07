import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  apiPaths,
  readAllowInsecureRemoteFlag,
  type DaemonHostConfig,
} from '@silverhand/shared';
import { runDaemon } from './run.js';
import { Supervisor } from './supervisor/index.js';
import type { DaemonIdentity } from './identity.js';
import { hostConnectWebSocketUrl } from './outbound-client.js';
import { defaultConnectDataRoot } from './computer-profile.js';
import { logDaemon } from './daemon-logging.js';

export interface ConnectCommandOptions {
  serverUrl: string;
  connectToken: string;
  dataRoot: string | null;
  alsoStderr: boolean;
}

export type ConnectParseResult =
  | { ok: true; options: ConnectCommandOptions }
  | { ok: false; exitCode: number; message: string };

export function parseConnectArgv(argv: readonly string[]): ConnectParseResult {
  let serverUrl: string | null = null;
  let connectToken: string | null = null;
  let dataRoot: string | null = null;
  let alsoStderr = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { ok: false, exitCode: 0, message: connectUsage() };
      case '--server-url':
        serverUrl = argv[++i] ?? null;
        break;
      case '--connect-token':
        connectToken = argv[++i] ?? null;
        break;
      case '--data-root':
        dataRoot = argv[++i] ?? null;
        break;
      case '--quiet':
        alsoStderr = false;
        break;
      case '--stderr':
        alsoStderr = true;
        break;
      default:
        return {
          ok: false,
          exitCode: 1,
          message: `unknown connect argument: ${arg}\n\n${connectUsage()}`,
        };
    }
  }

  if (!serverUrl) {
    return { ok: false, exitCode: 1, message: `--server-url is required\n\n${connectUsage()}` };
  }
  if (!connectToken) {
    return {
      ok: false,
      exitCode: 1,
      message: `--connect-token is required\n\n${connectUsage()}`,
    };
  }
  if (dataRoot !== null && !dataRoot.startsWith('/')) {
    return { ok: false, exitCode: 1, message: '--data-root must be absolute' };
  }

  return {
    ok: true,
    options: {
      serverUrl,
      connectToken,
      dataRoot,
      alsoStderr,
    },
  };
}

export async function runConnectCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  const parsed = parseConnectArgv(argv);
  if (!parsed.ok) {
    const stream = parsed.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(`silverhand-daemon connect: ${parsed.message}\n`);
    return parsed.exitCode;
  }

  const allowInsecureRemote = readAllowInsecureRemoteFlag(env);
  try {
    hostConnectWebSocketUrl(parsed.options.serverUrl, { allowInsecureRemote });
  } catch (err) {
    process.stderr.write(
      `silverhand-daemon connect: invalid --server-url: ${(err as Error).message}\n`,
    );
    return 1;
  }

  let hostId: string;
  try {
    hostId = await resolveConnectHostId({
      serverUrl: parsed.options.serverUrl,
      connectToken: parsed.options.connectToken,
    });
  } catch (err) {
    process.stderr.write(
      `silverhand-daemon connect: ${(err as Error).message}\n`,
    );
    return 1;
  }
  const dataRoot =
    parsed.options.dataRoot ??
    defaultConnectDataRoot(hostId);
  mkdirSync(dataRoot, { recursive: true });

  const hostConfig: DaemonHostConfig = {
    server_url: parsed.options.serverUrl,
    host_id: hostId,
    host_token: parsed.options.connectToken,
    ...(allowInsecureRemote ? { allow_insecure_remote: true } : {}),
  };
  const daemonIdentity: DaemonIdentity = {
    daemon_id: hostId,
    host_descriptor: {
      name: hostname() || 'Computer',
      kind: 'remote',
    },
  };

  const logDir = join(dataRoot, 'logs');
  const running = await runDaemon({
    socketPath: join(dataRoot, 'daemon.sock'),
    pidFilePath: join(dataRoot, 'daemon.pid'),
    logDir,
    runtimePidRootDir: join(dataRoot, 'runtime-pids'),
    agentHomeRootDir: join(dataRoot, 'agents'),
    proxyConfigPath: join(dataRoot, 'proxy-config.json'),
    hostConfig,
    daemonIdentity,
    daemonIdentityPath: null,
    installSignals: true,
    writeStdoutHandshake: false,
    alsoStderr: parsed.options.alsoStderr,
    supervisorFactory: deps => new Supervisor(deps),
  });
  logDaemon(running.logger, {
    action: 'connect_ready',
    pid: process.pid,
    host_id: hostId,
    data_root: dataRoot,
    log_dir: logDir,
  });
  return null;
}

export async function resolveConnectHostId(input: {
  serverUrl: string;
  connectToken: string;
}): Promise<string> {
  const url = new URL(apiPaths.hostConnectTokenResolve, input.serverUrl);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.connectToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `server rejected connection command (${response.status} ${response.statusText})`,
    );
  }
  const body = (await response.json()) as unknown;
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { host_id?: unknown }).host_id !== 'string' ||
    !(body as { host_id: string }).host_id
  ) {
    throw new Error('server returned an invalid connect-token resolve response');
  }
  return (body as { host_id: string }).host_id;
}

function connectUsage(): string {
  return [
    'Usage:',
    '  silverhand-daemon connect --server-url <url> --connect-token <token> [--data-root <abs>]',
    '',
    'Options:',
    '  --server-url       Silverhand server URL.',
    '  --connect-token    Connection credential shown once by the app.',
    '  --data-root        Optional absolute root for daemon runtime files.',
    '  --quiet            Do not mirror daemon logs to stderr.',
  ].join('\n');
}
