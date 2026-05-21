import { describe, expect, it } from 'vitest';
import {
  AnyFrameSchema,
  EventFrameSchema,
  MAX_FRAME_BYTES,
  RequestFrameSchema,
  ResponseFrameSchema,
  RuntimeStartParamsSchema,
  RuntimeStartResultSchema,
  RuntimeStopParamsSchema,
  RuntimeStopResultSchema,
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

describe('protocol — runtime_stop step 2 shape (Cindy `vqDWkLFF6pAeIE5t`)', () => {
  it('soft mode requires soft_directive', () => {
    const ok = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: '{"role":"user","content":"please stop"}\n',
    });
    expect(ok.success).toBe(true);

    const missing = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
    });
    expect(missing.success).toBe(false);
  });

  it('hard mode rejects soft_directive (would-be misuse caught at the wire)', () => {
    const ok = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    expect(ok.success).toBe(true);

    const conflated = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
      soft_directive: '{}\n',
    });
    expect(conflated.success).toBe(false);
  });

  it('soft_directive null is a valid stream-json value', () => {
    // Mirrors StreamJsonPayloadSchema's null-allowed contract from
    // step 1; soft_directive is the same opaque-but-required payload.
    const r = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: null,
    });
    expect(r.success).toBe(true);
  });

  it('soft_directive explicit undefined fails the same as missing', () => {
    const r = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: undefined,
    });
    expect(r.success).toBe(false);
  });

  it('hard result shape: { mode:"hard", stopped, exit_code }', () => {
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'hard',
        stopped: true,
        exit_code: 137,
      }).success,
    ).toBe(true);
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'hard',
        stopped: false,
        exit_code: null,
      }).success,
    ).toBe(true);
    // Flat shape that conflated the two modes used to parse;
    // discriminated union forces the `mode` discriminator.
    expect(
      RuntimeStopResultSchema.safeParse({
        stopped: true,
        exit_code: 0,
      }).success,
    ).toBe(false);
  });

  it('soft result shape: { mode:"soft", directive_delivered, reason? }', () => {
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'soft',
        directive_delivered: true,
      }).success,
    ).toBe(true);
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'soft',
        directive_delivered: false,
        reason: 'write_failed',
      }).success,
    ).toBe(true);
    // Unknown reason rejected.
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'soft',
        directive_delivered: false,
        reason: 'oops',
      }).success,
    ).toBe(false);
    // Cross-mode field leakage rejected.
    expect(
      RuntimeStopResultSchema.safeParse({
        mode: 'soft',
        directive_delivered: true,
        exit_code: 137,
      }).success,
    ).toBe(false);
  });

  it('soft result superRefine — directive_delivered=false REQUIRES a typed reason (Cindy `eMcEhycw8fQwucis`)', () => {
    // Without the refinement a bare `optional()` would let this parse,
    // letting backend silently emit `delivered:false` with no diagnostic
    // hint — which is exactly the soft-stop misuse we tightened the
    // result shape to prevent.
    const missing = RuntimeStopResultSchema.safeParse({
      mode: 'soft',
      directive_delivered: false,
    });
    expect(missing.success).toBe(false);

    // All three reason enum values must satisfy the refinement.
    for (const reason of ['not_running', 'write_failed', 'driver_refused'] as const) {
      const ok = RuntimeStopResultSchema.safeParse({
        mode: 'soft',
        directive_delivered: false,
        reason,
      });
      expect(ok.success, `reason ${reason}`).toBe(true);
    }
  });

  it('soft result superRefine — directive_delivered=true FORBIDS a reason (Cindy `eMcEhycw8fQwucis`)', () => {
    // Pairing the success flag with a failure reason is incoherent —
    // backend would have to decide which one to trust. The refinement
    // makes that combination unrepresentable on the wire.
    const conflicted = RuntimeStopResultSchema.safeParse({
      mode: 'soft',
      directive_delivered: true,
      reason: 'write_failed',
    });
    expect(conflicted.success).toBe(false);
  });
});

