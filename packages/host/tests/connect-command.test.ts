import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleConnectCommand,
  buildConnectArgv,
} from '@silverhand/shared';
import {
  defaultConnectRuntimePaths,
  discoverStopTarget,
  explicitConnectRuntimePaths,
  formatStopCommand,
  parseConnectArgv,
  parseStopArgv,
  runConnectCommand,
  stopRuntimePaths,
} from '../src/daemon/connect-command';

describe('silverhand-daemon connect command', () => {
  it('parses the product command without host id', () => {
    const parsed = parseConnectArgv([
      '--server-url',
      'http://127.0.0.1:18080',
      '--connect-token',
      'ct_123',
    ]);

    expect(parsed).toEqual({
      ok: true,
      options: {
        serverUrl: 'http://127.0.0.1:18080',
        connectToken: 'ct_123',
        dataRoot: null,
        dataRootOrigin: 'explicit',
        alsoStderr: true,
        daemonMode: true,
      },
    });
  });

  it('supports explicit foreground mode', () => {
    const parsed = parseConnectArgv([
      '--server-url',
      'http://127.0.0.1:18080',
      '--connect-token',
      'ct_123',
      '--foreground',
    ]);

    expect(parsed).toEqual({
      ok: true,
      options: {
        serverUrl: 'http://127.0.0.1:18080',
        connectToken: 'ct_123',
        dataRoot: null,
        dataRootOrigin: 'explicit',
        alsoStderr: true,
        daemonMode: false,
      },
    });
  });

  it('can read the connect token from an environment variable for detached children', () => {
    const parsed = parseConnectArgv(
      [
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token-env',
        'SILVERHAND_DAEMON_CONNECT_TOKEN',
      ],
      { SILVERHAND_DAEMON_CONNECT_TOKEN: 'ct_from_env' },
    );

    expect(parsed).toEqual({
      ok: true,
      options: {
        serverUrl: 'http://127.0.0.1:18080',
        connectToken: 'ct_from_env',
        dataRoot: null,
        dataRootOrigin: 'explicit',
        alsoStderr: true,
        daemonMode: true,
      },
    });
  });

  it('fails loud when the requested connect-token env var is missing', () => {
    expect(
      parseConnectArgv([
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token-env',
        'SILVERHAND_DAEMON_CONNECT_TOKEN',
      ], {}),
    ).toMatchObject({
      ok: false,
      exitCode: 1,
      message: '--connect-token-env SILVERHAND_DAEMON_CONNECT_TOKEN is not set',
    });
  });

  it('rejects relative data roots', () => {
    const parsed = parseConnectArgv([
      '--server-url',
      'http://127.0.0.1:18080',
      '--connect-token',
      'ct_123',
      '--data-root',
      'relative',
    ]);

    expect(parsed).toMatchObject({
      ok: false,
      exitCode: 1,
      message: '--data-root must be absolute',
    });
  });

  // Single-source guard: the edge-side argv builder (`@silverhand/shared`) and
  // the daemon-side parser (here) must stay exact inverses. If either drifts on
  // a flag name, this round trip breaks — that is the whole point of hoisting
  // the arg-name contract to shared instead of duplicating literals.
  it('round-trips buildConnectArgv → parseConnectArgv (assemble⇄parse single source)', () => {
    const cases = [
      { serverUrl: 'https://silverhand.ai', connectToken: 'ct_abc123' },
      { serverUrl: 'http://127.0.0.1:18080', connectToken: 'ct_x/y+z=' },
    ];
    for (const input of cases) {
      const parsed = parseConnectArgv(buildConnectArgv(input));
      expect(parsed).toEqual({
        ok: true,
        options: {
          serverUrl: input.serverUrl,
          connectToken: input.connectToken,
          dataRoot: null,
          dataRootOrigin: 'explicit',
          alsoStderr: true,
          daemonMode: true,
        },
      });
    }
  });

  it('assembleConnectCommand emits an npx connect invocation with the recipe', () => {
    const command = assembleConnectCommand({
      daemonNpmSpec: '@silverhand-ai/daemon@latest',
      serverUrl: 'https://silverhand.ai',
      connectToken: 'ct_abc123',
    });
    expect(command).toBe(
      'npx @silverhand-ai/daemon@latest connect --server-url https://silverhand.ai --connect-token ct_abc123',
    );
  });

  it('parses the explicit stop data root', () => {
    expect(parseStopArgv(['--data-root', '/tmp/silverhand computer'])).toEqual({
      ok: true,
      options: { dataRoot: '/tmp/silverhand computer' },
    });
  });

  it('allows argless stop for single-instance auto-discovery', () => {
    expect(parseStopArgv([])).toEqual({
      ok: true,
      options: { dataRoot: null },
    });
  });

  it('rejects relative stop data roots', () => {
    expect(parseStopArgv(['--data-root', 'relative'])).toMatchObject({
      ok: false,
      exitCode: 1,
      message: '--data-root must be absolute',
    });
  });

  it('rejects a stop data-root flag without a value', () => {
    expect(parseStopArgv(['--data-root'])).toMatchObject({
      ok: false,
      exitCode: 1,
      message: '--data-root requires a value',
    });
  });

  it('formats a copy-pasteable stop command for the exact data root', () => {
    expect(formatStopCommand('/tmp/silverhand computer')).toBe(
      "npx @silverhand-ai/daemon@latest stop --data-root '/tmp/silverhand computer'",
    );
  });

  // #task:1608 R2-3 falsifiers — origin is a FACT carried on the argv, and
  // the two profile shapes are separate explicit resolvers (no path
  // sniffing at start). A default profile keeps only DURABLE state in the
  // slot; transient run files and logs are app-scoped. An explicit root
  // stays flat and self-contained.
  it('parses the internal --data-root-origin flag the detached child inherits', () => {
    const parsed = parseConnectArgv([
      '--server-url',
      'http://127.0.0.1:18080',
      '--connect-token',
      'ct_123',
      '--data-root',
      '/home/u/.silverhand/computers/host_1',
      '--data-root-origin',
      'default',
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      options: {
        dataRoot: '/home/u/.silverhand/computers/host_1',
        dataRootOrigin: 'default',
      },
    });
  });

  it('rejects --data-root-origin without --data-root and rejects unknown origin values', () => {
    expect(
      parseConnectArgv([
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token',
        'ct_123',
        '--data-root-origin',
        'default',
      ]),
    ).toMatchObject({ ok: false, exitCode: 1 });
    expect(
      parseConnectArgv([
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token',
        'ct_123',
        '--data-root',
        '/data/custom',
        '--data-root-origin',
        'shape-guess',
      ]),
    ).toMatchObject({ ok: false, exitCode: 1 });
  });

  it('an explicit --data-root inside the reserved computers/ namespace is rejected before any side effect', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'silverhand-reserved-'));
    const prevEnv = process.env.SILVERHAND_DIR;
    process.env.SILVERHAND_DIR = stateRoot;
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const requested = join(stateRoot, 'computers', 'custom');
      const code = await runConnectCommand([
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token',
        'ct_123',
        '--data-root',
        requested,
      ]);
      expect(code).toBe(1);
      expect(stderrWrites.join('')).toContain('reserved');
      // Fail closed with ZERO side effects: neither the requested root nor
      // any redirected run/log dirs were created.
      expect(existsSync(requested)).toBe(false);
      expect(existsSync(join(stateRoot, 'run'))).toBe(false);
      expect(existsSync(join(stateRoot, 'logs'))).toBe(false);
    } finally {
      process.stderr.write = origWrite;
      if (prevEnv === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = prevEnv;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('a forged --data-root-origin default with a non-canonical root is rejected (the flag cannot promote arbitrary paths)', async () => {
    // Cindy R2 gate: the internal origin flag is parent→child provenance
    // ONLY. The child must recompute the canonical default root from the
    // hostId IT resolved and refuse any mismatch — otherwise the flag
    // would grant any path the default-profile (app-scoped run/log)
    // treatment.
    const stateRoot = mkdtempSync(join(tmpdir(), 'silverhand-forged-'));
    const prevEnv = process.env.SILVERHAND_DIR;
    process.env.SILVERHAND_DIR = stateRoot;
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ host_id: 'host-real' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const forged = join(stateRoot, 'elsewhere', 'evil');
      const code = await runConnectCommand([
        '--server-url',
        'http://127.0.0.1:18080',
        '--connect-token',
        'ct_123',
        '--data-root',
        forged,
        '--data-root-origin',
        'default',
        '--foreground',
      ]);
      expect(code).toBe(1);
      expect(stderrWrites.join('')).toContain('does not match');
      // Nothing was created at the forged root or the canonical slot.
      expect(existsSync(forged)).toBe(false);
      expect(existsSync(join(stateRoot, 'computers'))).toBe(false);
      expect(existsSync(join(stateRoot, 'run'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      process.stderr.write = origWrite;
      if (prevEnv === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = prevEnv;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('the default profile maps to app-scoped run/logs and slot-scoped durable state', () => {
    const stateRoot = '/home/u/.silverhand';
    const p = defaultConnectRuntimePaths('host/1', stateRoot);
    expect(p.socketPath).toBe(`${stateRoot}/run/connect-host_1/daemon.sock`);
    expect(p.pidFilePath).toBe(
      `${stateRoot}/run/connect-host_1/silverhand-daemon.pid`,
    );
    expect(p.runStateDir).toBe(`${stateRoot}/run/connect-host_1`);
    expect(p.runtimePidRootDir).toBe(`${stateRoot}/run/connect-host_1/runtime-pids`);
    expect(p.logDir).toBe(`${stateRoot}/logs/connect-host_1`);
    expect(p.launcherLogPath).toBe(
      `${stateRoot}/logs/connect-host_1/connect-launcher.log`,
    );
    expect(p.agentHomeRootDir).toBe(`${stateRoot}/computers/host_1/agents`);
    expect(p.proxyConfigPath).toBe(
      `${stateRoot}/computers/host_1/proxy-config.json`,
    );
  });

  it('an explicit data root stays flat and self-contained (never redirected)', () => {
    const p = explicitConnectRuntimePaths('/data/custom');
    expect(p.socketPath).toBe('/data/custom/daemon.sock');
    expect(p.pidFilePath).toBe('/data/custom/silverhand-daemon.pid');
    expect(p.runStateDir).toBe('/data/custom');
    expect(p.runtimePidRootDir).toBe('/data/custom/runtime-pids');
    expect(p.logDir).toBe('/data/custom/logs');
    expect(p.agentHomeRootDir).toBe('/data/custom/agents');
    expect(p.proxyConfigPath).toBe('/data/custom/proxy-config.json');
  });

  it('stop maps a reserved-namespace root to the default profile BY INVARIANT and anything else flat', () => {
    const stateRoot = '/home/u/.silverhand';
    expect(
      stopRuntimePaths(`${stateRoot}/computers/host_1`, stateRoot).pidFilePath,
    ).toBe(`${stateRoot}/run/connect-host_1/silverhand-daemon.pid`);
    expect(stopRuntimePaths('/data/custom', stateRoot).pidFilePath).toBe(
      '/data/custom/silverhand-daemon.pid',
    );
  });

  it('discovers a single live daemon target and fails loud on multiple', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-connect-test-'));
    const one = join(root, 'one');
    const two = join(root, 'two');
    mkdirSync(one);
    mkdirSync(two);
    writeFileSync(join(one, 'silverhand-daemon.pid'), '101\n', { mode: 0o600 });
    writeFileSync(join(two, 'silverhand-daemon.pid'), '202\n', { mode: 0o600 });
    const signalPid = (pid: number): 'alive' | 'gone' | 'eperm' =>
      pid === 101 || pid === 202 ? 'alive' : 'gone';
    const runPs = async (pid: number): Promise<string> =>
      pid === 101
        ? `node daemon.js connect --foreground --data-root ${one}`
        : `node daemon.js connect --foreground --data-root ${two}`;

    try {
      await expect(
        discoverStopTarget({
          listCandidateDataRoots: () => [one],
          runPs,
          signalPid,
          waitForExit: async () => 'gone',
        }),
      ).resolves.toEqual({ status: 'found', dataRoot: one, pid: 101 });

      await expect(
        discoverStopTarget({
          listCandidateDataRoots: () => [one, two],
          runPs,
          signalPid,
          waitForExit: async () => 'gone',
        }),
      ).resolves.toEqual({ status: 'ambiguous', targets: [one, two] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
