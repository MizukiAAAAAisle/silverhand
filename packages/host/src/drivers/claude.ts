import { randomUUID } from 'node:crypto';
import {
  type Driver,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';

const DISALLOWED_TOOLS = [
  'EnterPlanMode',
  'ExitPlanMode',
  'ScheduleWakeup',
  'CronCreate',
  'CronList',
  'CronDelete',
].join(',');

/**
 * Claude Code driver.
 *
 * Reference: behaviour mirrored from `@slock-ai/daemon` (claude.ts) plus
 * the canonical `control_request` interrupt format extracted from the
 * Claude Code binary itself.
 *
 * Notes:
 * - Stream-json bidirectional: we both consume claude's output and write
 *   user messages on stdin in the same JSON-line format.
 * - We pass the standing system prompt via `--append-system-prompt-file`
 *   (file path) rather than `--append-system-prompt <text>`, since the
 *   synthesized §4.7 platform prompt easily exceeds argv length limits.
 *   `--append-system-prompt-file` *appends* our platform manual onto
 *   Claude Code's built-in system prompt (tool usage, CLAUDE.md handling,
 *   etc.) rather than replacing it — this keeps Claude's native coding
 *   affordances intact and aligns Claude with the Codex driver, whose
 *   `developerInstructions` already layers on top of Codex's base prompt.
 * - We delete `CLAUDECODE` from the env to keep nested invocations from
 *   tripping Claude's "I'm running inside Claude Code" branch.
 */
export class ClaudeDriver implements Driver {
  readonly kind = 'claude' as const;
  readonly binary = 'claude';
  readonly kickoffMode = 'requires_first_message' as const;
  readonly busyDeliveryMode = 'gated' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 30 * 1000;
  readonly initPreProtocolCapMs = 5 * 60 * 1000;
  // 60s post-protocol budget. Aligned with codex driver — the post-protocol
  // window measures time from first well-formed JSON frame to `system.init`,
  // and we want all runtimes to share a single recovery budget so PR-A
  // failure-mode triage (`reason=post_protocol`) doesn't depend on driver.
  readonly initPostProtocolMs = 60 * 1000;

  buildArgs(ctx: DriverSpawnContext): string[] {
    const args = [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--model',
      ctx.model || 'opus',
      '--disallowed-tools',
      DISALLOWED_TOOLS,
      '--append-system-prompt-file',
      ctx.systemPromptPath,
    ];
    if (ctx.cliSessionId) {
      args.push('--resume', ctx.cliSessionId);
    }
    return args;
  }

  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...baseEnv };
    delete env.CLAUDECODE;
    return env;
  }

  encodeStdinMessage(content: string, cliSessionId: string | null): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
      },
      ...(cliSessionId ? { session_id: cliSessionId } : {}),
    });
  }

  encodeInterruptControl(): string {
    return JSON.stringify({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [{ kind: 'unknown', raw: trimmed }];
    }

    const events: ParsedEvent[] = [];

    switch (event.type) {
      case 'system': {
        if (event.subtype === 'init' && typeof event.session_id === 'string') {
          events.push({ kind: 'session_init', sessionId: event.session_id });
        }
        if (event.subtype === 'api_error') {
          events.push(parseClaudeApiError(event));
        }
        if (event.subtype === 'status' && event.status === 'compacting') {
          events.push({ kind: 'compaction_started' });
        }
        if (event.subtype === 'compact_boundary') {
          events.push({ kind: 'compaction_finished' });
        }
        break;
      }

      case 'assistant': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'thinking' && typeof block.thinking === 'string') {
              events.push({ kind: 'thinking', text: block.thinking });
            } else if (block?.type === 'text' && typeof block.text === 'string') {
              events.push({ kind: 'text', text: block.text });
            } else if (block?.type === 'tool_use') {
              events.push({
                kind: 'tool_call',
                name: typeof block.name === 'string' ? block.name : 'unknown_tool',
                input: block.input,
                toolCallId: typeof block.id === 'string' ? block.id : undefined,
              });
            }
          }
        }
        break;
      }

      case 'user': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              events.push({
                kind: 'tool_output',
                name: typeof block.name === 'string' ? block.name : undefined,
                toolCallId:
                  typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              });
            }
          }
        }
        break;
      }

      case 'result': {
        const subtype = typeof event.subtype === 'string' ? event.subtype : 'success';
        const stopReason =
          typeof event.stop_reason === 'string' ? event.stop_reason : null;
          const errorIfNotBudget = (fallback: string) => {
            if (stopReason !== 'max_tokens') {
              const detail = collectResultError(event) || fallback;
              events.push({
                kind: 'error',
                message: detail,
                ...classifyClaudeError(detail),
              });
            }
          };
        switch (subtype) {
          case 'success':
            if (event.is_error) errorIfNotBudget('Execution failed');
            break;
          case 'error_during_execution':
            errorIfNotBudget('Execution failed');
            break;
          case 'error_max_budget_usd':
            events.push({
              kind: 'error',
              message: collectResultError(event) || 'Budget limit exceeded',
            });
            break;
          case 'error_max_turns':
            events.push({
              kind: 'error',
              message: collectResultError(event) || 'Max turns exceeded',
            });
            break;
          case 'error_max_structured_output_retries':
            events.push({
              kind: 'error',
              message:
                collectResultError(event) || 'Structured output retries exceeded',
            });
            break;
        }
        events.push({
          kind: 'turn_end',
          sessionId:
            typeof event.session_id === 'string' ? event.session_id : undefined,
        });
        break;
      }

      default:
        // unknown but well-formed JSON — discard silently
        break;
    }

    return events;
  }

  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (event?.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      return 'session_ready';
    }
    return event && typeof event === 'object' ? 'protocol_ready' : null;
  }
}

function parseClaudeApiError(event: any): ParsedEvent {
  const causeCode =
    typeof event.error?.cause?.code === 'string'
      ? event.error.cause.code
      : typeof event.cause?.code === 'string'
        ? event.cause.code
        : null;
  const retryAttempt =
    typeof event.retryAttempt === 'number' && Number.isFinite(event.retryAttempt)
      ? event.retryAttempt
      : null;
  const code =
    causeCode === 'ConnectionRefused'
      ? 'api_connection_refused'
      : 'api_error';
  const base =
    causeCode === 'ConnectionRefused'
      ? 'Claude API gateway unreachable; retrying'
      : 'Claude API request failed; retrying';
  return {
    kind: 'error',
    code,
    message:
      retryAttempt !== null ? `${base} (attempt ${retryAttempt})` : base,
  };
}

function collectResultError(event: any): string {
  const parts: string[] = [];
  if (Array.isArray(event.errors)) {
    for (const e of event.errors) {
      if (typeof e === 'string' && e.trim()) parts.push(e.trim());
    }
  }
  if (typeof event.result === 'string' && event.result.trim()) {
    parts.push(event.result.trim());
  }
  return parts.join(' | ');
}

function classifyClaudeError(message: string): { code?: string; fatal?: boolean } {
  if (
    message.includes('No conversation found with session ID:') ||
    message.includes('--resume requires a valid session ID')
  ) {
    return { code: 'session_not_found', fatal: true };
  }
  return {};
}
