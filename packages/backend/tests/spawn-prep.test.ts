import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { prepareSpawnFiles } from '../src/spawn-prep.js';

describe('prepareSpawnFiles', () => {
  it('writes launch artifacts under OS tmp and cleans them up', async () => {
    const handle = await prepareSpawnFiles({
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      systemPromptText: 'STANDING PROMPT\n',
      chatBridge: {
        command: 'node',
        args: ['chat-bridge.js'],
        env: { TOKEN: 'secret' },
      },
    });

    expect(handle.systemPromptPath).toBe(
      join(tmpdir(), 'silverhand', 'conversation-1', 'agent-1', 'system-prompt.md'),
    );
    expect(handle.mcpConfigPath).toBe(
      join(tmpdir(), 'silverhand', 'conversation-1', 'agent-1', 'mcp.json'),
    );
    expect(await fs.readFile(handle.systemPromptPath, 'utf8')).toBe(
      'STANDING PROMPT\n',
    );

    const mcpConfig = JSON.parse(await fs.readFile(handle.mcpConfigPath, 'utf8'));
    expect(mcpConfig).toEqual({
      mcpServers: {
        chat: {
          command: 'node',
          args: ['chat-bridge.js'],
          env: { TOKEN: 'secret' },
        },
      },
    });

    await handle.cleanup();
    await expect(fs.readFile(handle.mcpConfigPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
