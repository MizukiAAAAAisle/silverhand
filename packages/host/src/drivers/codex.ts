import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Driver,
  type DriverIO,
  type DriverSpawnContext,
  type ParsedEvent,
  type ToolOutcome,
} from './index.js';

/**
 * Codex CLI driver.
 *
 * Reference: behaviour mirrored from `@slock-ai/daemon` (codex.ts).
 *
 * Codex differs from claude in three load-bearing ways:
 *
 * 1. **Transport.** Instead of `--input-format stream-json` it speaks
 *    JSON-RPC 2.0 over stdio via `codex app-server --listen stdio://`.
 *    The driver must perform an `initialize` → `initialized` →
 *    `thread/start` (or `thread/resume`) handshake before the agent is
 *    usable. We do this in `bindIO`, called by ConversationManager once
 *    after spawn.
 *
 * 2. **Silverhand tools.** Codex uses the injected `silverhand` CLI on
 *    PATH for chat/task/schedule/file actions. Older MCP config args are
 *    intentionally not passed here; phase 2 starts the MCP removal with
 *    Codex because it owned the least amount of driver-specific wiring.
 *
 * 3. **Standing prompt.** Goes into `developerInstructions` on the
 *    `thread/start` JSON-RPC params, not a CLI flag. Read from the
 *    pre-written systemPromptPath at spawn time.
 *
 * Codex also requires a git repo in cwd or it bails — see
 * `ensureGitRepoForCodex`. Slock does the same thing.
 *
 * Driver state (threadId, requestId counter, activeTurnId, …) is
 * per-instance, so the registry must hand out a fresh instance per
 * spawn (factory pattern in drivers/index.ts).
 */
export class CodexDriver implements Driver {
  readonly kind = 'codex' as const;
  readonly binary = 'codex';
  readonly kickoffMode = 'self_inits' as const;
  readonly releaseProfile = 'native-steer' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 60 * 1000;
  readonly initPreProtocolCapMs = 5 * 60 * 1000;
  // 60s post-protocol budget. Codex's `app-server` happy-path completes
  // initialize → thread/started in ~4s with proxy / ~11s without. The wider
  // window absorbs proxy half-up flakes (e.g. `socks5://127.0.0.1:7897`
  // momentarily refusing connections) where codex still emits its first
  // protocol frame promptly but stalls on `thread/start` while the MCP
  // chat client retries connecting back to silverhand.
  readonly initPostProtocolMs = 60 * 1000;

  private io: DriverIO | null = null;
  private requestId = 0;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private initializeRequestId: number | null = null;
  private pendingThreadRequest: { method: string; params: unknown } | null = null;
  private pendingInitialPrompt: string | null = null;
  private initialTurnStarted = false;
  private sessionAnnounced = false;
  private streamedAgentMessageIds = new Set<string>();
  private streamedReasoningIds = new Set<string>();
  /** Per-item count of tool_calls emitted on item/started for fileChange.
   *  Keyed by item.id so item/completed knows how many tool_outputs to
   *  emit back. Without this, `outstandingToolUses` stays > 0 mid-turn
   *  and `recordToolOutput` never flips status back to thinking. */
  private pendingFileChangeCounts = new Map<string, number>();
  /** Set of webSearch item ids that opened a tool_call on item/started.
   *  item/completed pops the id and emits the matching tool_output. */
  private pendingWebSearchIds = new Set<string>();

