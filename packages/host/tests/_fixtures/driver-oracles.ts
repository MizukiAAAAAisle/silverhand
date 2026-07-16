import type { RuntimeKind } from '@silverhand/shared';
import type { ParsedEvent } from '../../src/drivers/index.js';

export interface DriverOracleStep {
  line: string;
  expected: ParsedEvent[];
  /** Strings that must not appear in the parsed event projection. */
  forbiddenSubstrings?: string[];
}

export interface DriverParseOracle {
  id: string;
  runtime: Extract<RuntimeKind, 'claude' | 'codex' | 'cursor'>;
  description: string;
  incident: string;
  steps: DriverOracleStep[];
}

const j = (value: unknown): string => JSON.stringify(value);

export const DRIVER_PARSE_ORACLES: DriverParseOracle[] = [
  {
    id: 'claude-api-error-redaction',
    runtime: 'claude',
    description: 'Claude system.api_error becomes a safe retry activity without endpoint leakage',
    incident: '2026-05-22 api_error activity parity',
    steps: [
      {
        line: j({
          type: 'system',
          subtype: 'api_error',
          level: 'error',
          error: {
            cause: {
              code: 'ConnectionRefused',
              path: 'http://127.0.0.1:9090/v1/messages?beta=true',
            },
          },
          retryAttempt: 3,
        }),
        expected: [
          {
            kind: 'error',
            code: 'api_connection_refused',
            message: 'Claude API gateway unreachable; retrying (attempt 3)',
          },
        ],
        forbiddenSubstrings: ['127.0.0.1', '/v1/messages', '9090'],
      },
    ],
  },
  {
    id: 'claude-assistant-tool-result-turn-end',
    runtime: 'claude',
    description: 'Claude assistant/tool/result frames project the run-state primitives',
    incident: 'daemon parse fanout and gated delivery',
    steps: [
      {
        line: j({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'pondering' },
              { type: 'text', text: 'hello' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
        }),
        expected: [
          { kind: 'thinking', text: 'pondering' },
          { kind: 'text', text: 'hello' },
          {
            kind: 'tool_call',
            name: 'Bash',
            input: { command: 'pwd' },
            toolCallId: 'tool-1',
          },
        ],
      },
      {
        line: j({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                name: 'Bash',
                content: 'ok',
              },
            ],
          },
        }),
        expected: [{ kind: 'tool_output', name: 'Bash', toolCallId: 'tool-1' }],
      },
      {
        line: j({
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['boom'],
          result: 'failed',
          session_id: 'sess-claude',
        }),
        expected: [
          { kind: 'error', message: 'boom | failed' },
          { kind: 'turn_end', sessionId: 'sess-claude' },
        ],
      },
    ],
  },
  {
    id: 'claude-compaction-boundary',
    runtime: 'claude',
    description: 'Claude compaction status and boundary stay distinct lifecycle events',
    incident: 'daemon activity parity',
    steps: [
      {
        line: j({ type: 'system', subtype: 'status', status: 'compacting' }),
        expected: [{ kind: 'compaction_started' }],
      },
      {
        line: j({ type: 'system', subtype: 'compact_boundary' }),
        expected: [{ kind: 'compaction_finished' }],
      },
    ],
  },
  {
    id: 'cursor-oneshot-result-error',
    runtime: 'cursor',
    description: 'Cursor one-shot stream-json result emits error plus terminal turn_end',
    incident: 'oneShot respawn and terminal-state mapping',
    steps: [
      {
        line: j({ type: 'system', subtype: 'init', session_id: 'cursor-sess' }),
        expected: [{ kind: 'session_init', sessionId: 'cursor-sess' }],
      },
      {
        line: j({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'checking' },
              { type: 'text', text: 'done' },
            ],
          },
        }),
        expected: [
          { kind: 'thinking', text: 'checking' },
          { kind: 'text', text: 'done' },
        ],
      },
      {
        line: j({
          type: 'result',
          subtype: 'error',
          is_error: true,
          errors: ['cursor boom'],
          result: 'see log',
          session_id: 'cursor-sess',
        }),
        expected: [
          { kind: 'error', message: 'cursor boom | see log' },
          { kind: 'turn_end', sessionId: 'cursor-sess' },
        ],
      },
    ],
  },
  {
    id: 'codex-turn-tool-lifecycle',
    runtime: 'codex',
    description: 'Codex thread, turn, command tool, and terminal frames preserve ordering',
    incident: 'codex daemon-mode delivery and run-state projection',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          method: 'thread/started',
          params: { thread: { id: 'thread-codex' } },
        }),
        expected: [{ kind: 'session_init', sessionId: 'thread-codex' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'turn/started',
          params: { turn: { id: 'turn-1' } },
        }),
        expected: [{ kind: 'thinking', text: '' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/started',
          params: { item: { type: 'commandExecution', command: 'ls -al' } },
        }),
        expected: [{ kind: 'tool_call', name: 'shell', input: { command: 'ls -al' } }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { item: { type: 'commandExecution', command: 'ls -al' } },
        }),
        expected: [{ kind: 'tool_output', name: 'shell' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } },
        }),
        expected: [{ kind: 'turn_end', sessionId: 'thread-codex' }],
      },
    ],
  },
  {
    id: 'codex-streamed-message-no-duplicate',
    runtime: 'codex',
    description: 'Codex streamed text is not re-emitted on item completion',
    incident: 'driver parser state must not duplicate deltas',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          method: 'thread/started',
          params: { thread: { id: 'thread-stream' } },
        }),
        expected: [{ kind: 'session_init', sessionId: 'thread-stream' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/agentMessage/delta',
          params: { itemId: 'msg-1', delta: 'Hello' },
        }),
        expected: [{ kind: 'text', text: 'Hello' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { item: { type: 'agentMessage', id: 'msg-1', text: 'Hello' } },
        }),
        expected: [],
      },
    ],
  },
  {
    id: 'codex-pending-tool-state-cleared-on-turn-end',
    runtime: 'codex',
    description: 'Codex pending tool ids are cleared on turn end to avoid late phantom outputs',
    incident: 'toolCallCounts and outstandingToolUses drift',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          method: 'thread/started',
          params: { thread: { id: 'thread-clean' } },
        }),
        expected: [{ kind: 'session_init', sessionId: 'thread-clean' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/started',
          params: { item: { type: 'webSearch', id: 'ws-1', query: 'silverhand' } },
        }),
        expected: [{ kind: 'tool_call', name: 'web_search', input: { query: 'silverhand' } }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { id: 'turn-clean', status: 'completed' } },
        }),
        expected: [{ kind: 'turn_end', sessionId: 'thread-clean' }],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { item: { type: 'webSearch', id: 'ws-1' } },
        }),
        expected: [],
      },
    ],
  },
  {
    id: 'codex-file-change-counted-output',
    runtime: 'codex',
    description: 'Codex fileChange completion emits exactly one output per remembered change',
    incident: 'toolCallCounts parity',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/started',
          params: {
            item: {
              type: 'fileChange',
              id: 'fc-1',
              changes: [
                { path: 'a.ts', kind: 'modify' },
                { path: 'b.ts', kind: 'create' },
              ],
            },
          },
        }),
        expected: [
          { kind: 'tool_call', name: 'file_change', input: { path: 'a.ts', kind: 'modify' } },
          { kind: 'tool_call', name: 'file_change', input: { path: 'b.ts', kind: 'create' } },
        ],
      },
      {
        line: j({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { item: { type: 'fileChange', id: 'fc-1' } },
        }),
        expected: [
          { kind: 'tool_output', name: 'file_change' },
          { kind: 'tool_output', name: 'file_change' },
        ],
      },
    ],
  },
  {
    id: 'codex-thread-not-found-is-fatal',
    runtime: 'codex',
    description: 'Codex stale resume target is a fatal thread_not_found error',
    incident: 'resume jsonl recovery',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          id: 99,
          error: { code: -32602, message: 'thread not found: thread-stale' },
        }),
        expected: [
          {
            kind: 'error',
            message: 'thread not found: thread-stale',
            code: 'thread_not_found',
            fatal: true,
          },
        ],
      },
    ],
  },
  {
    id: 'codex-session-archived-is-fatal',
    runtime: 'codex',
    description: 'Codex archived resume target is a fatal session_archived error',
    incident: 'restore after codex-side session archive',
    steps: [
      {
        line: j({
          jsonrpc: '2.0',
          id: 100,
          error: {
            code: -32602,
            message:
              'session 019f3ba4-a772-7010-a52a-8cdac98ddfd5 is archived. Run codex unarchive 019f3ba4-a772-7010-a52a-8cdac98ddfd5 to unarchive it first.',
          },
        }),
        expected: [
          {
            kind: 'error',
            message:
              'session 019f3ba4-a772-7010-a52a-8cdac98ddfd5 is archived. Run codex unarchive 019f3ba4-a772-7010-a52a-8cdac98ddfd5 to unarchive it first.',
            code: 'session_archived',
            fatal: true,
          },
        ],
      },
    ],
  },
];