describe('protocol — runtime_init lifecycle events (Cindy `vqDWkLFF6pAeIE5t`)', () => {
  // Init lifecycle is daemon-internal but surfaced to backend so it
  // can drive `agent_status` SSE + DB projection. Three discrete
  // events cover timeout → retrying → cooldown.
  it('runtime_init_timeout accepts all three watchdog tiers', () => {
    for (const reason of ['silence', 'pre_protocol_cap', 'post_protocol'] as const) {
      const r = EventFrameSchema.safeParse({
        event: 'runtime_init_timeout',
        conversation_id: 'c1',
        agent_id: 'a1',
        timeout_reason: reason,
        elapsed_ms: 1234,
        timeout_ms: 5000,
        retrying: true,
        retry_attempt: 0,
        max_retries: 3,
        ts: 1,
      });
      expect(r.success, `tier ${reason}`).toBe(true);
    }
  });

  it('runtime_init_timeout rejects unknown timeout_reason', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'random_tier',
      elapsed_ms: 0,
      timeout_ms: 0,
      retrying: false,
      retry_attempt: 0,
      max_retries: 0,
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it('runtime_init_timeout payload mirrors CM agent_init_timeout projection (Cindy 4CJATqU0DdbsGVXW)', () => {
    // The shape is intentionally aligned 1:1 with the current
    // backend SSE payload so backend can pass values straight through
    // without translation: timeout_reason name + elapsed_ms +
    // timeout_ms + retrying are all required.
    const fields = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'pre_protocol_cap',
      elapsed_ms: 4_000,
      timeout_ms: 5_000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 3,
      ts: 1,
    });
    expect(fields.success).toBe(true);

    // The old shorter shape (no elapsed_ms / timeout_ms / retrying)
    // must NOT parse — backend depends on those values being on the
    // same event rather than reconstructed.
    const tooNarrow = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'pre_protocol_cap',
      retry_attempt: 0,
      max_retries: 3,
      ts: 1,
    });
    expect(tooNarrow.success).toBe(false);

    // The pre-fix legacy reason name must be rejected — Step 2 would
    // otherwise silently downgrade CM's existing SSE payload.
    const legacyName = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'pre_protocol',
      elapsed_ms: 4_000,
      timeout_ms: 5_000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 3,
      ts: 1,
    });
    expect(legacyName.success).toBe(false);
  });

  it('runtime_init_timeout cooldown_until is optional and rides the timeout event when cooldown engages', () => {
    // CM publishes the cooldown_until on the same agent_init_timeout
    // payload when the final attempt fails — keeping the field optional
    // on this event lets backend project the terminal state in one hop
    // (Cindy `4CJATqU0DdbsGVXW`: 'cooldown 路径上的可选 cooldown_until').
    const withCooldown = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 2_000,
      timeout_ms: 1_000,
      retrying: false,
      retry_attempt: 2,
      max_retries: 3,
      cooldown_until: 1_700_000_000_000,
      ts: 1,
    });
    expect(withCooldown.success).toBe(true);

    const withoutCooldown = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 2_000,
      timeout_ms: 1_000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 3,
      ts: 1,
    });
    expect(withoutCooldown.success).toBe(true);

    // Non-positive cooldown_until is a contract violation — it must be
    // a future wall-clock epoch ms.
    const zero = EventFrameSchema.safeParse({
      event: 'runtime_init_timeout',
      conversation_id: 'c1',
      agent_id: 'a1',
      timeout_reason: 'silence',
      elapsed_ms: 0,
      timeout_ms: 0,
      retrying: false,
      retry_attempt: 0,
      max_retries: 0,
      cooldown_until: 0,
      ts: 1,
    });
    expect(zero.success).toBe(false);
  });

  it('runtime_init_retrying carries the next attempt + delay', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_init_retrying',
      conversation_id: 'c1',
      agent_id: 'a1',
      retry_attempt: 2,
      max_retries: 3,
      delay_ms: 500,
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it('runtime_init_cooldown carries cooldown_until + exhausted count', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_init_cooldown',
      conversation_id: 'c1',
      agent_id: 'a1',
      cooldown_until: 1_700_000_000_000,
      attempts_exhausted: 3,
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it('runtime_startup_delivery_failed stays narrow — no cooldown_until field', () => {
    // Cindy's blocker: init cooldown semantics must NOT be conflated
    // with "this batch of delivery_ids was not consumed". Confirm the
    // delivery-failed event schema does not silently accept cooldown
    // fields it doesn't model.
    const r = EventFrameSchema.safeParse({
      event: 'runtime_startup_delivery_failed',
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      reason: 'init_watchdog',
      cooldown_until: 1_700_000_000_000,
      ts: 1,
    });
    // strict() object on the event arm should reject the unknown key.
    expect(r.success).toBe(false);
  });
});

