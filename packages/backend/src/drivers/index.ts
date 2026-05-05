import type {
  McpConfigFile,
  McpServerConfig,
  ParsedEvent,
} from '@silverhand/shared';
import type { RuntimeKind } from '@silverhand/shared';
import type { SessionContextInput } from './platform-prompt.js';

export type { ParsedEvent, McpConfigFile, McpServerConfig };
export type { SessionContextInput };

/**
 * Inputs to `buildSystemPrompt`. Subset of spawn context — does not
 * need filesystem paths since the result is then written to a path
 * that's passed to `buildArgs`.
 */
export interface DriverPromptContext {
  agentId: string;
  agentName: string;
  l2SystemPrompt: string;
  sessionContext: SessionContextInput;
}

/**
 * Spawn-time context handed to a driver's `buildArgs` / `applyEnv`.
 * ConversationManager builds this after `buildSystemPrompt` ran and the
 * temp files were written.
 */
export interface DriverSpawnContext {
  agentId: string;
  agentName: string;
  workspacePath: string;
  cliSessionId: string | null; // when resuming
  model: string | null;
  /** Path to the materialized `system-prompt.md`. Drivers that accept a
   *  CLI flag for it (claude) point at this; drivers that don't (codex,
   *  cursor) read the file's contents into their own protocol payload. */
  systemPromptPath: string;
  /** Path to a temp `mcp.json` already populated with the chat-bridge
   *  server. Useful only for drivers that take `--mcp-config <path>`
   *  (claude). Codex/cursor wire MCP differently and ignore this. */
  mcpConfigPath: string;
  /** Underlying chat-bridge launcher. Drivers that wire MCP outside of
   *  the temp `mcp.json` (codex via `-c mcp_servers.chat.command=...`,
   *  cursor by writing `<workspace>/.cursor/mcp.json`) consume this. */
  chatBridge: McpServerConfig;
  /** Inbox content drained synchronously *before* spawn. Used by
   *  `oneShot` drivers (cursor) which can't accept stdin notifications
   *  and must receive their kickoff message via argv. Streaming drivers
   *  (claude, codex) ignore this and let ConversationManager post-drain via
   *  stdin after `session_init`. */
  initialPrompt: string;
}

/** Stdin writer + spawn context handed to drivers via `bindIO`. Codex
 *  uses it to drive its JSON-RPC handshake right after spawn. */
export interface DriverIO {
  /** Append `\n` and write one line to the agent's stdin. */
  writeLine(line: string): Promise<void>;
  spawnCtx: DriverSpawnContext;
}

export interface Driver {
  readonly kind: RuntimeKind;
  /** Bare command name; ConversationManager resolves the actual binary path. */
  readonly binary: string;
  /**
   * How busy-time deliveries from chat-bridge to this driver are routed:
   *  - `gated`:  push only at safe boundaries (Claude — no outstanding
   *              tool_uses + non-compacting state)
   *  - `direct`: push immediately, runtime is forgiving (Codex steers
   *              mid-turn via `turn/steer`)
   *  - `none`:   driver doesn't accept stdin notifications at all; new
   *              messages queue to inbox and the runtime is respawned
   *              with them as kickoff (Cursor, Copilot, Gemini)
   */
  readonly busyDeliveryMode: 'gated' | 'direct' | 'none';
  /** True if the runtime exits after a single turn and must be
   *  respawned for each new kickoff (cursor-agent --print). False for
   *  long-lived stream-json runtimes (claude, codex). */
  readonly oneShot: boolean;
  /** True if the runtime supports a long-lived "standing" system prompt
   *  across turns (Claude does; some don't). Informational. */
  readonly supportsNativeStandingPrompt: boolean;
  /** What prefix the runtime exposes our chat-bridge MCP tools under,
   *  e.g. `mcp__chat__` for Claude Code. Used by `buildSystemPrompt` to
   *  reference tool names in the prompt. */
  readonly mcpToolPrefix: string;

  buildArgs(ctx: DriverSpawnContext): string[];
  /** Returns a derived env: copy of base with driver-specific tweaks
   *  (set / delete). Implementations must not mutate the input. */
  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildSystemPrompt(ctx: DriverPromptContext): string;
  /** Encode one notification message for the agent's stdin. Returns
   *  null when the runtime doesn't accept stdin notifications (oneShot
   *  drivers) — ConversationManager treats null as "queue to inbox instead". */
  encodeStdinMessage(content: string, cliSessionId: string | null): string | null;
  /** Encode a clean-cancel control message. Null = no protocol-level
   *  interrupt; ConversationManager falls through to SIGTERM/SIGKILL. */
  encodeInterruptControl(): string | null;
  parseLine(line: string): ParsedEvent[];

  /** Optional: called once after spawn, before ConversationManager's first
   *  drainInbox. Lets stateful drivers (codex) start their JSON-RPC
   *  handshake. No-op for stateless drivers. */
  bindIO?(io: DriverIO): void;
}

import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { CursorDriver } from './cursor.js';

/** Per-spawn factory: codex/cursor hold per-handle state (threadId,
 *  protocol counters, …) so we can't share a singleton across handles. */
const FACTORIES: Partial<Record<RuntimeKind, () => Driver>> = {
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  cursor: () => new CursorDriver(),
};

/** Returns a fresh driver instance for `kind`, or throws. */
export function getDriver(kind: RuntimeKind): Driver {
  const f = FACTORIES[kind];
  if (!f) throw new Error(`no driver registered for runtime "${kind}"`);
  return f();
}

export function hasDriver(kind: RuntimeKind): boolean {
  return FACTORIES[kind] !== undefined;
}

export { buildPlatformPrompt } from './platform-prompt.js';
