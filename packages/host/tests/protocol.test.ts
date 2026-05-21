import { describe, expect, it } from 'vitest';
import {
  AnyFrameSchema,
  EventFrameSchema,
  MAX_FRAME_BYTES,
  RequestFrameSchema,
  ResponseFrameSchema,
  RuntimeStartParamsSchema,
  RuntimeWakeParamsSchema,
  RuntimeWakeResultSchema,
  encodeFrame,
  intentSchemas,
  splitNdjson,
} from '../src/protocol.js';

describe('protocol — frame schemas', () => {
  it('parses a well-formed request frame', () => {
    const parsed = RequestFrameSchema.safeParse({
      id: 'abc',
      intent: 'ping',
      params: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects requests with empty id', () => {
    expect(RequestFrameSchema.safeParse({ id: '', intent: 'ping', params: {} }).success).toBe(false);
  });

  it('accepts both result and error variants of response', () => {
    expect(ResponseFrameSchema.safeParse({ id: 'a', result: { ok: 1 } }).success).toBe(true);
    expect(
      ResponseFrameSchema.safeParse({
        id: 'a',
        error: { code: 'unknown_intent', message: 'x' },
      }).success,
    ).toBe(true);
  });

  it('rejects responses with an unknown error code', () => {
    expect(
      ResponseFrameSchema.safeParse({
        id: 'a',
        error: { code: 'oops_typo', message: 'x' },
      }).success,
    ).toBe(false);
  });

  it('discriminates events by `event` field', () => {
    const r = EventFrameSchema.safeParse({
      event: 'ready',
      socket_path: '/tmp/x.sock',
      daemon_pid: 1,
      daemon_version: '0.0.0',
      started_at: 0,
    });
    expect(r.success).toBe(true);
    const s = EventFrameSchema.safeParse({ event: 'shutting_down', reason: 'SIGTERM' });
    expect(s.success).toBe(true);
    const bogus = EventFrameSchema.safeParse({ event: 'sneaky' });
    expect(bogus.success).toBe(false);
  });

  it('AnyFrame admits requests, responses, and events but not random objects', () => {
    expect(AnyFrameSchema.safeParse({ id: 'a', intent: 'ping', params: {} }).success).toBe(true);
    expect(AnyFrameSchema.safeParse({ id: 'a', result: {} }).success).toBe(true);
    expect(AnyFrameSchema.safeParse({ event: 'shutting_down', reason: 'x' }).success).toBe(true);
    expect(AnyFrameSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('protocol — splitNdjson', () => {
  it('splits a buffer with no leftover when all lines complete', () => {
    const r = splitNdjson('', '{"a":1}\n{"b":2}\n');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.leftover).toBe('');
    expect(r.overflow).toBe(false);
  });

  it('keeps an unterminated tail as leftover', () => {
    const r = splitNdjson('', '{"a":1}\n{"b":');
    expect(r.frames).toEqual(['{"a":1}']);
    expect(r.leftover).toBe('{"b":');
  });

  it('merges leftover with new chunk', () => {
    const a = splitNdjson('', '{"a":');
    expect(a.frames).toEqual([]);
    const b = splitNdjson(a.leftover, '1}\n');
    expect(b.frames).toEqual(['{"a":1}']);
  });

  it('ignores empty lines (extra \\n between frames)', () => {
    const r = splitNdjson('', '\n{"a":1}\n\n{"b":2}\n');
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('flags overflow when a single line exceeds MAX_FRAME_BYTES', () => {
    const big = '"' + 'x'.repeat(MAX_FRAME_BYTES + 10) + '"';
    const r = splitNdjson('', `${big}\n`);
    expect(r.overflow).toBe(true);
    expect(r.frames).toEqual([]);
  });

  it('flags overflow when an unterminated leftover would exceed cap', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 10);
    const r = splitNdjson('', big);
    expect(r.overflow).toBe(true);
    expect(r.leftover).toBe('');
  });
});

describe('protocol — encodeFrame', () => {
  it('appends a single trailing newline', () => {
    const s = encodeFrame({ id: 'x', intent: 'ping', params: {} });
    expect(s.endsWith('\n')).toBe(true);
    expect(s.includes('\n', 0)).toBe(true);
    expect(s.split('\n').length).toBe(2);
  });

  it('throws when the encoded line would exceed MAX_FRAME_BYTES', () => {
    expect(() =>
      encodeFrame({ id: 'x', intent: 'echo', params: { message: 'a'.repeat(MAX_FRAME_BYTES + 1) } }),
    ).toThrow(/MAX_FRAME_BYTES/);
  });
});

describe('protocol — runtime_* registry', () => {
  it('registers every PR-2 runtime intent', () => {
    const expected = [
      'runtime_start',
      'runtime_stop',
      'runtime_wake',
      'runtime_status',
      'runtime_clear_session',
      'runtime_stop_all',
      'runtime_close_activity_log',
      'runtime_output_pause',
      'runtime_output_resume',
    ] as const;
    for (const name of expected) {
      expect(intentSchemas).toHaveProperty(name);
      expect(intentSchemas[name]).toHaveProperty('params');
      expect(intentSchemas[name]).toHaveProperty('result');
    }
  });

  it('does NOT register runtime_inject_env (removed v3)', () => {
    expect(intentSchemas as Record<string, unknown>).not.toHaveProperty(
      'runtime_inject_env',
    );
  });

  it('runtime_start accepts optional startup_delivery batch', () => {
    const ok = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: {
        delivery_ids: [101, 102, 103],
        payload: { type: 'user', message: { content: '...' } },
      },
    });
    expect(ok.success).toBe(true);

    const okNoDelivery = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
    });
    expect(okNoDelivery.success).toBe(true);
  });

  it('runtime_start rejects empty startup_delivery.delivery_ids', () => {
    const r = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: { delivery_ids: [], payload: {} },
    });
    expect(r.success).toBe(false);
  });

  it('runtime_wake is batch-native — delivery_ids must be non-empty', () => {
    const ok = RuntimeWakeParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: {},
    });
    expect(ok.success).toBe(true);

    const empty = RuntimeWakeParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [],
      kind: 'message',
      payload: {},
    });
    expect(empty.success).toBe(false);
  });

  it('runtime_wake REJECTS missing payload (review fix Cindy ihw5XHpjldmEc-wt)', () => {
    // The step-0 contract says delivery_ids MUST NOT reach the daemon
    // without an accompanying stdin payload. A bare `z.unknown()`
    // would treat `payload` as optional; the refinement guard rejects
    // both omission and explicit `undefined`.
    const missing = RuntimeWakeParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
    });
    expect(missing.success).toBe(false);

    const explicitUndef = RuntimeWakeParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      payload: undefined,
    });
    expect(explicitUndef.success).toBe(false);

    // Null is a valid stream-json value (the wire is still opaque per
    // step 1) — only undefined / missing is forbidden.
    const nullPayload = RuntimeWakeParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      payload: null,
    });
    expect(nullPayload.success).toBe(true);
  });

  it('runtime_start.startup_delivery REJECTS missing payload (review fix Cindy ihw5XHpjldmEc-wt)', () => {
    const missing = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: { delivery_ids: [101] },
    });
    expect(missing.success).toBe(false);

    const explicitUndef = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {},
      startup_delivery: { delivery_ids: [101], payload: undefined },
    });
    expect(explicitUndef.success).toBe(false);
  });

  it('runtime_wake result is all-or-nothing — success carries delivery_ids back', () => {
    const success = RuntimeWakeResultSchema.safeParse({
      delivered: true,
      delivery_ids: [1, 2, 3],
    });
    expect(success.success).toBe(true);

    const failure = RuntimeWakeResultSchema.safeParse({
      delivered: false,
      reason: 'startup_pending',
      delivery_ids: [1, 2, 3],
    });
    expect(failure.success).toBe(true);

    // partial-mark would be a contract violation: success without
    // delivery_ids should not parse.
    const partial = RuntimeWakeResultSchema.safeParse({ delivered: true });
    expect(partial.success).toBe(false);

    // Failure must carry a typed reason.
    const noReason = RuntimeWakeResultSchema.safeParse({
      delivered: false,
      delivery_ids: [1],
    });
    expect(noReason.success).toBe(false);
  });

  it('runtime_wake reason enum covers the §3.2.1 state-machine paths', () => {
    const reasons = [
      'not_running',
      'not_initialized',
      'startup_pending',
      'draining',
      'driver_refused',
    ] as const;
    for (const reason of reasons) {
      const r = RuntimeWakeResultSchema.safeParse({
        delivered: false,
        reason,
        delivery_ids: [1],
      });
      expect(r.success).toBe(true);
    }
  });
});

