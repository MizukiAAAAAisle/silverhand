import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RuntimeKindSchema,
  ReasoningEffortSchema,
  ReasoningEffortTokenSchema,
} from '@silverhand/shared';
import { hasDriver } from '../src/drivers/index.js';
import {
  AnyFrameSchema,
  EventFrameSchema,
  HOST_PROTOCOL_VERSION,
  KNOWN_CAPABILITIES_V1,
  MAX_FRAME_BYTES,
  RequestFrameSchema,
  ResponseFrameSchema,
  HelloResultSchema,
  RuntimeStartParamsSchema,
  RuntimeStartResultSchema,
  RuntimeDeliverParamsSchema,
  RuntimeDeliverResultSchema,
  RuntimeStopParamsSchema,
  RuntimeStopResultSchema,
  RuntimeStartErrorCodeSchema,
  encodeFrame,
  intentSchemas,
  intentErrorSchema,
  splitNdjson,
} from '../src/protocol.js';
import { testStartOptions } from './_helpers/runtime-start-options.js';

const HELLO_IDENTITY = {
  daemon_id: 'local',
  instance_id: 'test-instance',
  host_descriptor: { name: 'local', kind: 'local' as const },
};

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
      protocol_version: HOST_PROTOCOL_VERSION,
      socket_path: '/tmp/x.sock',
      daemon_pid: 1,
      daemon_version: '0.0.0',
      ...HELLO_IDENTITY,
      capabilities: [...KNOWN_CAPABILITIES_V1],
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

