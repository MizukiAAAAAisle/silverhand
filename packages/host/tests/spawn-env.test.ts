import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import type { Driver } from '../src/drivers/index.js';
import { buildDaemonSpawnEnv } from '../src/daemon/spawn-env.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';

function makeDriver(applyEnv: Driver['applyEnv']): Driver {
  return {
    kind: 'claude',
    binary: 'claude',
    applyEnv,
    buildArgs: () => [],
    parseLine: () => [],
    encodeStdinMessage: () => '',
    encodeInterruptControl: () => '',
    oneShot: false,
    kickoffMode: 'self_init',
    busyDeliveryMode: 'defer',
  } as unknown as Driver;
}

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/test',
  LANG: 'en_US.UTF-8',
};

describe('daemon spawn env', () => {
  it('materializes final child env locally from typed env_policy and daemon proxy config', () => {
    const driver = makeDriver(env => ({ ...env, NO_COLOR: '1' }));
    const options = testStartOptions({ runtime: 'codex' });
    options.env_policy = {
      ...options.env_policy,
      silverhand: {
        server_url: 'http://127.0.0.1:8765',
        auth_token: 'tok_test_123',
      },
    };

    const env = buildDaemonSpawnEnv({
      driver,
      options,
      conversationId: 'conv-abc',
      agentId: 'agent-xyz',
      binDir: '/tmp/silverhand-spawn/bin',
      proxyConfig: {
        proxy_url: 'http://127.0.0.1:7897',
        proxy_runtimes: ['codex'],
      },
      baseProcessEnv: BASE_ENV,
    });

    expect(env.NO_COLOR).toBe('1');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(env[SILVERHAND_CONVERSATION_ID_ENV]).toBe('conv-abc');
    expect(env[SILVERHAND_AGENT_ID_ENV]).toBe('agent-xyz');
    expect(env[SILVERHAND_SERVER_URL_ENV]).toBe('http://127.0.0.1:8765');
    expect(env[SILVERHAND_AUTH_TOKEN_ENV]).toBe('tok_test_123');
    expect(env.PATH).toBe(
      `/tmp/silverhand-spawn/bin${delimiter}/usr/local/bin:/usr/bin:/bin`,
    );
  });

  it('does not apply proxy env when the runtime is not allowlisted', () => {
    const driver = makeDriver(env => ({ ...env }));
    const options = testStartOptions({ runtime: 'claude' });

    const env = buildDaemonSpawnEnv({
      driver,
      options,
      conversationId: options.session.conversation_id,
      agentId: options.agent.id,
      binDir: '/tmp/silverhand-spawn/bin',
      proxyConfig: {
        proxy_url: 'http://127.0.0.1:7897',
        proxy_runtimes: ['codex'],
      },
      baseProcessEnv: BASE_ENV,
    });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});
