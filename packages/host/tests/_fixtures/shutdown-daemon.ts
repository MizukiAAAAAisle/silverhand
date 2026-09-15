import { join } from 'node:path';
import { runDaemon } from '../../src/daemon/run.js';
import { Supervisor } from '../../src/daemon/supervisor/index.js';
import type { Driver } from '../../src/drivers/index.js';
import { testRuntimeStartResolveDeps } from '../_helpers/runtime-start-options.js';

const root = process.env.SILVERHAND_DIR;
if (!root) throw new Error('isolated SILVERHAND_DIR required');
const driver: Driver = {
  kind: 'claude',
  binary: process.execPath,
  kickoffMode: 'self_inits',
  releaseProfile: 'native-steer',
  admissionPolicy: 'write-success',
  oneShot: false,
  supportsNativeStandingPrompt: true,
  initLivenessSilenceMs: 30_000,
  initPreProtocolCapMs: 60_000,
  initPostProtocolMs: 60_000,
  buildArgs: () => [join(import.meta.dirname, 'echo-runtime.cjs'), '--ignore-sigterm'],
  applyEnv: (env) => env,
  encodeStdinMessage: (text) => text,
  encodeInterruptControl: () => null,
  parseLine: () => [],
  classifyInitProgress: () => null,
};

await runDaemon({
  socketPath: join(root, 'd.sock'),
  pidFilePath: join(root, 'd.pid'),
  logDir: join(root, 'logs'),
  daemonIdentityPath: join(root, 'identity.json'),
  runtimePidRootDir: join(root, 'runtime-pids'),
  agentHomeRootDir: join(root, 'agents'),
  installSignals: true,
  writeStdoutHandshake: true,
  alsoStderr: false,
  supervisorFactory: (deps) =>
    new Supervisor({
      ...deps,
      driverFor: () => driver,
      resolveRuntime: async () => ({ binary: process.execPath, version: null }),
      runtimeStartResolveDeps: testRuntimeStartResolveDeps({
        agentHomeRootDir: join(root, 'agents'),
      }),
      controlPlaneServerUrl: () => 'http://127.0.0.1:1',
      emitRawRuntimeOutput: true,
      // Keep production drain timings: this catches the old Desktop 5s kill
      // racing the supervisor's 5s SIGKILL escalation.
    }),
});
