import { describe, expect, it } from 'vitest';
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
});
