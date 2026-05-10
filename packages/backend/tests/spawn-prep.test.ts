import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { prepareSpawnFiles } from '../src/spawn-prep.js';

describe('prepareSpawnFiles', () => {
  it('writes launch artifacts under OS tmp and cleans them up', async () => {
    const handle = await prepareSpawnFiles({
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      systemPromptText: 'STANDING PROMPT\n',
      silverhandCli: {
        command: '/usr/bin/node',
        args: ['/path with spaces/silverhand-cli.mjs', '--from-launcher'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    });

    const spawnDir = dirname(handle.systemPromptPath);
    expect(spawnDir).toContain(
      join(tmpdir(), 'silverhand', 'conversation-1', 'agent-1', 'spawn-'),
    );
    expect(handle.systemPromptPath).toBe(join(spawnDir, 'system-prompt.md'));
    expect(handle.binDir).toBe(join(spawnDir, 'bin'));
    expect(await fs.readFile(handle.systemPromptPath, 'utf8')).toBe(
      'STANDING PROMPT\n',
    );
    await expect(fs.readFile(join(spawnDir, 'mcp.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const shim = await fs.readFile(join(handle.binDir, 'silverhand'), 'utf8');
    expect(shim).toContain('export ELECTRON_RUN_AS_NODE=');
    expect(shim).toContain(
      "exec '/usr/bin/node' '/path with spaces/silverhand-cli.mjs' '--from-launcher' \"$@\"",
    );

    await handle.cleanup();
    await expect(fs.readFile(handle.systemPromptPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
