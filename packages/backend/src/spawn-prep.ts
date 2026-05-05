import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpConfigFile, McpServerConfig } from '@silverhand/shared';

/**
 * Per-spawn temp-file scaffolding. We materialize the synthesized system
 * prompt and the MCP config to disk because all coding-agent CLIs accept
 * these as `--system-prompt-file <path>` / `--mcp-config <path>` only —
 * none of them take inline strings (see core-design §4.2).
 *
 * Layout under `<os.tmpdir()>/silverhand/<conversationId>/<agentId>/`:
 *   - system-prompt.md   driver.buildSystemPrompt() output
 *   - mcp.json           single `chat` server pointing at chat-bridge
 *
 * Lifecycle: ConversationManager calls `prepareSpawnFiles` before spawning
 * the agent CLI, then `cleanup()` after the child exits. Crashed leaves
 * stragglers — fine, OS tmp gets reaped eventually.
 */

export interface ChatBridgeServerConfig extends McpServerConfig {}

export interface SpawnPrepInput {
  conversationId: string;
  agentId: string;
  systemPromptText: string;
  /** Single MCP server entry that runs chat-bridge for this (conversation,
   *  agent). Caller assembles command/args/env. */
  chatBridge: ChatBridgeServerConfig;
}

export interface SpawnPrepHandle {
  systemPromptPath: string;
  mcpConfigPath: string;
  cleanup(): Promise<void>;
}

export async function prepareSpawnFiles(
  input: SpawnPrepInput,
): Promise<SpawnPrepHandle> {
  const dir = join(tmpdir(), 'silverhand', input.conversationId, input.agentId);
  await mkdir(dir, { recursive: true });

  const systemPromptPath = join(dir, 'system-prompt.md');
  const mcpConfigPath = join(dir, 'mcp.json');

  const mcpConfig: McpConfigFile = {
    mcpServers: { chat: input.chatBridge },
  };

  await Promise.all([
    writeFile(systemPromptPath, input.systemPromptText, 'utf-8'),
    writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8'),
  ]);

  return {
    systemPromptPath,
    mcpConfigPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