describe('protocol — runtime_parsed_event (Cindy `OQCA05pivtB8nSTC` + `C2BZGDbQWfnq-bKJ`)', () => {
  it('accepts every ParsedEvent kind on the wire (round-trip parse)', () => {
    const samples: unknown[] = [
      { kind: 'session_init', sessionId: 'sess-1' },
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'hello' },
      {
        kind: 'tool_call',
        name: 'Bash',
        input: { command: 'ls' },
        toolCallId: 'tc-1',
      },
      { kind: 'tool_output', name: 'Bash', toolCallId: 'tc-1' },
      { kind: 'turn_end', sessionId: 'sess-1' },
      { kind: 'compaction_started' },
      { kind: 'compaction_finished' },
      { kind: 'error', message: 'boom', code: 'E_THING', fatal: true },
      { kind: 'unknown', raw: 'mystery line' },
    ];
    for (const parsed of samples) {
      const r = EventFrameSchema.safeParse({
        event: 'runtime_parsed_event',
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed,
        ts: 1,
      });
      expect(r.success).toBe(true);
    }
  });

  it('rejects extra top-level fields (no raw_line allowed — raw bytes live on runtime_output)', () => {
    // Cindy: parsed_event must NOT duplicate the raw byte stream.
    // `runtime_output` already carries every chunk; adding raw_line
    // here would double the wire cost without any new information.
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'text', text: 'hi' },
      raw_line: '{"type":"text","text":"hi"}',
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown ParsedEvent kind discriminator', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'absurd_new_kind', text: 'nope' },
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it('tool_call.input is REQUIRED — missing or explicit undefined both fail (Cindy `YW2BGWryWjfymPkU` B1)', () => {
    // A bare `z.unknown()` at an object property would let zod treat
    // `input` as optional — `{kind:'tool_call', name:'Bash'}` would
    // parse with `input === undefined`, silently downgrading the TS
    // contract that marks the field required. The
    // `RequiredUnknownSchema` helper (same trick as
    // `StreamJsonPayloadSchema.payload`) re-asserts presence while
    // keeping the value's shape opaque.
    const missing = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash' },
      ts: 1,
    });
    expect(missing.success).toBe(false);

    const explicitUndef = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash', input: undefined },
      ts: 1,
    });
    expect(explicitUndef.success).toBe(false);

    // null is a valid opaque payload — drivers may legitimately emit
    // a null input (e.g. nullary tool); only undefined/missing is
    // forbidden.
    const nullInput = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash', input: null },
      ts: 1,
    });
    expect(nullInput.success).toBe(true);

    // Empty object input is the common shape — must parse.
    const emptyObj = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: { kind: 'tool_call', name: 'Bash', input: {} },
      ts: 1,
    });
    expect(emptyObj.success).toBe(true);
  });

  it('ParsedEvent arms are strict — rejects extra payload fields on a recognized kind', () => {
    // Defends backend against drivers sneaking in undocumented fields.
    // If a new field is ever needed, the schema must be widened
    // explicitly so both daemon and backend agree on its meaning.
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed: {
        kind: 'tool_call',
        name: 'Bash',
        input: {},
        toolCallId: 'tc-1',
        // unsanctioned field — strict() should bite.
        secretAuthToken: 'shhh',
      },
      ts: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('protocol — runtime_parsed_event_dropped (metadata-only, Cindy `C2BZGDbQWfnq-bKJ`)', () => {
  it('accepts the minimal metadata-only shape', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'tool_call',
      encoded_bytes: 2_000_000,
      reason: 'frame_too_large',
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it('rejects any payload-bearing field (no raw, no input, no text, no parsed)', () => {
    // Cindy's hard rule: dropped event must NEVER carry a partial
    // payload. The whole point of dropping is that we cannot honestly
    // ship the parsed event — leaking even one field would let
    // backend mistake the frame for a complete event.
    const forbidden = [
      { raw: 'the original line' },
      { parsed: { kind: 'unknown', raw: 'the original line' } },
      { input: { command: 'ls' } },
      { text: 'hi' },
      { name: 'Bash' },
      { toolCallId: 'tc-1' },
      { partial_payload: 'anything' },
    ];
    for (const extra of forbidden) {
      const r = EventFrameSchema.safeParse({
        event: 'runtime_parsed_event_dropped',
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed_kind: 'unknown',
        encoded_bytes: 2_000_000,
        reason: 'frame_too_large',
        ts: 1,
        ...extra,
      });
      expect(r.success).toBe(false);
    }
  });

  it('rejects unknown parsed_kind', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'made_up',
      encoded_bytes: 2_000_000,
      reason: 'frame_too_large',
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown reason (single-arm enum: only frame_too_large in 3b)', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'text',
      encoded_bytes: 2_000_000,
      reason: 'rate_limit',
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative encoded_bytes', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_parsed_event_dropped',
      conversation_id: 'c1',
      agent_id: 'a1',
      parsed_kind: 'text',
      encoded_bytes: -1,
      reason: 'frame_too_large',
      ts: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('protocol — runtime_start result discriminated union (Cindy `-pdNvRYOWip5e9yA` 3c plan)', () => {
  // Pre-3c the result was a flat `{pid, started_at, startup_delivery_accepted?}`.
  // 3c added a cooldown-blocked arm so backend can project init cooldown
  // to UI as a business state instead of swallowing it as `internal_error`.
  // The shape MUST be a `started`-discriminated union so backend's
  // RuntimeBridge can `switch (res.started)` cleanly.

  it('success arm parses with started:true + pid + started_at + optional startup_delivery_accepted', () => {
    const r1 = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
    });
    expect(r1.success).toBe(true);

    const r2 = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
      startup_delivery_accepted: true,
    });
    expect(r2.success).toBe(true);

    const r3 = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
      startup_delivery_accepted: false,
    });
    expect(r3.success).toBe(true);
  });

  it('cooldown arm parses with started:false + reason:init_cooldown + positive cooldown_until', () => {
    const r = RuntimeStartResultSchema.safeParse({
      started: false,
      reason: 'init_cooldown',
      cooldown_until: 1_700_000_300_000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing started discriminator (no flat shape allowed)', () => {
    // The pre-3c flat shape would have parsed against a plain object
    // schema; the discriminated union forces every caller to provide
    // the discriminator.
    const flat = RuntimeStartResultSchema.safeParse({
      pid: 12345,
      started_at: 1_700_000_000_000,
    });
    expect(flat.success).toBe(false);
  });

  it('rejects cross-arm field leakage (started:true + cooldown_until, started:false + pid)', () => {
    // `.strict()` on each arm prevents backend from ever seeing a
    // half-success/half-failure shape where ambiguous fields could
    // be interpreted either way.
    const successWithCooldown = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 1,
      started_at: 1,
      cooldown_until: 1_700_000_300_000,
    });
    expect(successWithCooldown.success).toBe(false);

    const failureWithPid = RuntimeStartResultSchema.safeParse({
      started: false,
      reason: 'init_cooldown',
      cooldown_until: 1_700_000_300_000,
      pid: 1,
    });
    expect(failureWithPid.success).toBe(false);
  });

  it('cooldown arm rejects non-positive cooldown_until', () => {
    // Wall-clock epoch ms must be in the future (or at minimum
    // positive) — a zero or negative value would let backend project
    // cooldown_until=0 and immediately treat the gate as cleared.
    for (const cooldown_until of [0, -1, -1_700_000_000]) {
      const r = RuntimeStartResultSchema.safeParse({
        started: false,
        reason: 'init_cooldown',
        cooldown_until,
      });
      expect(r.success, `cooldown_until=${cooldown_until}`).toBe(false);
    }
  });

  it('cooldown arm rejects unknown reason (single-arm enum reserved for init_cooldown in 3c)', () => {
    const r = RuntimeStartResultSchema.safeParse({
      started: false,
      reason: 'binary_missing',
      cooldown_until: 1_700_000_300_000,
    });
    expect(r.success).toBe(false);
  });
});