describe('protocol — runtime_* events', () => {
  it('accepts every PR-2 step-1 event arm', () => {
    const samples = [
      {
        event: 'runtime_state',
        conversation_id: 'c1',
        agent_id: 'a1',
        state: {
          runId: 'r1',
          agentId: 'a1',
          conversationId: 'c1',
          status: 'idle',
          startedAt: 1,
          updatedAt: 2,
          lastActivityAt: 2,
        },
        ts: 1,
      },
      {
        event: 'runtime_output',
        conversation_id: 'c1',
        agent_id: 'a1',
        stream: 'stdout',
        chunk: '...',
        ts: 1,
      },
      {
        event: 'runtime_exit',
        conversation_id: 'c1',
        agent_id: 'a1',
        code: 0,
        intentional: true,
        ts: 1,
      },
      {
        event: 'runtime_ready_for_drain',
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1,
      },
      {
        event: 'runtime_startup_delivery_consumed',
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1, 2],
        ts: 1,
      },
      {
        event: 'runtime_startup_delivery_failed',
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        reason: 'init_watchdog',
        ts: 1,
      },
      {
        event: 'runtime_output_dropped',
        conversation_id: 'c1',
        agent_id: 'a1',
        dropped_count: 5,
        bytes_dropped: 1024,
        since_ts: 1,
      },
      {
        event: 'runtime_output_paused',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
      {
        event: 'runtime_output_resumed',
        conversation_id: 'c1',
        agent_id: 'a1',
      },
    ];
    for (const s of samples) {
      const r = EventFrameSchema.safeParse(s);
      expect(r.success, `event ${s.event} should parse`).toBe(true);
    }
  });

  it('rejects runtime_startup_delivery_failed with unknown reason', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_startup_delivery_failed',
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      reason: 'oops',
      ts: 1,
    });
    expect(r.success).toBe(false);
  });
});
