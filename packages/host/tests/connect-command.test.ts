import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleConnectCommand,
  buildConnectArgv,
} from '@silverhand/shared';
import {
  discoverStopTarget,
  formatStopCommand,
  parseConnectArgv,
  parseStopArgv,
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
      { serverUrl: 'https://silverhand.taobao.net', connectToken: 'ct_abc123' },
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
          alsoStderr: true,
          daemonMode: true,
        },
      });
    }
  });

  it('assembleConnectCommand emits an npx connect invocation with the recipe', () => {
    const command = assembleConnectCommand({
      daemonNpmSpec: '@silverhand-ai/daemon@latest',
      serverUrl: 'https://silverhand.taobao.net',
      connectToken: 'ct_abc123',
    });
    expect(command).toBe(
      'npx @silverhand-ai/daemon@latest connect --server-url https://silverhand.taobao.net --connect-token ct_abc123',
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
