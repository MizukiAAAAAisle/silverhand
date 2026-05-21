/**
 * Host-side runtime Driver registry.
 *
 * PR-2 step 2 commit 2 — Cindy `vqDWkLFF6pAeIE5t` plan: runtime
 * drivers move to host (execution plane), prompt assembly stays in
 * backend. The split rule is:
 *
 *  - **Driver = how to spawn the runtime, what to write on stdin, how
 *    to parse stdout, when init is considered ready.** Lives here.
 *  - **Prompt = what text to put in the system prompt before spawn.**
 *    Lives in backend (`drivers/platform-prompt.ts` +
 *    `drivers/index.ts:buildSystemPromptFor`).
 *
 * Drivers no longer implement `buildSystemPrompt`. Backend calls the
 * driver to spawn AFTER it has assembled the prompt text and written
 * it to `spawnCtx.systemPromptPath`. This keeps the host package free
 * of `@silverhand/backend` / `better-sqlite3` dependencies (enforced
 * by `tests/dependency-guard.test.ts`).
 */
import type { ParsedEvent, RuntimeKind } from '@silverhand/shared';

export type { ParsedEvent };

/**
 * Spawn-time context handed to a driver's `buildArgs` / `applyEnv`.
 * Backend builds this after the system prompt was assembled and the
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
   *  (claude, codex) ignore this and let the supervisor post-drain via
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
  /** Bare command name; the host supervisor resolves the actual binary path. */
  readonly binary: string;
  /**
   * How the runtime reaches its first session-ready event:
   *  - `self_inits`: spawn can complete protocol/session init without user stdin.
   *  - `requires_first_message`: init is tied to the first real stdin user turn.
   *    Empty-inbox spawns may be marked active with a real pid while
   *    `initObserved=false`; the host supervisor defers the init watchdog
   *    until it actually writes a user message to stdin.
   *
   * A future runtime can opt into `requires_first_message` without adding a
   * supervisor-level runtime branch only if its driver keeps the boundary
   * intact: `encodeStdinMessage` must send the real kickoff user turn, and
   * `parseLine` must emit a reliable first `session_init` once the runtime
   * has actually accepted that turn. If either side is missing, implement
   * it in the driver first; otherwise the supervisor cannot know when a
   * pre-init inbox row is safe to mark delivered.
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
  /** Encode one notification message for the agent's stdin. Returns
   *  null when the runtime doesn't accept stdin notifications (oneShot
   *  drivers) — the host supervisor treats null as "queue to inbox instead". */
  encodeStdinMessage(content: string, cliSessionId: string | null): string | null;
  /** Encode a clean-cancel control message. Null = no protocol-level
   *  interrupt; the host supervisor falls through to SIGTERM/SIGKILL. */
  encodeInterruptControl(): string | null;
  parseLine(line: string): ParsedEvent[];
  /** Pure line classifier for init watchdog progress. Must not mutate
   *  driver protocol state; `session_ready` implies `protocol_ready`. */
  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null;

  /** Optional: called once after spawn, before the supervisor's first
   *  drainInbox. Lets stateful drivers (codex) start their JSON-RPC
   *  handshake. No-op for stateless drivers. */
  bindIO?(io: DriverIO): void;

  /**
   * Whether the driver can produce a non-null `encodeStdinMessage`
   * result *right now*. Option A v2 (Cindy `UMGu36zoTDVuKWXi`): the
   * daemon's `ready_for_drain` gate keys off this so codex doesn't
   * fire `runtime_ready_for_drain` before `thread/started` returns
   * a usable `threadId`.
   *
   * Default `true` (stateless drivers like claude are always ready
   * to encode). Stateful drivers MUST override:
   *   - codex: `() => this.threadId !== null`
   *   - any future driver with handshake state should mirror that.
   *
   * Why this is a method, not a boolean field: drivers track state
   * across `parseLine` mutations; a getter style lets the daemon
   * re-check on every `maybeEmitReadyForDrain` call without the
   * driver needing to push events at the supervisor.
   */
  readyToEncode?(): boolean;
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
