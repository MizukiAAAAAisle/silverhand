import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Driver,
  type DriverIO,
  type DriverPromptContext,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';
import { buildPlatformPrompt } from './platform-prompt.js';

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
 *    usable. We do this in `bindIO`, called by SessionManager once
 *    after spawn.
 *
 * 2. **MCP wiring.** Codex doesn't take `--mcp-config <path>`; servers
 *    must be passed inline via `-c mcp_servers.<name>.command=<json>`
 *    config args. So `mcpConfigPath` from spawn-prep is unused; we
 *    consume the raw `chatBridge` config from spawn context instead.
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
  readonly busyDeliveryMode = 'direct' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  /** Codex flattens MCP server name + tool with underscore: `mcp__` is
   *  not its convention. Slock uses `mcp_chat_` here. */
  readonly mcpToolPrefix = 'mcp_chat_';

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

  buildArgs(ctx: DriverSpawnContext): string[] {
    const args = ['app-server', '--listen', 'stdio://'];
    args.push(...this.buildMcpConfigArgs(ctx));
    return args;
  }

  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, NO_COLOR: '1' };
  }

  buildSystemPrompt(ctx: DriverPromptContext): string {
    return buildPlatformPrompt({
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      runtime: 'codex',
      mcpToolPrefix: this.mcpToolPrefix,
      l2SystemPrompt: ctx.l2SystemPrompt,
      sessionContext: ctx.sessionContext,
    });
  }

  bindIO(io: DriverIO): void {
    ensureGitRepoForCodex(io.spawnCtx.workspacePath);

    this.io = io;
    this.threadId = io.spawnCtx.cliSessionId;
    this.pendingInitialPrompt = io.spawnCtx.initialPrompt || null;

    const standingPrompt = readFileSync(io.spawnCtx.systemPromptPath, 'utf-8');
    this.pendingThreadRequest = this.buildThreadRequest(io.spawnCtx, standingPrompt);

    // Defer until next microtask so SessionManager has finished wiring
    // the readline / event handlers — matches slock's `queueMicrotask`.
    queueMicrotask(() => {
      this.initializeRequestId = this.sendRequest('initialize', {
        clientInfo: { name: 'silverhand', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
    });
  }

  encodeStdinMessage(text: string, _cliSessionId: string | null): string | null {
    if (!this.threadId) return null;
    if (this.activeTurnId) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextRequestId(),
        method: 'turn/steer',
        params: {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input: [{ type: 'text', text }],
        },
      });
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id: this.nextRequestId(),
      method: 'turn/start',
      params: {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      },
    });
  }

  encodeInterruptControl(): string | null {
    // Codex app-server doesn't expose a clean turn-cancel RPC at the
    // moment slock targeted (and slock itself relies on signals).
    // Returning null tells SessionManager to fall through to SIGTERM.
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
      events.push({
        kind: 'error',
        message:
          typeof message.error?.message === 'string'
            ? message.error.message
            : 'Codex app-server request failed',
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
        events.push({ kind: 'error', message: detail });
        break;
      }
    }

    return events;
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
      case 'commandExecution':
        if (isStarted && typeof item.command === 'string') {
          events.push({
            kind: 'tool_call',
            name: 'shell',
            input: { command: item.command },
          });
        }
        if (isCompleted) events.push({ kind: 'tool_output', name: 'shell' });
        break;
      case 'contextCompaction':
        if (isStarted) events.push({ kind: 'compaction_started' });
        if (isCompleted) events.push({ kind: 'compaction_finished' });
        break;
      case 'fileChange':
        if (isStarted && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            events.push({
              kind: 'tool_call',
              name: 'file_change',
              input: { path: change?.path, kind: change?.kind },
            });
          }
        }
        break;
      case 'mcpToolCall': {
        const toolName =
          item.server === 'chat'
            ? `${this.mcpToolPrefix}${item.tool}`
            : `${this.mcpToolPrefix.replace(/_$/, '')}_${item.server}_${item.tool}`;
        if (isStarted) {
          events.push({ kind: 'tool_call', name: toolName, input: item.arguments });
        }
        if (isCompleted) {
          events.push({ kind: 'tool_output', name: toolName });
        }
        break;
      }
      case 'webSearch':
        if (isStarted) {
          events.push({
            kind: 'tool_call',
            name: 'web_search',
            input: { query: item.query },
          });
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
    if (ctx.model) params.model = ctx.model;
    if (ctx.cliSessionId) {
      return {
        method: 'thread/resume',
        params: { threadId: ctx.cliSessionId, ...params },
      };
    }
    return { method: 'thread/start', params };
  }

  private buildMcpConfigArgs(ctx: DriverSpawnContext): string[] {
    const { command, args } = ctx.chatBridge;
    const env = ctx.chatBridge.env ?? {};
    const cfg: string[] = [
      '-c',
      `mcp_servers.chat.command=${JSON.stringify(command)}`,
      '-c',
      `mcp_servers.chat.args=${JSON.stringify(args)}`,
      '-c',
      'mcp_servers.chat.startup_timeout_sec=30',
      '-c',
      'mcp_servers.chat.tool_timeout_sec=120',
      '-c',
      'mcp_servers.chat.enabled=true',
      '-c',
      'mcp_servers.chat.required=true',
    ];
    // Codex parses each `-c key=value` as TOML. Arrays/strings round-trip
    // fine through JSON.stringify (TOML accepts the JSON-array syntax
    // and double-quoted strings), but maps need TOML inline-table
    // syntax — JSON `{"k":"v"}` is rejected with `expected a map`.
    // Sidestep the syntax issue by emitting one `-c` per env key.
    for (const [key, val] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        // TOML bare-key chars only; quote if needed
        cfg.push('-c', `mcp_servers.chat.env.${JSON.stringify(key)}=${JSON.stringify(val)}`);
      } else {
        cfg.push('-c', `mcp_servers.chat.env.${key}=${JSON.stringify(val)}`);
      }
    }
    return cfg;
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
