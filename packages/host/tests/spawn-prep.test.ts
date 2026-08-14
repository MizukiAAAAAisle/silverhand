import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_DAEMON_SOCKET_ENV,
  SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';
import { prepareSpawnFiles, type SpawnPrepHandle } from '../src/daemon/spawn-prep.js';

const handles: SpawnPrepHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.cleanup()));
});

describe('prepareSpawnFiles', () => {
  it('writes a self-contained silverhand shim with per-spawn CLI env', async () => {
    const handle = await prepareSpawnFiles({
      runtimeScope: {
        kind: 'conversation',
        conversation_id: 'conv-shim',
        agent_id: 'agent-shim',
      },
      agentId: 'agent-shim',
      systemPromptText: 'system prompt',
      silverhandCli: {
        command: process.execPath,
        args: [
          '-e',
          [
            'const keys = process.argv.slice(1);',
            'console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))));',
          ].join(' '),
        ],
        env: {
          PATH: '/launcher/path',
          SILVERHAND_CONVERSATION_ID: 'wrong-from-launcher',
        },
      },
      silverhandEnv: {
        [SILVERHAND_CONVERSATION_ID_ENV]: 'conv-shim',
        [SILVERHAND_AGENT_ID_ENV]: 'agent-shim',
        [SILVERHAND_SERVER_URL_ENV]: 'https://silverhand.example.test',
        [SILVERHAND_AUTH_TOKEN_ENV]: 'tok-shim',
      },
      daemonSocketPath: '/tmp/silverhand.sock',
    });
    handles.push(handle);

    const shimPath = join(handle.binDir, 'silverhand');
    const out = execFileSync(
      shimPath,
      [
        SILVERHAND_CONVERSATION_ID_ENV,
        SILVERHAND_AGENT_ID_ENV,
        SILVERHAND_SERVER_URL_ENV,
        SILVERHAND_AUTH_TOKEN_ENV,
        SILVERHAND_DAEMON_SOCKET_ENV,
        SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV,
        'PATH',
      ],
      {
        encoding: 'utf-8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );

    expect(JSON.parse(out)).toMatchObject({
      [SILVERHAND_CONVERSATION_ID_ENV]: 'conv-shim',
      [SILVERHAND_AGENT_ID_ENV]: 'agent-shim',
      [SILVERHAND_SERVER_URL_ENV]: 'https://silverhand.example.test',
      [SILVERHAND_AUTH_TOKEN_ENV]: 'tok-shim',
      [SILVERHAND_DAEMON_SOCKET_ENV]: '/tmp/silverhand.sock',
      [SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV]: handle.lastDeliveredSeqPath,
      PATH: '/launcher/path',
    });
    expect(handle.silverhandShimEnvPresence).toEqual({
      all_present: true,
      present_keys: [
        SILVERHAND_CONVERSATION_ID_ENV,
        SILVERHAND_AGENT_ID_ENV,
        SILVERHAND_SERVER_URL_ENV,
        SILVERHAND_AUTH_TOKEN_ENV,
      ],
      missing_keys: [],
    });
  });

  it('removes a launcher-provided ambient conversation from an AgentSlot shim', async () => {
    const handle = await prepareSpawnFiles({
      runtimeScope: { kind: 'agent', agent_id: 'agent-shim' },
      agentId: 'agent-shim',
      systemPromptText: 'agent scoped system prompt',
      silverhandCli: {
        command: process.execPath,
        args: [
          '-e',
          `console.log(JSON.stringify({ conversation: process.env.${SILVERHAND_CONVERSATION_ID_ENV} ?? null, agent: process.env.${SILVERHAND_AGENT_ID_ENV} ?? null }))`,
        ],
        env: {
          [SILVERHAND_CONVERSATION_ID_ENV]: 'legacy-launcher-target',
        },
      },
      silverhandEnv: {
        [SILVERHAND_AGENT_ID_ENV]: 'agent-shim',
        [SILVERHAND_SERVER_URL_ENV]: 'https://silverhand.example.test',
        [SILVERHAND_AUTH_TOKEN_ENV]: 'tok-shim',
      },
    });
    handles.push(handle);

    const out = execFileSync(join(handle.binDir, 'silverhand'), [], {
      encoding: 'utf-8',
      env: {
        PATH: '/usr/bin:/bin',
        [SILVERHAND_CONVERSATION_ID_ENV]: 'inherited-parent-target',
      },
    });
    expect(JSON.parse(out)).toEqual({
      conversation: null,
      agent: 'agent-shim',
    });
    expect(handle.silverhandShimEnvPresence).toEqual({
      all_present: true,
      present_keys: [
        SILVERHAND_AGENT_ID_ENV,
        SILVERHAND_SERVER_URL_ENV,
        SILVERHAND_AUTH_TOKEN_ENV,
      ],
      missing_keys: [],
    });
  });
});
