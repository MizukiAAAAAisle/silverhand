// Opt-in bridge for the Rust real-WS test. Uses an explicitly supplied installed
// Grok binary; never logs native configuration or credentials.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Supervisor } from '../../../src/daemon/supervisor/index.js';
import { GrokDriver } from '../../../src/drivers/grok.js';
import { createDaemonLogControl } from '../../../src/daemon/logger.js';
import { testRuntimeStartResolveDeps } from '../../_helpers/runtime-start-options.js';

const binary = process.env.GROK_TEST_BINARY;
if (!binary)
  throw new Error('GROK_TEST_BINARY must explicitly select a logged-out test installation.');
const root = mkdtempSync(join(tmpdir(), 'grok-auth-chain-'));
const input = createInterface({ input: process.stdin });
const noop = () => {};
const supervisor = new Supervisor({
  emit: (event) => {
    if (event.event === 'runtime_parsed_event')
      process.stdout.write(JSON.stringify({ event }) + '\n');
  },
  logger: {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('error'),
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    close: async () => {},
  },
  driverFor: () => new GrokDriver(),
  resolveRuntime: async () => ({ binary, version: '1.0.24' }),
  spawnFn: (bin, args, options) => spawn(bin, args, options),
  runtimeStartResolveDeps: testRuntimeStartResolveDeps({ agentHomeRootDir: join(root, 'agents') }),
  controlPlaneServerUrl: () => 'http://127.0.0.1:1',
  localSilverhandCliLauncher: { command: '/usr/bin/false', args: [] },
  emitRawRuntimeOutput: false,
  runtimePidRootDir: join(root, 'pids'),
  sigtermToSigkillMs: 100,
  sigkillTimeoutMs: 1000,
});

let params: any;
try {
  for await (const line of input) {
    if (params) break;
    params = JSON.parse(line);
    const result = await supervisor.start(params);
    process.stdout.write(JSON.stringify({ result }) + '\n');
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({ bridge_error: error instanceof Error ? error.message : 'bridge failed' }) +
      '\n',
  );
} finally {
  if (params)
    await supervisor.stop({
      runtime_scope: params.options.runtime_scope,
      runtime_generation: params.runtime_generation,
      mode: 'hard',
    });
  rmSync(root, { recursive: true, force: true });
}