describe('protocol — hello handshake', () => {
  it('accepts the v1 daemon handshake shape', () => {
    expect(
      intentSchemas.hello.result.safeParse({
        protocol_version: HOST_PROTOCOL_VERSION,
        daemon_version: '0.1.0',
        ...HELLO_IDENTITY,
        capabilities: [...KNOWN_CAPABILITIES_V1],
      }).success,
    ).toBe(true);
  });

  it('allows unknown capability strings for forward compatibility', () => {
    const parsed = HelloResultSchema.safeParse({
      protocol_version: HOST_PROTOCOL_VERSION,
      daemon_version: '0.1.0',
      ...HELLO_IDENTITY,
      capabilities: ['runtime.future_thing'],
    });
    expect(parsed.success).toBe(true);
  });

  it('requires daemon identity fields in v1', () => {
    expect(
      HelloResultSchema.safeParse({
        protocol_version: HOST_PROTOCOL_VERSION,
        daemon_version: '0.1.0',
        capabilities: [...KNOWN_CAPABILITIES_V1],
      }).success,
    ).toBe(false);
  });

  it('does not advertise runtimes without a driver implementation', () => {
    expect(KNOWN_CAPABILITIES_V1).not.toContain('runtime.gemini');
  });

  it('advertises exactly the runtimes that have a driver (runtime.* ⟺ hasDriver)', () => {
    // The hello capabilities are the daemon's promise of what it can
    // spawn — so `runtime.<kind>` must be present iff a driver exists.
    // qoder/opencode shipped drivers, so they must be advertised; gemini has none.
    const advertised = new Set(
      KNOWN_CAPABILITIES_V1.filter(c => c.startsWith('runtime.')).map(c =>
        c.slice('runtime.'.length),
      ),
    );
    for (const kind of RuntimeKindSchema.options) {
      expect(advertised.has(kind)).toBe(hasDriver(kind));
    }
    expect(advertised.has('qoder')).toBe(true);
    expect(advertised.has('opencode')).toBe(true);
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
      'runtime_deliver',
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

  it('runtime_start is pure lifecycle — no startup_delivery batch (Stage 2c)', () => {
    // #task:1417 Stage 2c: `runtime_start` carries no delivery batch;
    // delivery is `runtime_deliver`-only. The strict schema rejects a
    // stray `startup_delivery`.
    const rejected = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
      startup_delivery: {
        delivery_ids: [101, 102, 103],
        text: 'hello',
      },
    });
    expect(rejected.success).toBe(false);

    const okNoDelivery = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
    });
    expect(okNoDelivery.success).toBe(true);
  });

  it('runtime_start.options is strict typed metadata and rejects unknown keys', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        unexpected: true,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('runtime_start.options rejects forbidden server-derived fs/env keys', () => {
    for (const key of [
      'cwd',
      'workspace_path',
      'home_dir',
      'system_prompt_path',
      'spawn_dir',
      'system_prompt',
      'memory_text',
      'consensus_text',
      'env',
    ]) {
      const parsed = RuntimeStartParamsSchema.safeParse({
        conversation_id: 'c1',
        agent_id: 'a1',
        options: {
          ...testStartOptions(),
          [key]: key === 'env' ? { PATH: '/usr/bin' } : '/tmp/derived',
        },
      });
      expect(parsed.success, key).toBe(false);
    }
  });

  it('runtime_start.options allows typed path metadata and launcher env_vars', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        env_policy: {
          ...testStartOptions().env_policy,
          silverhand_cli: {
            command: 'silverhand',
            args: ['--stdio'],
            env_vars: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('runtime_start.options allows omitting silverhand_cli for daemon-local launcher resolution', () => {
    const { silverhand_cli: _silverhandCli, ...envPolicy } =
      testStartOptions().env_policy;
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        env_policy: envPolicy,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('runtime_start.options rejects server_url in env_policy; daemon injects it locally', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        env_policy: {
          ...testStartOptions().env_policy,
          silverhand: {
            ...testStartOptions().env_policy.silverhand,
            server_url: 'https://server.example.test',
          },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('runtime_start rejects empty startup_delivery.delivery_ids', () => {
    // #task:1417 Stage 2c: `runtime_start` is pure lifecycle — a
    // `startup_delivery` key is rejected outright regardless of shape.
    const r = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: testStartOptions(),
      startup_delivery: { delivery_ids: [], text: 'x' },
    });
    expect(r.success).toBe(false);
  });
});

describe('protocol — runtime_start D4.e-6 semantic refs + typed errors', () => {
  it('workspace ref rejects a host-local `path` field (carve-out revoked)', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        workspace: {
          ...testStartOptions().workspace,
          path: '/host/ws/ws1',
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('agent ref rejects a host-local `home_dir` field (carve-out revoked)', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        agent: {
          ...testStartOptions().agent,
          home_dir: '/host/agents/a1',
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('workspace_memory_index entries reject a host-local `path` field', () => {
    const parsed = RuntimeStartParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      options: {
        ...testStartOptions(),
        workspace_memory_index: [
          { id: 'ws1', name: 'primary', kind: 'regular', path: '/host/ws/ws1' },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('runtime_start error taxonomy: accepts its typed codes + the generic codes, rejects a foreign typed code', () => {
    const schema = intentErrorSchema('runtime_start');
    for (const code of RuntimeStartErrorCodeSchema.options) {
      expect(schema.safeParse({ code, message: 'x' }).success, code).toBe(true);
    }
    // A generic response-error code is still admissible on this arm.
    expect(schema.safeParse({ code: 'internal_error', message: 'x' }).success).toBe(true);
    // A foreign per-command typed code (agent_materialize's) must NOT leak
    // onto runtime_start's error arm — per-command scoping (D1 round-1 P1).
    expect(schema.safeParse({ code: 'agent_dir_collision', message: 'x' }).success).toBe(false);
  });
});

// #task:1486 — the two-layer compatibility model that lets a new reasoning
// effort value ship WITHOUT bumping the wire protocol.
describe('protocol — runtime_start reasoning-effort open wire token (#task:1486)', () => {
  function startWithEffort(effort: string): unknown {
    const options = testStartOptions({ runtime: 'codex', model: 'gpt-5.6-sol' });
    options.driver.reasoning_effort = effort as never;
    return { conversation_id: 'c1', agent_id: 'a1', options };
  }

  it('accepts a currently-known extension token on the wire', () => {
    expect(RuntimeStartParamsSchema.safeParse(startWithEffort('ultra')).success).toBe(
      true,
    );
  });

  it('accepts a FUTURE token unknown to the closed product enum (no protocol bump needed)', () => {
    // The wire uses the OPEN `ReasoningEffortToken` shape, so a value the
    // current product registry never heard of still parses — adding an effort
    // is additive, never a framing change.
    const future = 'giga';
    expect(RuntimeStartParamsSchema.safeParse(startWithEffort(future)).success).toBe(
      true,
    );
    // Bidirectional proof: the CLOSED product enum (what an OLD daemon's schema
    // used on the wire) REJECTS that same token — which is exactly why the
    // `runtime.codex.reasoning.v1` capability gate must protect old daemons from
    // ever receiving a non-baseline token they cannot parse.
    expect(ReasoningEffortSchema.safeParse(future).success).toBe(false);
  });

  it('still rejects a structurally-invalid token (uppercase / spaces)', () => {
    expect(RuntimeStartParamsSchema.safeParse(startWithEffort('ULTRA')).success).toBe(
      false,
    );
    expect(RuntimeStartParamsSchema.safeParse(startWithEffort('a b')).success).toBe(
      false,
    );
  });

  it('advertises the reasoning capability in the known-capability registry', () => {
    expect(KNOWN_CAPABILITIES_V1).toContain('runtime.codex.reasoning.v1');
  });
});

// #task:1486 — adding Codex `ultra` to the wire must NOT bump the protocol. The
// open effort token carries any value; an OLD daemon's closed enum rejects
// `ultra`, so `runtime.codex.reasoning.v1` gates the send. These frozen literals
// deliberately DO NOT reference the live schema, so they model what an old
// consumer actually accepted.
describe('protocol — reasoning-effort frozen old-daemon compatibility (#task:1486)', () => {
  // The closed effort enum an old daemon's wire schema accepted before Ultra —
  // the REAL pre-Ultra set (`none/low/medium/high/xhigh/max`), copied verbatim
  // from `ReasoningEffortSchema` as it stood before `ba41e555`, NOT a narrower
  // approximation.
  const FROZEN_OLD_EFFORT_ENUM = z.enum([
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);

  it('FROZEN old effort enum REJECTS Ultra while the CURRENT wire token accepts it', () => {
    // An old daemon would reject `ultra` outright on the wire — sending it there
    // is a hard failure, so `runtime.codex.reasoning.v1` must gate the send.
    expect(FROZEN_OLD_EFFORT_ENUM.safeParse('ultra').success).toBe(false);
    // ...yet the old enum still accepts the baseline values it always knew.
    expect(FROZEN_OLD_EFFORT_ENUM.safeParse('high').success).toBe(true);
    expect(FROZEN_OLD_EFFORT_ENUM.safeParse('max').success).toBe(true);

    // The CURRENT wire carries Ultra without a protocol bump. Assert this on the
    // actual wire type: `ReasoningEffortTokenSchema` is exactly the schema
    // `RuntimeStartParamsSchema`'s nested `reasoning_effort` field delegates to
    // (protocol.ts) — the open, bounded token, NOT the closed product enum. So
    // a new daemon frames `ultra` fine while an old one (above) rejects it.
    expect(ReasoningEffortTokenSchema.safeParse('ultra').success).toBe(true);
    // A future, never-seen effort also frames on the wire (additive/ignorable).
    expect(ReasoningEffortTokenSchema.safeParse('giga').success).toBe(true);
    // The closed PRODUCT enum now includes Ultra post-#1486 (was absent pre-bump
    // — that is the value the old frozen enum lacks).
    expect(ReasoningEffortSchema.safeParse('ultra').success).toBe(true);
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
        event: 'runtime_delivery_consumed',
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1, 2],
        ts: 1,
      },
      {
        event: 'runtime_delivery_failed',
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

  it('rejects runtime_delivery_failed with unknown reason', () => {
    const r = EventFrameSchema.safeParse({
      event: 'runtime_delivery_failed',
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
      soft_directive: 'please stop',
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
      soft_directive: 'whatever',
    });
    expect(conflated.success).toBe(false);
  });

  it('soft_directive empty string fails .min(1) (Option A v2 — Cindy `wYjG20JdGjLpwq8K`)', () => {
    // Option A v2: soft_directive is now unencoded text, not stream-json
    // bytes. Empty string is a caller bug (backend always synthesizes
    // non-empty directive phrasing) — fail at schema validation, not
    // at stdin encode.
    const r = RuntimeStopParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: '',
    });
    expect(r.success).toBe(false);
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

  it('runtime_delivery_failed stays narrow — no cooldown_until field', () => {
    // Cindy's blocker: init cooldown semantics must NOT be conflated
    // with "this batch of delivery_ids was not consumed". Confirm the
    // delivery-failed event schema does not silently accept cooldown
    // fields it doesn't model.
    const r = EventFrameSchema.safeParse({
      event: 'runtime_delivery_failed',
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
    // `RequiredUnknownSchema` helper re-asserts presence while
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
  // #task:1417 Stage 2c narrowed the success arm to pure lifecycle
  // `{started, pid, started_at}` — no `phase`, no `startup_delivery_accepted`
  // (delivery custody is `runtime_deliver`-only). The shape MUST stay a
  // `started`-discriminated union so backend's RuntimeBridge can
  // `switch (res.started)` cleanly.

  it('success arm parses with exactly started:true + pid + started_at (pure lifecycle)', () => {
    const r1 = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
    });
    expect(r1.success).toBe(true);
  });

  it('success arm REJECTS the retired phase / startup_delivery_accepted fields (Stage 2c strict)', () => {
    // #task:1417 Stage 2c: `runtime_start` is pure lifecycle. The strict
    // success arm rejects the retired `phase` and `startup_delivery_accepted`
    // keys outright — they moved to `runtime_deliver`'s disposition.
    const withPhase = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
      phase: 'ready',
    });
    expect(withPhase.success).toBe(false);

    const withAccepted = RuntimeStartResultSchema.safeParse({
      started: true,
      pid: 12345,
      started_at: 1_700_000_000_000,
      startup_delivery_accepted: true,
    });
    expect(withAccepted.success).toBe(false);
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

describe('protocol — runtime_deliver contract (#task:1417 Stage 2 slice 1)', () => {
  const spawnOptions = testStartOptions();

  it('params parse with delivery_ids, kind, unencoded text, and spawn_options', () => {
    const r = RuntimeDeliverParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1, 2, 3],
      delivered_up_to_seq: 3,
      kind: 'message',
      text: 'hi',
      spawn_options: spawnOptions,
    });
    expect(r.success).toBe(true);
  });

  it('params are batch-native — delivery_ids must be non-empty', () => {
    // Absorbs the retired `runtime_wake` batch-native contract.
    const empty = RuntimeDeliverParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [],
      kind: 'message',
      text: 'hi',
      spawn_options: spawnOptions,
    });
    expect(empty.success).toBe(false);
  });

  it('params REJECT missing text and empty text (Option A v2 — daemon owns encode)', () => {
    // Absorbs the retired `runtime_wake` / `runtime_start.startup_delivery`
    // text contract (Cindy `UMGu36zoTDVuKWXi` + `wYjG20JdGjLpwq8K`):
    // delivery_ids MUST NOT reach the daemon without non-empty message
    // text — `.min(1)` rejects both missing and empty-string.
    const missing = RuntimeDeliverParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      spawn_options: spawnOptions,
    });
    expect(missing.success).toBe(false);

    const empty = RuntimeDeliverParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: '',
      spawn_options: spawnOptions,
    });
    expect(empty.success).toBe(false);

    // Any non-empty string is valid; the daemon owns interpretation.
    const ok = RuntimeDeliverParamsSchema.safeParse({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: ' ',
      spawn_options: spawnOptions,
    });
    expect(ok.success).toBe(true);
  });

  it('result: spawning / admitted arms carry pid + started_at', () => {
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'spawning',
        pid: 123,
        started_at: 1_700_000_000_000,
      }).success,
    ).toBe(true);
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'admitted',
        pid: 123,
        started_at: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it('result: refused+cooldown REQUIRES a positive cooldown_until (Cindy P1)', () => {
    // Legal cooldown arm.
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'refused',
        reason: 'cooldown',
        cooldown_until: 1_700_000_300_000,
      }).success,
    ).toBe(true);

    // Illegal #1: cooldown WITHOUT the deadline. The old flat schema with
    // an optional cooldown_until accepted this; the split arms reject it at
    // the wire layer instead of leaving a handler to explain the absence.
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'refused',
        reason: 'cooldown',
      }).success,
    ).toBe(false);

    // Non-positive cooldown_until is a contract violation.
    for (const cooldown_until of [0, -1]) {
      expect(
        RuntimeDeliverResultSchema.safeParse({
          disposition: 'refused',
          reason: 'cooldown',
          cooldown_until,
        }).success,
        `cooldown_until=${cooldown_until}`,
      ).toBe(false);
    }
  });

  it('result: refused+startup_pending / draining REJECT a leaked cooldown_until (Cindy P1)', () => {
    // Legal non-cooldown refusals — no deadline field.
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'refused',
        reason: 'startup_pending',
      }).success,
    ).toBe(true);
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'refused',
        reason: 'draining',
      }).success,
    ).toBe(true);

    // Illegal #2: cooldown_until leaking onto a non-cooldown reason. The
    // flat schema accepted this cross-reason leak; the strict per-reason
    // arms reject it.
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'refused',
        reason: 'startup_pending',
        cooldown_until: 1_700_000_300_000,
      }).success,
    ).toBe(false);
  });

  it('result: rejects `deferred` disposition (Stage 3, not defined in Stage 2)', () => {
    expect(
      RuntimeDeliverResultSchema.safeParse({
        disposition: 'deferred',
      }).success,
    ).toBe(false);
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