describe('protocol — runtime_compaction_stale event (Cindy `-pdNvRYOWip5e9yA` 3c plan)', () => {
  // CM's compaction watchdog fires once at 5 min without observing
  // `compaction_finished`. The daemon publishes this observational
  // event but does NOT kill the child or change phase — backend
  // maps it onto the existing `compaction_stale` SSE projection.

  it('accepts the minimal shape', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_compaction_stale',
      conversation_id: 'c1',
      agent_id: 'a1',
      elapsed_ms: 300_000,
      ts: 1_700_000_300_000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects extra fields (strict — no payload bleed for "kill_reason" / "phase_change")', () => {
    // This event is intentionally observational. If a future variant
    // ever needs to kill or transition state, it must be a NEW event
    // arm so the bilateral parser sees it. The strict() guards drift
    // from a one-line PR sneaking in a side-effect field.
    const r = EventFrameSchema.safeParse({
      event: 'runtime_compaction_stale',
      conversation_id: 'c1',
      agent_id: 'a1',
      elapsed_ms: 300_000,
      ts: 1_700_000_300_000,
      kill_reason: 'compaction_stale',
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative elapsed_ms (must be ≥0)', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_compaction_stale',
      conversation_id: 'c1',
      agent_id: 'a1',
      elapsed_ms: -1,
      ts: 1_700_000_300_000,
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing conversation_id / agent_id', () => {
    const noConv = EventFrameSchema.safeParse({
      event: 'runtime_compaction_stale',
      agent_id: 'a1',
      elapsed_ms: 0,
      ts: 1,
    });
    expect(noConv.success).toBe(false);

    const noAgent = EventFrameSchema.safeParse({
      event: 'runtime_compaction_stale',
      conversation_id: 'c1',
      elapsed_ms: 0,
      ts: 1,
    });
    expect(noAgent.success).toBe(false);
  });
});
