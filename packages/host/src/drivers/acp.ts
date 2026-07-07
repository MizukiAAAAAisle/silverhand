import {
  type DriverIO,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: any;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AcpPermissionPolicy {
  /**
   * Runtime-tool permissions are a separate authorization plane from
   * Silverhand roles/capabilities. The ACP core stays fail-closed: adapters
   * may explicitly allow a request, otherwise the core selects a reject option
   * (or returns `cancelled` when no reject option exists).
   */
  shouldAllow(params: unknown): boolean;
}

export interface AcpRuntimeAdapter {
  readonly runtimeLabel: string;
  readonly permissionPolicy?: AcpPermissionPolicy;

  buildInitializeParams(ctx: DriverSpawnContext): Record<string, unknown>;
  buildSessionParams(ctx: DriverSpawnContext): Record<string, unknown>;
  buildSetModelParams?(
    ctx: DriverSpawnContext,
    sessionId: string,
  ): Record<string, unknown> | null;
}

/**
 * Stateful ACP v1 client used inside concrete runtime drivers.
 *
 * This deliberately does NOT extend the host Driver shape. The supervisor
 * still sees ordinary Driver methods; ACP is only a reusable implementation
 * detail for runtimes whose process speaks JSON-RPC over stdio.
 */
export class AcpClient {
  private io: DriverIO | null = null;
  private requestId = 0;
  private initializeRequestId: JsonRpcId | null = null;
  private sessionRequestId: JsonRpcId | null = null;
  private modelRequestId: JsonRpcId | null = null;
  private activePromptRequestId: JsonRpcId | null = null;
  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private emittedToolCalls = new Set<string>();

  constructor(private readonly adapter: AcpRuntimeAdapter) {}

  bindIO(io: DriverIO): void {
    this.io = io;
    queueMicrotask(() => {
      this.initializeRequestId = this.sendRequest(
        'initialize',
        this.adapter.buildInitializeParams(io.spawnCtx),
      );
    });
  }

  readyToEncode(): boolean {
    return this.sessionAnnounced && this.activePromptRequestId === null;
  }

  encodeStdinMessage(text: string): string | null {
    if (!this.readyToEncode() || !this.sessionId) return null;
    const id = this.nextRequestId();
    this.activePromptRequestId = id;
    return serialize({
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      },
    });
  }

  encodeInterruptControl(): string | null {
    if (!this.sessionId || this.activePromptRequestId === null) return null;
    return serialize({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: this.sessionId },
    });
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return [{ kind: 'unknown', raw: trimmed }];
    }

    if (!isRecord(message)) return [{ kind: 'unknown', raw: trimmed }];

    if ('result' in message || 'error' in message) {
      return this.handleResponse(message as JsonRpcResponse);
    }

    if (!('method' in message) || typeof message.method !== 'string') return [];

    if (message.method === 'session/update') {
      return this.mapSessionUpdate((message as JsonRpcNotification).params);
    }

    if (isJsonRpcRequest(message)) {
      this.handleAgentRequest(message);
    }

    return [];
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
    // ACP session-ready is owned by parseLine emitting `session_init`, not this
    // pure classifier. A concrete runtime may need additional post-session
    // setup (OpenCode sets the model via `session/set_config_option`) before
    // it is safe for the supervisor to drain the first inbox row.
    return message.jsonrpc === '2.0' ? 'protocol_ready' : null;
  }

  private handleResponse(message: JsonRpcResponse): ParsedEvent[] {
    const events: ParsedEvent[] = [];

    if (message.error) {
      this.clearPendingForResponse(message.id);
      events.push({
        kind: 'error',
        message:
          typeof message.error.message === 'string'
            ? message.error.message
            : `${this.adapter.runtimeLabel} ACP request failed`,
      });
      if (message.id === this.activePromptRequestId) {
        this.activePromptRequestId = null;
        events.push({ kind: 'turn_end', sessionId: this.sessionId ?? undefined });
      }
      return events;
    }

    if (message.id === this.initializeRequestId) {
      this.initializeRequestId = null;
      const ctx = this.io?.spawnCtx;
      if (ctx) {
        this.sessionRequestId = this.sendRequest(
          ctx.cliSessionId ? 'session/resume' : 'session/new',
          this.adapter.buildSessionParams(ctx),
        );
      }
      return events;
    }

    if (message.id === this.sessionRequestId) {
      this.sessionRequestId = null;
      const sessionId = message.result?.sessionId;
      if (typeof sessionId === 'string') {
        this.sessionId = sessionId;
        const ctx = this.io?.spawnCtx;
        const modelParams =
          ctx && this.adapter.buildSetModelParams
            ? this.adapter.buildSetModelParams(ctx, sessionId)
            : null;
        if (modelParams) {
          this.modelRequestId = this.sendRequest(
            'session/set_config_option',
            modelParams,
          );
        } else {
          this.announceSession(events);
        }
      }
      return events;
    }

    if (message.id === this.modelRequestId) {
      this.modelRequestId = null;
      this.announceSession(events);
      return events;
    }

    if (message.id === this.activePromptRequestId) {
      this.activePromptRequestId = null;
      events.push({ kind: 'turn_end', sessionId: this.sessionId ?? undefined });
      return events;
    }

    return events;
  }

  private clearPendingForResponse(id: JsonRpcId): void {
    if (id === this.initializeRequestId) this.initializeRequestId = null;
    if (id === this.sessionRequestId) this.sessionRequestId = null;
    if (id === this.modelRequestId) this.modelRequestId = null;
  }

  private announceSession(events: ParsedEvent[]): void {
    if (!this.sessionId || this.sessionAnnounced) return;
    this.sessionAnnounced = true;
    events.push({ kind: 'session_init', sessionId: this.sessionId });
  }

  private mapSessionUpdate(params: unknown): ParsedEvent[] {
    const update = recordField(recordField(params).update);
    const kind = stringField(update.sessionUpdate);
    const events: ParsedEvent[] = [];

    switch (kind) {
      case 'agent_message_chunk': {
        const text = textFromContent(update.content);
        if (text) events.push({ kind: 'text', text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = textFromContent(update.content);
        if (text) events.push({ kind: 'thinking', text });
        break;
      }
      case 'tool_call': {
        const toolCallId = stringField(update.toolCallId);
        if (toolCallId && this.emittedToolCalls.has(toolCallId)) break;
        if (toolCallId) this.emittedToolCalls.add(toolCallId);
        events.push({
          kind: 'tool_call',
          name: toolName(update),
          input: update.rawInput ?? {},
          ...(toolCallId ? { toolCallId } : {}),
        });
        if (isTerminalToolStatus(update.status)) {
          events.push({ kind: 'tool_output', ...(toolCallId ? { toolCallId } : {}) });
        }
        break;
      }
      case 'tool_call_update': {
        const toolCallId = stringField(update.toolCallId);
        if (isTerminalToolStatus(update.status)) {
          events.push({
            kind: 'tool_output',
            ...(toolCallId ? { toolCallId } : {}),
          });
        }
        break;
      }
      case 'plan': {
        const summary = planSummary(update.entries);
        if (summary) events.push({ kind: 'thinking', text: summary });
        break;
      }
      default:
        break;
    }

    return events;
  }

  private handleAgentRequest(message: JsonRpcRequest): void {
    if (message.method === 'session/request_permission') {
      void this.writeLine(
        serialize({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            outcome: this.permissionOutcome(message.params),
          },
        }),
      );
      return;
    }

    if (
      message.method.startsWith('fs/') ||
      message.method.startsWith('terminal/')
    ) {
      void this.writeLine(
        serialize({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `${message.method} is not supported by the Silverhand ACP client`,
          },
        }),
      );
      return;
    }

    void this.writeLine(
      serialize({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown ACP client method ${message.method}` },
      }),
    );
  }

  private permissionOutcome(params: unknown): Record<string, unknown> {
    const options = Array.isArray(recordField(params).options)
      ? (recordField(params).options as unknown[])
      : [];
    const allowed = this.adapter.permissionPolicy?.shouldAllow(params) === true;
    const selected = selectPermissionOption(options, allowed);
    if (selected) return { outcome: 'selected', optionId: selected };
    return { outcome: 'cancelled' };
  }

  private sendRequest(method: string, params: unknown): JsonRpcId {
    const id = this.nextRequestId();
    void this.writeLine(serialize({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private async writeLine(line: string): Promise<void> {
    await this.io?.writeLine(line);
  }
}

function serialize(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordField(value: unknown): Record<string, any> {
  return isRecord(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return (
    isRecord(message) &&
    'id' in message &&
    'method' in message &&
    typeof message.method === 'string' &&
    !('result' in message) &&
    !('error' in message)
  );
}

function textFromContent(content: unknown): string | null {
  const c = recordField(content);
  if (typeof c.text === 'string') return c.text;
  if (typeof c.content === 'string') return c.content;
  const nested = recordField(c.content);
  if (typeof nested.text === 'string') return nested.text;
  return null;
}

function toolName(update: Record<string, any>): string {
  const rawInput = recordField(update.rawInput);
  return (
    stringField(rawInput.tool) ??
    stringField(rawInput.name) ??
    stringField(update.title) ??
    stringField(update.kind) ??
    'unknown_tool'
  );
}

function isTerminalToolStatus(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function planSummary(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const lines = entries
    .map(entry => {
      const e = recordField(entry);
      const content = stringField(e.content);
      const status = stringField(e.status);
      return content ? `${status ? `${status}: ` : ''}${content}` : null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : null;
}

function selectPermissionOption(
  options: unknown[],
  allowed: boolean,
): string | null {
  const wanted = allowed
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const found = options.find(option => recordField(option).kind === kind);
    const optionId = stringField(recordField(found).optionId);
    if (optionId) return optionId;
  }
  return null;
}
