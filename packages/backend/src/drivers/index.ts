import type { ParsedEvent } from '@silverhand/shared';
import type { RuntimeKind } from '@silverhand/shared';
import type {
  SessionContextInput,
  WorkspaceMemoryIndexEntry,
} from './platform-prompt.js';

export type { ParsedEvent };
export type { SessionContextInput, WorkspaceMemoryIndexEntry };

/**
 * Inputs to `buildSystemPrompt`. Subset of spawn context — does not
 * need filesystem paths since the result is then written to a path
 * that's passed to `buildArgs`.
 */
export interface DriverPromptContext {
  agentId: string;
  agentName: string;
  activeProfileDir: string;
  roleSystemPrompt: string;
  currentMemory: string;
  currentConsensus: string;
  workspaceMemoryIndex: WorkspaceMemoryIndexEntry[];
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
  reasoningEffort: string | null;
  /** Codex-only feature toggle. NULL = let codex use its catalog
   *  default; true = `--enable fast_mode`; false = `--disable
   *  fast_mode`. Other drivers ignore. */
  fastMode: boolean | null;
  /** Path to the materialized `system-prompt.md`. Drivers that accept a
   *  CLI flag for it (claude) point at this; drivers that don't (codex,
   *  cursor) read the file's contents into their own protocol payload. */
  systemPromptPath: string;
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
   * How the runtime reaches its first session-ready event:
   *  - `self_inits`: spawn can complete protocol/session init without user stdin.
   *  - `requires_first_message`: init is tied to the first real stdin user turn.
   *    Empty-inbox spawns may be marked active with a real pid while
   *    `initObserved=false`; ConversationManager defers the init watchdog until
   *    it actually writes a user message to stdin.
   *
   * A future runtime can opt into `requires_first_message` without adding a
   * manager-level runtime branch only if its driver keeps the boundary intact:
   * `encodeStdinMessage` must send the real kickoff user turn, and `parseLine`
   * must emit a reliable first `session_init` once the runtime has actually
   * accepted that turn. If either side is missing, implement it in the driver
   * first; otherwise the manager cannot know when a pre-init inbox row is safe
   * to mark delivered.
   */
  readonly kickoffMode: 'self_inits' | 'requires_first_message';
  /**
   * How busy-time deliveries to this driver are routed:
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
  /** Pre-protocol silence window. Raw stdout/stderr bytes reset this. */
  readonly initLivenessSilenceMs: number;
  /** Absolute cap before the first complete protocol frame is observed. */
  readonly initPreProtocolCapMs: number;
  /** Window from first protocol frame to session-ready init. */
  readonly initPostProtocolMs: number;

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
  /** Pure line classifier for init watchdog progress. Must not mutate
   *  driver protocol state; `session_ready` implies `protocol_ready`. */
  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null;

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
