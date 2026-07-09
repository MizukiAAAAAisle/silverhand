import { describe, expect, it } from 'vitest';
import {
  assembleConnectCommand,
  buildConnectArgv,
} from '@silverhand/shared';
import { parseConnectArgv } from '../src/daemon/connect-command';

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
      },
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
});
