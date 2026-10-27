import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLocalSilverhandCliLauncher } from '../src/daemon/silverhand-cli-launcher.js';
import { Supervisor } from '../src/daemon/supervisor/index.js';
import { createDaemonLogControl } from '../src/daemon/logger.js';
import { createRequire } from 'node:module';
import { spawnDaemonChild } from '../src/spawn.js';
import { HostClient } from '../src/client/index.js';
import { testStartOptions, testRuntimeStartResolveDeps } from './_helpers/runtime-start-options.js';

const repo = resolve(__dirname, '../../..');
const electron = createRequire(join(repo, 'apps/desktop/package.json'))('electron') as string;
const esbuild = join(repo, 'packages/host/node_modules/.bin/esbuild');

describe('dev daemon package runtime handoff', () => {
  it('hands runtime_start a working local CLI with no server launcher; incomplete layouts still refuse before spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-dev-cli-'));
    const launcher = {
      command: electron,
      args: [join(root, 'packages/silverhand-daemon/dist/daemon.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
    const dist = join(root, 'packages/silverhand-daemon/dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}');
    // Build fresh bundles into the isolated dev layout, never replacing dist
    // used by a running app. These are the same entries/options as package build.
    for (const [pkg, entry, output] of [
      ['host', 'src/daemon/entry.ts', 'daemon.js'],
      ['cli', 'src/cli.ts', 'cli.js'],
    ]) {
      execFileSync(
        esbuild,
        [
          entry!,
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--target=node20',
          `--outfile=${join(dist, output!)}`,
          '--banner:js=import{createRequire}from"node:module";const require=createRequire(import.meta.url);',
        ],
        { cwd: join(repo, 'packages', pkg!), stdio: 'pipe' },
      );
    }
    const local = resolveLocalSilverhandCliLauncher({
      entryUrl: pathToFileURL(launcher.args[0]!).href,
      execPath: launcher.command,
    });
    expect(local).toEqual({
      command: electron,
      args: [join(dist, 'cli.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(
      execFileSync(local!.command, [...local!.args, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, ...launcher.env },
      }),
    ).toContain('silverhand');

    // Boot the actual selected bundle with Electron-as-Node. Runtime admission
    // below is tested separately with a model-process fixture, without account
    // binding or any connection to the user's control plane.
    const socketPath = join(root, 'd.sock');
    const child = await spawnDaemonChild({
      launcher,
      socketPath,
      pidFilePath: join(root, 'd.pid'),
      logDir: join(root, 'logs'),
      daemonIdentityPath: join(root, 'identity.json'),
      computersRootDir: join(root, 'computers'),
      silverhandStateRootDir: join(root, 'state'),
      maxRestarts: 0,
      readyTimeoutMs: 10_000,
    });
    const client = new HostClient({ socketPath });
    try {
      await client.connect();
      expect(await client.runtimeStatus({})).toEqual({ runtimes: [] });
    } finally {
      await client.close();
      await child.kill({ gracefulMs: 2000 });
    }

    let spawns = 0;
    let shimHelp = '';
    const noop = () => {};
    const startOptions = testStartOptions({ sessionScope: 'agent' });
    delete startOptions.env_policy.silverhand_cli;
    const scope = startOptions.runtime_scope;
    const params = {
      runtime_generation: 1,
      conversation_id: 'Conversation0001',
      agent_id: 'a1',
      options: startOptions,
    };
    const makeSupervisor = (localLauncher: typeof local) =>
      new Supervisor({
        emit: noop,
        logger: {
          filePath: '/dev/null',
          logControl: createDaemonLogControl('debug'),
          debug: noop,
          info: noop,
          warn: noop,
          error: noop,
          close: async () => {},
        },
        localSilverhandCliLauncher: localLauncher,
        runtimeStartResolveDeps: testRuntimeStartResolveDeps({
          agentHomeRootDir: join(root, 'agents'),
        }),
        controlPlaneServerUrl: () => 'http://127.0.0.1:1',
        driverFor: () => ({
          // Only the external model process is a fixture. Real Supervisor.start
          // constructs the prompt, CLI shim and environment before spawning it.
          kind: 'claude' as const,
          binary: process.execPath,
          kickoffMode: 'self_inits' as const,
          releaseProfile: 'native-steer' as const,
          admissionPolicy: 'write-success' as const,
          oneShot: false,
          supportsNativeStandingPrompt: true,
          initLivenessSilenceMs: 30_000,
          initPreProtocolCapMs: 300_000,
          initPostProtocolMs: 60_000,
          applyEnv: (env) => ({ ...env }),
          buildArgs: () => ['-e', 'process.stdin.resume()'],
          encodeStdinMessage: (text) => text,
          encodeInterruptControl: () => null,
          parseLine: () => [],
          classifyInitProgress: () => null,
        }),
        resolveRuntime: async () => ({ binary: process.execPath, version: null }),
        spawnFn: (binary, args, options) => {
          spawns++;
          // Execute the generated per-runtime shim in the actual child env.
          const shellEnv = { ...options.env };
          delete shellEnv.ELECTRON_RUN_AS_NODE;
          shimHelp = execFileSync('silverhand', ['--help'], {
            cwd: options.cwd,
            env: shellEnv,
            encoding: 'utf8',
            timeout: 5000,
          });
          return spawn(binary, args, options);
        },
        sigtermToSigkillMs: 50,
        sigkillTimeoutMs: 200,
      });
    const supervisor = makeSupervisor(local);
    try {
      const result = await supervisor.start(params);
      expect(result.started).toBe(true);
      expect(spawns).toBe(1);
      expect(shimHelp).toContain('silverhand');
      await supervisor.stop({ runtime_scope: scope, runtime_generation: 1, mode: 'hard' });
      // The former host-only layout cannot obtain a CLI via another package
      // or global PATH. A missing local + absent server launcher stays an error.
      const absent = resolveLocalSilverhandCliLauncher({
        entryUrl: pathToFileURL(join(root, 'packages/host/dist/daemon.js')).href,
      });
      expect(absent).toBeNull();
      await expect(makeSupervisor(absent).start(params)).rejects.toThrow(
        'no silverhand CLI launcher',
      );
      expect(spawns).toBe(1);
    } finally {
      await supervisor
        .stop({ runtime_scope: scope, runtime_generation: 1, mode: 'hard' })
        .catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
