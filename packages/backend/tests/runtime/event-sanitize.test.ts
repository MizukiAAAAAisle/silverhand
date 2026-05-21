/**
 * Unit tests for `event-sanitize` — `sanitizeParsedEventForBroadcast`
 * lifted from CM in commit 5 unit 1. These pin the contract that both
 * the legacy CM `agent_event` publish AND the daemon-path
 * `RuntimeEventHandler.runtime_parsed_event` projection MUST honor
 * identically: large `tool_call.input` capped, recursion bounded,
 * circular refs marked, non-`tool_call` events unmodified.
 *
 * Cindy carried this from commit-4 review as a commit-5 hard blocker
 * (`ch9ZsU0v0ATr6tr8`): "atomic flip 前必须映射回现有 `agent_event`，
 * 并复用 `sanitizeParsedEventForBroadcast`，否则 Events 窗口和大
 * tool_call input sanitize 会回归."
 */
import { describe, expect, it } from 'vitest';
import type { ParsedEvent } from '@silverhand/shared';
import {
  RAW_AGENT_EVENT_ARRAY_MAX_ITEMS,
  RAW_AGENT_EVENT_MAX_DEPTH,
  RAW_AGENT_EVENT_OBJECT_MAX_KEYS,
  RAW_AGENT_EVENT_STRING_MAX_CHARS,
  sanitizeParsedEventForBroadcast,
  sanitizeRawAgentEventValue,
  truncateRawAgentEventString,
} from '../../src/runtime/event-sanitize.js';

function toolCall(input: unknown): ParsedEvent {
  return {
    kind: 'tool_call',
    toolUseId: 'tu-1',
    name: 'bash',
    input,
  } as ParsedEvent;
}

describe('sanitizeParsedEventForBroadcast', () => {
  it('passes non-tool_call events through unchanged (reference equality)', () => {
    const ev: ParsedEvent = { kind: 'text', text: 'hello' };
    const out = sanitizeParsedEventForBroadcast(ev);
    expect(out).toBe(ev);
  });

  it('truncates large string fields inside tool_call.input', () => {
    const long = 'x'.repeat(RAW_AGENT_EVENT_STRING_MAX_CHARS + 200);
    const ev = toolCall({ command: long });
    const out = sanitizeParsedEventForBroadcast(ev) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    const sanitized = (out.input as { command: string }).command;
    expect(sanitized.length).toBeLessThan(long.length);
    expect(sanitized).toContain('<truncated 200 chars>');
    // Original input still untouched — sanitizer must be pure.
    expect(
      ((ev as Extract<ParsedEvent, { kind: 'tool_call' }>).input as {
        command: string;
      }).command,
    ).toBe(long);
  });

  it('preserves shallow object structure when within caps', () => {
    const ev = toolCall({ a: 1, b: 'short', c: true, d: null });
    const out = sanitizeParsedEventForBroadcast(ev) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    expect(out.input).toEqual({
      a: 1,
      b: 'short',
      c: true,
      d: null,
    });
  });

  it('caps arrays and appends __truncatedItems marker', () => {
    const arr = Array.from({ length: RAW_AGENT_EVENT_ARRAY_MAX_ITEMS + 5 }, (_, i) => i);
    const out = sanitizeParsedEventForBroadcast(toolCall({ list: arr })) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    const list = (out.input as { list: unknown[] }).list;
    expect(list.length).toBe(RAW_AGENT_EVENT_ARRAY_MAX_ITEMS + 1);
    expect(list[RAW_AGENT_EVENT_ARRAY_MAX_ITEMS]).toEqual({
      __truncatedItems: 5,
    });
  });

  it('caps object keys and appends __truncatedKeys marker', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < RAW_AGENT_EVENT_OBJECT_MAX_KEYS + 7; i++) {
      obj[`k${i}`] = i;
    }
    const out = sanitizeParsedEventForBroadcast(toolCall(obj)) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    const input = out.input as Record<string, unknown>;
    expect(Object.keys(input).length).toBe(
      RAW_AGENT_EVENT_OBJECT_MAX_KEYS + 1,
    );
    expect(input.__truncatedKeys).toBe(7);
  });

  it('returns "[Truncated object]" past max depth (no stack blow)', () => {
    let depth: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < RAW_AGENT_EVENT_MAX_DEPTH + 2; i++) {
      depth = { nest: depth };
    }
    const out = sanitizeParsedEventForBroadcast(toolCall(depth)) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    // The exact level depends on counting; the important assertion
    // is that we eventually see a truncation marker rather than
    // recurring forever.
    const json = JSON.stringify(out.input);
    expect(json).toContain('[Truncated object]');
  });

  it('marks circular references as "[Circular]"', () => {
    const cyc: Record<string, unknown> = { name: 'root' };
    cyc.self = cyc;
    const out = sanitizeParsedEventForBroadcast(toolCall(cyc)) as Extract<
      ParsedEvent,
      { kind: 'tool_call' }
    >;
    const input = out.input as Record<string, unknown>;
    expect(input.name).toBe('root');
    expect(input.self).toBe('[Circular]');
  });

  it('stringifies bigints (JSON cannot encode them natively)', () => {
    // Use a BigInt literal — `BigInt(9007199254740993)` would round
    // the Number argument to 9007199254740992 before the conversion.
    const out = sanitizeParsedEventForBroadcast(
      toolCall({ count: 9007199254740993n }),
    ) as Extract<ParsedEvent, { kind: 'tool_call' }>;
    expect((out.input as { count: string }).count).toBe('9007199254740993');
  });
});

describe('truncateRawAgentEventString', () => {
  it('returns short strings unchanged', () => {
    expect(truncateRawAgentEventString('hello')).toBe('hello');
  });

  it('appends a count marker on truncation', () => {
    const s = 'a'.repeat(RAW_AGENT_EVENT_STRING_MAX_CHARS + 13);
    const out = truncateRawAgentEventString(s);
    expect(out).toContain('<truncated 13 chars>');
    expect(out.startsWith('a'.repeat(RAW_AGENT_EVENT_STRING_MAX_CHARS))).toBe(
      true,
    );
  });
});

describe('sanitizeRawAgentEventValue — terminal primitives', () => {
  it('passes null / number / boolean unchanged', () => {
    expect(sanitizeRawAgentEventValue(null)).toBeNull();
    expect(sanitizeRawAgentEventValue(42)).toBe(42);
    expect(sanitizeRawAgentEventValue(true)).toBe(true);
    expect(sanitizeRawAgentEventValue(false)).toBe(false);
  });

  it('passes undefined unchanged (callers strip when serializing)', () => {
    expect(sanitizeRawAgentEventValue(undefined)).toBeUndefined();
  });
});