  buildArgs(ctx: DriverSpawnContext): string[] {
    const args = ['app-server', '--listen', 'stdio://'];
    if (ctx.reasoningEffort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(ctx.reasoningEffort)}`);
    }
    // fast_mode is a codex feature flag (`codex features list` →
    // `fast_mode  stable`). NULL leaves the catalog default in place;
    // explicit true/false maps to the `--enable` / `--disable` pair.
    if (ctx.fastMode === true) {
      args.push('--enable', 'fast_mode');
    } else if (ctx.fastMode === false) {
      args.push('--disable', 'fast_mode');
    }
    return args;
  }

  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, NO_COLOR: '1' };
  }

  bindIO(io: DriverIO): void {
    ensureGitRepoForCodex(io.spawnCtx.workspacePath);

    this.io = io;
    // A persisted cliSessionId is only the resume target. The new
    // app-server cannot accept turn/start for it until thread/resume has
    // completed and handleThreadReady() has observed the loaded thread.
    this.threadId = null;
    this.pendingInitialPrompt = io.spawnCtx.initialPrompt || null;

    const standingPrompt = readFileSync(io.spawnCtx.systemPromptPath, 'utf-8');
    this.pendingThreadRequest = this.buildThreadRequest(io.spawnCtx, standingPrompt);

    // Defer until next microtask so ConversationManager has finished wiring
    // the readline / event handlers — matches slock's `queueMicrotask`.
    queueMicrotask(() => {
      this.initializeRequestId = this.sendRequest('initialize', {
        clientInfo: { name: 'silverhand', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
    });
  }

  encodeStdinMessage(
    text: string,
    _cliSessionId: string | null,
    opts?: { payloadUuid?: string },
  ): string | null {
    if (!this.threadId) return null;
    const id = this.nextRequestId();
    // #task:1561 round 2: the payload uuid rides codex's native
    // `clientUserMessageId` (schema-confirmed on both turn/steer and
    // turn/start, 0.144.4). Codex echoes it as `clientId` on the
    // `item/started {type:'userMessage'}` it emits when the input is
    // drained into model history — right before the NEXT sampling
    // request is constructed. THAT echo is the generation-boundary
    // evidence (see handleItemEvent); the JSON-RPC response to this
    // request is a transport ack and must never become evidence.
    const clientUserMessageId = opts?.payloadUuid
      ? { clientUserMessageId: opts.payloadUuid }
      : {};
    if (this.activeTurnId) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'turn/steer',
        params: {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input: [{ type: 'text', text }],
          ...clientUserMessageId,
        },
      });
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'turn/start',
      params: {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        ...clientUserMessageId,
      },
    });
  }

  /**
   * Codex can only encode stdin messages after `thread/started`
   * lands and `handleThreadReady` sets `this.threadId`. Before that,
   * `encodeStdinMessage` returns null and the daemon's
   * `ready_for_drain` gate (Option A v2 — Cindy `UMGu36zoTDVuKWXi`)
   * keeps `runtime_ready_for_drain` bottled up so backend doesn't
   * `runtime_deliver` into a null-encode dead-end.
   */
  readyToEncode(): boolean {
    return this.threadId !== null;
  }

  encodeInterruptControl(): string | null {
    // Codex app-server doesn't expose a clean turn-cancel RPC at the
    // moment slock targeted (and slock itself relies on signals).
    // Returning null tells ConversationManager to fall through to SIGTERM.
    return null;
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return [{ kind: 'unknown', raw: trimmed }];
    }

    const events: ParsedEvent[] = [];

    // RPC responses ────────────────────────────────────────────────
    if (message.result !== undefined) {
      if (message.id === this.initializeRequestId) {
        this.initializeRequestId = null;
        this.sendNotification('initialized', {});
        if (this.pendingThreadRequest) {
          this.sendRequest(
            this.pendingThreadRequest.method,
            this.pendingThreadRequest.params,
          );
          this.pendingThreadRequest = null;
        }
        return events;
      }
      const thread = message.result?.thread;
      if (thread && typeof thread.id === 'string') {
        this.handleThreadReady(thread.id, events);
        return events;
      }
      const turn = message.result?.turn;
      if (turn && typeof turn.id === 'string') {
        this.activeTurnId = turn.id;
        return events;
      }
      if (typeof message.result?.turnId === 'string') {
        this.activeTurnId = message.result.turnId;
        return events;
      }
      return events;
    }

    if (message.error) {
      if (message.id === this.initializeRequestId) {
        this.initializeRequestId = null;
        this.pendingThreadRequest = null;
      }
      const detail =
        typeof message.error?.message === 'string'
          ? message.error.message
          : 'Codex app-server request failed';
      events.push({
        kind: 'error',
        message: detail,
        ...classifyCodexError(detail),
      });
      return events;
    }

    // Notifications / events ──────────────────────────────────────
    switch (message.method) {
      case 'thread/started': {
        const threadId = message.params?.thread?.id;
        if (typeof threadId === 'string') this.handleThreadReady(threadId, events);
        break;
      }
      case 'turn/started': {
        const turnId = message.params?.turn?.id;
        if (typeof turnId === 'string') this.activeTurnId = turnId;
        // Surface a zero-width thinking event so the UI can show the
        // agent is now actively working — slock does the same thing.
        events.push({ kind: 'thinking', text: '' });
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = message.params?.delta;
        const itemId = message.params?.itemId;
        if (typeof itemId === 'string') this.streamedAgentMessageIds.add(itemId);
        if (typeof delta === 'string' && delta.length > 0) {
          events.push({ kind: 'text', text: delta });
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = message.params?.delta;
        const itemId = message.params?.itemId;
        if (typeof itemId === 'string') this.streamedReasoningIds.add(itemId);
        if (typeof delta === 'string' && delta.length > 0) {
          events.push({ kind: 'thinking', text: delta });
        }
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const item = message.params?.item;
        if (!item || typeof item !== 'object' || typeof item.type !== 'string') break;
        this.handleItemEvent(message.method, item, events);
        break;
      }
      case 'turn/completed': {
        const turn = message.params?.turn;
        if (turn?.status === 'failed' && typeof turn?.error?.message === 'string') {
          events.push({ kind: 'error', message: turn.error.message });
        }
        this.activeTurnId = null;
        this.streamedAgentMessageIds.clear();
        this.streamedReasoningIds.clear();
        this.pendingFileChangeCounts.clear();
        this.pendingWebSearchIds.clear();
        events.push({
          kind: 'turn_end',
          sessionId: this.threadId ?? undefined,
        });
        break;
      }
      case 'error': {
        const params = message.params;
        const detail =
          typeof params?.message === 'string'
            ? params.message
            : typeof params?.error?.message === 'string'
              ? params.error.message
              : 'Unknown Codex app-server error';
        events.push({ kind: 'error', message: detail, ...classifyCodexError(detail) });
        break;
      }
    }

    return events;
  }

  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (!message || typeof message !== 'object') return null;
    if (message.jsonrpc !== '2.0' && !('method' in message) && !('result' in message) && !('error' in message)) {
      return null;
    }

    const thread = message.result?.thread;
    if (thread && typeof thread.id === 'string') return 'session_ready';
    if (message.method === 'thread/started' && typeof message.params?.thread?.id === 'string') {
      return 'session_ready';
    }
    return 'protocol_ready';
  }

  // ── internals ──────────────────────────────────────────────────────

  private handleItemEvent(
    method: string,
    item: any,
    events: ParsedEvent[],
  ): void {
    const isStarted = method === 'item/started';
    const isCompleted = method === 'item/completed';
    switch (item.type) {
      case 'userMessage':
        // Generation-boundary evidence (#task:1561 round 2): codex emits
        // this item when it drains `pending_input` into model history —
        // AFTER any in-flight sampling, BEFORE constructing the next
        // sampling request. The echoed `clientId` is our payload uuid
        // (stamped via `clientUserMessageId` at encode). This is the
        // real per-input lifecycle: the payload provably becomes
        // precedent context for the NEXT generation. Upstream emits
        // started and completed as separate real frames — map each 1:1,
        // never fabricate the pair from one frame (Cindy P2: a faked
        // completed makes the real one arrive uncorrelated). The earlier
        // RPC-response mirror was a transport ack and let
        // already-generated sends pass CAS (countgame round 2).
        if (typeof item.clientId === 'string') {
          if (isStarted) {
            events.push({
              kind: 'input_lifecycle',
              commandUuid: item.clientId,
              state: 'started',
            });
          }
          if (isCompleted) {
            events.push({
              kind: 'input_lifecycle',
              commandUuid: item.clientId,
              state: 'completed',
            });
          }
        }
        break;
      case 'reasoning':
        if (
          isCompleted &&
          typeof item.id === 'string' &&
          !this.streamedReasoningIds.has(item.id)
        ) {
          const text = joinReasoningText(item);
          if (text) events.push({ kind: 'thinking', text });
        }
        if (isCompleted && typeof item.id === 'string') {
          this.streamedReasoningIds.delete(item.id);
        }
        break;
      case 'agentMessage':
        if (
          isCompleted &&
          typeof item.id === 'string' &&
          !this.streamedAgentMessageIds.has(item.id) &&
          typeof item.text === 'string' &&
          item.text.length > 0
        ) {
          events.push({ kind: 'text', text: item.text });
        }
        if (isCompleted && typeof item.id === 'string') {
          this.streamedAgentMessageIds.delete(item.id);
        }
        break;
      case 'commandExecution': {
        const callId = typeof item.id === 'string' ? item.id : undefined;
        if (isStarted && typeof item.command === 'string') {
          events.push({
            kind: 'tool_call',
            name: 'shell',
            input: { command: item.command },
            ...(callId ? { toolCallId: callId } : {}),
          });
        }
        if (isCompleted) {
          events.push({
            kind: 'tool_output',
            name: 'shell',
            ...(callId ? { toolCallId: callId } : {}),
            outcome: codexToolOutcome(item, true),
          });
        }
        break;
      }
      case 'contextCompaction':
        if (isStarted) events.push({ kind: 'compaction_started' });
        if (isCompleted) events.push({ kind: 'compaction_finished' });
        break;
      case 'fileChange': {
        // One fileChange item fans out to N per-file rows that share its id;
        // the renderer folds by id-set, so all N calls flip to done and all N
        // outputs drop. Status is per-item (whole batch), so every output
        // carries the same outcome.
        const callId = typeof item.id === 'string' ? item.id : undefined;
        if (isStarted && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            events.push({
              kind: 'tool_call',
              name: 'file_change',
              input: { path: change?.path, kind: change?.kind },
              ...(callId ? { toolCallId: callId } : {}),
            });
          }
          if (callId) {
            this.pendingFileChangeCounts.set(callId, item.changes.length);
          }
        }
        if (isCompleted && callId) {
          // Only emit tool_outputs we explicitly remembered from item/started.
          // Late item/completed events that arrive after turn/completed
          // (which clears the map) emit nothing — by then the manager has
          // already reset outstandingToolUses on turn_end, and a phantom
          // tool_output here would resurrect a resolved run.
          const count = this.pendingFileChangeCounts.get(callId) ?? 0;
          const outcome = codexToolOutcome(item, false);
          for (let i = 0; i < count; i += 1) {
            events.push({ kind: 'tool_output', name: 'file_change', toolCallId: callId, outcome });
          }
          this.pendingFileChangeCounts.delete(callId);
        }
        break;
      }
      case 'mcpToolCall': {
        const toolName =
          item.server === 'chat'
            ? `mcp_chat_${item.tool}`
            : `mcp_${item.server}_${item.tool}`;
        const callId = typeof item.id === 'string' ? item.id : undefined;
        if (isStarted) {
          events.push({
            kind: 'tool_call',
            name: toolName,
            input: item.arguments,
            ...(callId ? { toolCallId: callId } : {}),
          });
        }
        if (isCompleted) {
          events.push({
            kind: 'tool_output',
            name: toolName,
            ...(callId ? { toolCallId: callId } : {}),
            outcome: codexToolOutcome(item, false),
          });
        }
        break;
      }
      case 'webSearch':
        if (isStarted) {
          events.push({
            kind: 'tool_call',
            name: 'web_search',
            input: { query: item.query },
            ...(typeof item.id === 'string' ? { toolCallId: item.id } : {}),
          });
          if (typeof item.id === 'string') this.pendingWebSearchIds.add(item.id);
        }
        if (isCompleted) {
          // Drop the event silently if we never saw the matching started
          // (e.g. cleared by turn/completed) — see fileChange comment above.
          // webSearch has no failure bit in the protocol — completed is the
          // only terminal state, so its outcome stays the neutral `completed`.
          const id = typeof item.id === 'string' ? item.id : null;
          if (id && this.pendingWebSearchIds.delete(id)) {
            events.push({ kind: 'tool_output', name: 'web_search', toolCallId: id, outcome: 'completed' });
          }
        }
        break;
    }
  }

  private handleThreadReady(threadId: string, events: ParsedEvent[]): void {
    this.threadId = threadId;
    if (!this.sessionAnnounced) {
      events.push({ kind: 'session_init', sessionId: threadId });
      this.sessionAnnounced = true;
    }
    this.startInitialTurn();
  }

  private startInitialTurn(): void {
    if (this.initialTurnStarted || !this.pendingInitialPrompt || !this.threadId) {
      return;
    }
    this.initialTurnStarted = true;
    const prompt = this.pendingInitialPrompt;
    this.pendingInitialPrompt = null;
    this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
    });
  }

  private buildThreadRequest(
    ctx: DriverSpawnContext,
    standingPrompt: string,
  ): { method: string; params: any } {
    const params: any = {
      cwd: ctx.workspacePath,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: standingPrompt,
    };
    // Omission is intentional: NULL means use Codex's own current default.
    // A hidden Silverhand fallback would pin new agents to an older model and
    // make model-specific capabilities such as Ultra fail unexpectedly.
    if (ctx.model) params.model = ctx.model;
    if (ctx.cliSessionId) {
      return {
        method: 'thread/resume',
        params: { threadId: ctx.cliSessionId, ...params },
      };
    }
    return { method: 'thread/start', params };
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private sendRequest(method: string, params: unknown): number {
    const id = this.nextRequestId();
    void this.io?.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  private sendNotification(method: string, params: unknown): void {
    void this.io?.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
}

function classifyCodexError(message: string): { code?: string; fatal?: boolean } {
  if (/thread not found/i.test(message)) {
    return { code: 'thread_not_found', fatal: true };
  }
  if (/\bsession\s+[0-9a-f-]+\s+is\s+archived\b/i.test(message)) {
    return { code: 'session_archived', fatal: true };
  }
  return {};
}

/**
 * Terminal outcome of a codex `item/completed`, from the app-server's own
 * `status` (+ `exitCode` for shell). Guarded reads: an old frame or a fixture
 * that omits these fields yields `completed` (neutral) — never a guessed
 * `success`. `hasExitCode` marks `commandExecution`, where success must be
 * PROVEN by exit 0; a null/absent exit code is unproven → neutral `completed`.
 * Non-shell items (mcp / file_change) have no exit code, so their own
 * `completed` status is the success proof.
 */
function codexToolOutcome(item: any, hasExitCode: boolean): ToolOutcome {
  const status = typeof item?.status === 'string' ? item.status : null;
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'cancelled';
  if (status === 'completed') {
    if (!hasExitCode) return 'success';
    const code = (item as { exitCode?: unknown }).exitCode;
    if (code === 0) return 'success';
    if (typeof code === 'number') return 'failed';
    return 'completed';
  }
  return 'completed';
}

function joinReasoningText(item: any): string {
  const summary = Array.isArray(item.summary)
    ? item.summary.filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
  const content = Array.isArray(item.content)
    ? item.content.filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
  return [...summary, ...content].join('\n').trim();
}

/**
 * Codex refuses to start in a directory that isn't a git repo. Channel
 * workspaces are seeded as plain directories, so we initialize one on
 * demand. Mirrors slock.
 */
function ensureGitRepoForCodex(workspacePath: string): void {
  if (existsSync(join(workspacePath, '.git'))) return;
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync(
    "git -c user.name=silverhand -c user.email=silverhand@local " +
      "-c commit.gpgsign=false add -A && " +
      "git -c user.name=silverhand -c user.email=silverhand@local " +
      "-c commit.gpgsign=false commit --allow-empty -m 'init'",
    { cwd: workspacePath, stdio: 'pipe' },
  );
}
