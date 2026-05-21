/**
 * Wire protocol between `silverhand-daemon` (process boundary) and
 * `HostClient` (callers inside `backend` / `electron main`).
 *
 * Why this is its own module (and not buried inside `client` or
 * `daemon`): the wire format is the contract. Two sides of an IPC
 * cannot share TypeScript types but a different parser — the only way
 * to keep them honest is to make the schema the single source of truth
 * that both sides import. This file MUST stay free of node:net /
 * node:child_process / fs imports so it can be unit-tested as a pure
 * encode/decode.
 *
 * ## Framing
 *
 * Newline-delimited JSON over a duplex byte stream. One JSON object
 * per `\n`-terminated chunk. Both sides decode by buffering bytes,
 * splitting on `\n`, and JSON.parse'ing each frame. We do NOT use
 * length-prefixed framing because (a) the message sizes for PR-1's
 * intent surface are < 1KB each and (b) NDJSON gives us trivial
 * tail-of-log debuggability.
 *
 * ## Three frame shapes
 *
 * - **Request** (`client → daemon`): correlation id + intent name + params.
 * - **Response** (`daemon → client`): same correlation id + result OR
 *   typed error.
 * - **Event** (`daemon → client`, unsolicited): no correlation id;
 *   discriminated by `event` field. PR-1 only emits `ready` (on
 *   socket bind) and `shutting_down` (on SIGTERM/SIGINT). Future
 *   PRs add `runtime_state` events here.
 *
 * Request ids are correlation handles, not security tokens — generated
 * by the client side via `randomBytes`. The daemon echoes them back on
 * the matching response so multiple in-flight requests on one socket
 * can be demultiplexed.
 */
import { z } from 'zod';
import {
  AgentRunStateSchema,
  ParsedEventKindSchema,
  ParsedEventSchema,
} from '@silverhand/shared';

// ── Intent registry ─────────────────────────────────────────────────
//
// PR-1 intent surface is intentionally tiny: just enough to prove the
// IPC carries structured payloads, plumbs lifecycle, and supports
// reconnect. PR-2 expands this with the runtime_* family that the
// design lock at `docs/silverhand-daemon-pr2-design.md` describes.
//
// PR-2 step 1 lands the wire schemas here PLUS a daemon-internal fake
// supervisor that satisfies the contract without doing any real
// process spawn. Step 2 wires the supervisor to the real
// ConversationManager execution-plane code carved out of
// `packages/backend/src/conversation-manager.ts`. Both steps share
// THIS file as the single source of truth — drift between client and
// daemon is impossible because both import from one registry.
//
// Naming convention: every PR-2 intent / event prefixes with
// `runtime_` so they are visually distinct from PR-1's
// ping / status / echo lifecycle intents. The split is deliberate:
// runtime_* talk to a (conversation, agent) supervised process;
// PR-1 lifecycle intents talk to the daemon as a whole.

export const PingParamsSchema = z.object({}).strict();
export type PingParams = z.infer<typeof PingParamsSchema>;

export const PingResultSchema = z.object({
  pong: z.literal(true),
  daemon_pid: z.number().int(),
  daemon_version: z.string(),
  /** Epoch ms when the daemon process bound its socket. */
  started_at: z.number().int(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

export const StatusParamsSchema = z.object({}).strict();
export type StatusParams = z.infer<typeof StatusParamsSchema>;

export const StatusResultSchema = z.object({
  daemon_pid: z.number().int(),
  daemon_version: z.string(),
  started_at: z.number().int(),
  uptime_ms: z.number().int(),
  /** Number of intents the daemon has handled this lifetime. Useful
   *  for asserting reconnect tests actually re-issued requests. */
  intent_count: z.number().int(),
  /** Reserved for PR-2: list of currently-tracked (conversation,
   *  agent) runtime intents. Empty in PR-1. */
  runtimes: z.array(z.unknown()),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const EchoParamsSchema = z
  .object({
    message: z.string(),
  })
  .strict();
export type EchoParams = z.infer<typeof EchoParamsSchema>;

export const EchoResultSchema = z
  .object({
    echoed: z.string(),
  })
  .strict();
export type EchoResult = z.infer<typeof EchoResultSchema>;

// ── PR-2 runtime_* surface ──────────────────────────────────────────
//
// Wire surface for the (conversation, agent) supervisor that the
// daemon owns. The shapes below match the design lock in
// `docs/silverhand-daemon-pr2-design.md` §3 verbatim. Anything that
// looks "runtime_*" goes through one (conversation_id, agent_id) pair
// — the daemon serializes operations on that key with the same
// per-pair lifecycle lock CM uses today.

/**
 * StreamJsonPayload — the hydrated stream-json frame the BACKEND
 * builds before handing it off via `runtime_wake` /
 * `runtime_start.startup_delivery`. It's the same shape CM today
 * formats inbox rows into and writes to claude-family stdin.
 *
 * PR-2 step 1: shape held opaque on the wire because the daemon never
 * inspects it — it just buffers + writes to stdin per driver
 * semantics. Step 2 will type the hydration site inside backend
 * separately; the daemon's contract stays "I write whatever bytes you
 * give me on this field".
 *
 * Required-but-opaque (review fix per Cindy `ihw5XHpjldmEc-wt`): a
 * bare `z.unknown()` lets the field be omitted entirely (zod treats
 * `unknown` at object properties as optional), which violated the
 * step-0 contract — `delivery_ids` MUST NOT reach the daemon without
 * an accompanying stdin payload. The refinement rejects an absent or
 * `undefined` value while still leaving the value's *shape* opaque
 * (step 2 will tighten that, per Cindy `_YD0KJF-YAQXlcki`).
 */
export const StreamJsonPayloadSchema = z.unknown().refine(
  v => v !== undefined,
  { message: 'payload is required (stream-json bytes must be present)' },
);
export type StreamJsonPayload = z.infer<typeof StreamJsonPayloadSchema>;

/**
 * StartOptions — placeholder. Step 1 keeps this loose because the
 * fake supervisor doesn't care about the contents. Step 2 will lift
 * the full shape verbatim out of CM (mock CLI override, init retry
 * tier config, driver kind, etc.) and replace this with a strict
 * schema. The wire is forward-compatible: step 2 narrows the schema,
 * doesn't add new top-level fields.
 */
export const StartOptionsSchema = z.object({}).passthrough();
export type StartOptions = z.infer<typeof StartOptionsSchema>;

/** A single (conversation, agent) supervised runtime as the daemon
 *  reports it via `runtime_status`. Mirrors the run-state DTO that
 *  backend already publishes to renderers. */
export const RuntimeStateDtoSchema = z.object({
  conversation_id: z.string().min(1),
  agent_id: z.string().min(1),
  pid: z.number().int().nullable(),
  /** Daemon's view of where this runtime is in its lifecycle. The
   *  enum mirrors the §3.2.1 startup/live exclusivity state machine
   *  so the operator can read intent vs implementation off one
   *  field. */
  phase: z.enum([
    'idle',
    'spawning',
    'startup_pending',
    'ready',
    'draining',
    'exited',
  ]),
  /** Last known AgentRunState; null until the driver emits its first
   *  run-state transition. */
  run_state: AgentRunStateSchema.nullable(),
  started_at: z.number().int().nullable(),
});
export type RuntimeStateDto = z.infer<typeof RuntimeStateDtoSchema>;

// ── runtime_start ───────────────────────────────────────────────────

export const RuntimeStartParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    options: StartOptionsSchema,
    /** Optional spawn-time inbox drain, replacing CM's drainInbox().
     *  Daemon attempts the write per driver-specific semantics; ack
     *  is async via runtime_startup_delivery_consumed | _failed
     *  events. See design doc §3.1 + §3.2.1. */
    startup_delivery: z
      .object({
        delivery_ids: z.array(z.number().int()).min(1),
        payload: StreamJsonPayloadSchema,
      })
      .optional(),
  })
  .strict();
export type RuntimeStartParams = z.infer<typeof RuntimeStartParamsSchema>;

export const RuntimeStartResultSchema = z
  .object({
    pid: z.number().int(),
    started_at: z.number().int(),
    /** True iff daemon accepted the startup_delivery payload for
     *  attempt. NOT a "consumed" signal — that's the async
     *  runtime_startup_delivery_consumed event. Absent when
     *  `startup_delivery` was not provided in params. */
    startup_delivery_accepted: z.boolean().optional(),
  })
  .strict();
export type RuntimeStartResult = z.infer<typeof RuntimeStartResultSchema>;

// ── runtime_stop ────────────────────────────────────────────────────

/**
 * Stop a (conv, agent) runtime. Two modes with distinct semantics
 * (locked by Cindy `vqDWkLFF6pAeIE5t` step 2 plan reply):
 *
 *  - **`hard`** — SIGTERM 5s → SIGKILL cascade. Result reports the
 *    process termination outcome via `{ stopped, exit_code }`.
 *  - **`soft`** — inject a directive user message into stdin (e.g.
 *    "[the user wants you to stop]") and let the agent wrap up.
 *    Backend MUST supply the directive in `soft_directive`. Result
 *    reports the write outcome via `{ directive_delivered, reason? }`.
 *    The runtime is NOT terminated by a soft stop; the agent's next
 *    `turn_end` or `runtime_exit` is what backend should react to.
 *
 * Why the result is a discriminated union rather than a flat object:
 * conflating "process stopped" with "directive written" lets backend
 * misinterpret a soft `write_failed` as "agent is now stopped" and
 * flip DB / SSE state incorrectly. Splitting on `mode` makes that
 * misuse a compile-time error.
 */
export const RuntimeStopParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    mode: z.enum(['soft', 'hard']),
    /** Stream-json line backend wants daemon to inject as a directive
     *  user message. ONLY allowed when `mode === 'soft'`. Backend is
     *  responsible for materialising the default phrasing — daemon
     *  treats it as opaque bytes (per the Step 1 payload contract). */
    soft_directive: StreamJsonPayloadSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'hard' && val.soft_directive !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['soft_directive'],
        message:
          "soft_directive is only valid when mode === 'soft'; hard mode kills the process and ignores stdin.",
      });
    }
    if (val.mode === 'soft' && val.soft_directive === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['soft_directive'],
        message:
          "soft_directive is required when mode === 'soft'; backend MUST supply the directive bytes (default phrasing is backend's responsibility).",
      });
    }
  });
export type RuntimeStopParams = z.infer<typeof RuntimeStopParamsSchema>;

export const RuntimeStopResultSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('hard'),
        /** Whether the runtime was actually live and got the signal.
         *  False = nothing to stop (already exited / never started). */
        stopped: z.boolean(),
        /** Final exit code if known at response time. SIGTERM cascade
         *  may not have completed; daemon may report `null` and let the
         *  `runtime_exit` event carry the real value. */
        exit_code: z.number().int().nullable(),
      })
      .strict(),
    z
      .object({
        mode: z.literal('soft'),
        /** Whether the directive line was written to the child's stdin.
         *  False = runtime not running, write failed, or driver refused.
         *  IMPORTANT: directive_delivered === false does NOT mean the
         *  runtime is stopped — backend must NOT flip DB / SSE state
         *  to a stopped status on a soft failure. */
        directive_delivered: z.boolean(),
        /** Why the directive wasn't delivered. REQUIRED when
         *  directive_delivered === false; FORBIDDEN when
         *  directive_delivered === true. The pairing is enforced by
         *  the .superRefine() below (Cindy `eMcEhycw8fQwucis`) — a
         *  bare `optional()` would let backend silently emit either
         *  `{delivered:false}` (no reason) or
         *  `{delivered:true, reason:'write_failed'}`, both of which
         *  defeat the whole point of the discriminated soft result. */
        reason: z
          .enum(['not_running', 'write_failed', 'driver_refused'])
          .optional(),
      })
      .strict(),
  ])
  .superRefine((val, ctx) => {
    if (val.mode !== 'soft') return;
    if (val.directive_delivered === false && val.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          "soft result with directive_delivered=false must carry a typed reason ('not_running' | 'write_failed' | 'driver_refused')",
      });
    }
    if (val.directive_delivered === true && val.reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          'soft result with directive_delivered=true must not carry a reason',
      });
    }
  });
export type RuntimeStopResult = z.infer<typeof RuntimeStopResultSchema>;

// ── runtime_wake ────────────────────────────────────────────────────

/**
 * Live-delivery primitive. BATCH-NATIVE — single-row delivery is
 * `delivery_ids: [id]`. Backend owns the inbox; daemon never reads
 * or writes inbox rows. See design doc §3.1.
 *
 * Result is all-or-nothing: success returns the same `delivery_ids`
 * caller passed in (so the response carries enough context to
 * `markDelivered` even if the request was retried over a reconnect).
 * Failure carries a typed `reason` and the same `delivery_ids` so
 * the caller keeps every row pending — no partial mark.
 */
export const RuntimeWakeParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    kind: z.enum(['message', 'schedule_fire']),
    payload: StreamJsonPayloadSchema,
  })
  .strict();
export type RuntimeWakeParams = z.infer<typeof RuntimeWakeParamsSchema>;

export const RuntimeWakeReasonSchema = z.enum([
  'not_running',
  'not_initialized',
  'startup_pending',
  'draining',
  'driver_refused',
]);
export type RuntimeWakeReason = z.infer<typeof RuntimeWakeReasonSchema>;

export const RuntimeWakeResultSchema = z.union([
  z
    .object({
      delivered: z.literal(true),
      delivery_ids: z.array(z.number().int()).min(1),
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      reason: RuntimeWakeReasonSchema,
      delivery_ids: z.array(z.number().int()).min(1),
    })
    .strict(),
]);
export type RuntimeWakeResult = z.infer<typeof RuntimeWakeResultSchema>;

// ── runtime_status ──────────────────────────────────────────────────

export const RuntimeStatusParamsSchema = z
  .object({
    conversation_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeStatusParams = z.infer<typeof RuntimeStatusParamsSchema>;

export const RuntimeStatusResultSchema = z
  .object({
    runtimes: z.array(RuntimeStateDtoSchema),
  })
  .strict();
export type RuntimeStatusResult = z.infer<typeof RuntimeStatusResultSchema>;

// ── runtime_clear_session ───────────────────────────────────────────

export const RuntimeClearSessionParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();
export type RuntimeClearSessionParams = z.infer<
  typeof RuntimeClearSessionParamsSchema
>;

export const RuntimeClearSessionResultSchema = z
  .object({ cleared: z.boolean() })
  .strict();
export type RuntimeClearSessionResult = z.infer<
  typeof RuntimeClearSessionResultSchema
>;

// ── runtime_stop_all / runtime_close_activity_log ───────────────────

export const RuntimeStopAllParamsSchema = z.object({}).strict();
export type RuntimeStopAllParams = z.infer<typeof RuntimeStopAllParamsSchema>;

export const RuntimeStopAllResultSchema = z
  .object({ stopped_count: z.number().int().nonnegative() })
  .strict();
export type RuntimeStopAllResult = z.infer<typeof RuntimeStopAllResultSchema>;

export const RuntimeCloseActivityLogParamsSchema = z.object({}).strict();
export type RuntimeCloseActivityLogParams = z.infer<
  typeof RuntimeCloseActivityLogParamsSchema
>;

export const RuntimeCloseActivityLogResultSchema = z
  .object({ flushed: z.boolean() })
  .strict();
export type RuntimeCloseActivityLogResult = z.infer<
  typeof RuntimeCloseActivityLogResultSchema
>;

// ── output flow control (intents bodies present, v0 unused) ─────────

export const RuntimeOutputPauseParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();
export type RuntimeOutputPauseParams = z.infer<
  typeof RuntimeOutputPauseParamsSchema
>;

export const RuntimeOutputPauseResultSchema = z
  .object({ paused: z.boolean() })
  .strict();
export type RuntimeOutputPauseResult = z.infer<
  typeof RuntimeOutputPauseResultSchema
>;

export const RuntimeOutputResumeParamsSchema = RuntimeOutputPauseParamsSchema;
export type RuntimeOutputResumeParams = RuntimeOutputPauseParams;

export const RuntimeOutputResumeResultSchema = z
  .object({ resumed: z.boolean() })
  .strict();
export type RuntimeOutputResumeResult = z.infer<
  typeof RuntimeOutputResumeResultSchema
>;


/**
 * Single source of truth for the intent ↔ params/result type pairing.
 * The client uses it to enforce that `host.call('echo', {...})` only
 * accepts echo-shaped params and returns echo-shaped results; the
 * daemon dispatcher uses it to parse incoming params before handing
 * to a handler.
 */
export const intentSchemas = {
  ping: {
    params: PingParamsSchema,
    result: PingResultSchema,
  },
  status: {
    params: StatusParamsSchema,
    result: StatusResultSchema,
  },
  echo: {
    params: EchoParamsSchema,
    result: EchoResultSchema,
  },
  runtime_start: {
    params: RuntimeStartParamsSchema,
    result: RuntimeStartResultSchema,
  },
  runtime_stop: {
    params: RuntimeStopParamsSchema,
    result: RuntimeStopResultSchema,
  },
  runtime_wake: {
    params: RuntimeWakeParamsSchema,
    result: RuntimeWakeResultSchema,
  },
  runtime_status: {
    params: RuntimeStatusParamsSchema,
    result: RuntimeStatusResultSchema,
  },
  runtime_clear_session: {
    params: RuntimeClearSessionParamsSchema,
    result: RuntimeClearSessionResultSchema,
  },
  runtime_stop_all: {
    params: RuntimeStopAllParamsSchema,
    result: RuntimeStopAllResultSchema,
  },
  runtime_close_activity_log: {
    params: RuntimeCloseActivityLogParamsSchema,
    result: RuntimeCloseActivityLogResultSchema,
  },
  runtime_output_pause: {
    params: RuntimeOutputPauseParamsSchema,
    result: RuntimeOutputPauseResultSchema,
  },
  runtime_output_resume: {
    params: RuntimeOutputResumeParamsSchema,
    result: RuntimeOutputResumeResultSchema,
  },
} as const;

export type IntentName = keyof typeof intentSchemas;
export type IntentParams<N extends IntentName> = z.infer<
  (typeof intentSchemas)[N]['params']
>;
export type IntentResult<N extends IntentName> = z.infer<
  (typeof intentSchemas)[N]['result']
>;

// ── Frame schemas ───────────────────────────────────────────────────

export const RequestFrameSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  params: z.unknown(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

/**
 * Typed error codes the daemon may return in a response frame. Kept
 * small and stable so the client can branch on them without scanning
 * `message` strings:
 *
 *  - `unknown_intent`     — `intent` name not in the registry
 *  - `invalid_params`     — params failed zod validation
 *  - `internal_error`     — handler threw / returned an unexpected error
 *  - `shutting_down`      — request arrived after SIGTERM/SIGINT
 *  - `request_too_large`  — incoming frame exceeded the per-frame cap
 */
export const ResponseErrorSchema = z.object({
  code: z.enum([
    'unknown_intent',
    'invalid_params',
    'internal_error',
    'shutting_down',
    'request_too_large',
  ]),
  message: z.string(),
});
export type ResponseError = z.infer<typeof ResponseErrorSchema>;

export const ResponseFrameSchema = z.union([
  z
    .object({
      id: z.string().min(1),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      error: ResponseErrorSchema,
    })
    .strict(),
]);
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;

/**
 * Unsolicited events. Two categories:
 *
 *  - **droppable** = `runtime_output` only. Subject to the
 *    per-(conv,agent) 4 MiB un-flushed buffer cap (§2.2.2 of design
 *    lock). Daemon may emit `runtime_output_dropped` when bytes are
 *    discarded — that ack itself is non-droppable.
 *  - **non-droppable** = everything else. Daemon must never sacrifice
 *    one of these to relieve backpressure.
 *
 *  PR-1 surface kept verbatim:
 *
 *  - `ready`         — daemon socket is bound; handshake signal mirrored
 *                      to stdout for the spawn helper.
 *  - `shutting_down` — daemon received SIGTERM/SIGINT and is draining.
 *
 *  PR-2 step 1 surface (matches design doc §3.2):
 *
 *  - `runtime_state` / `runtime_output` / `runtime_exit` / `runtime_ready_for_drain`
 *  - `runtime_startup_delivery_consumed` / `runtime_startup_delivery_failed`
 *  - `runtime_output_dropped` / `runtime_output_paused` / `runtime_output_resumed`
 *
 *  PR-2 step 2 surface (Cindy `vqDWkLFF6pAeIE5t`):
 *
 *  - `runtime_init_timeout` / `runtime_init_retrying` / `runtime_init_cooldown`
 *    — daemon-internal init-watchdog / retry / cooldown loop exposed
 *    to backend so backend can drive UI (`agent_status` SSE) + DB
 *    projection without owning the retry state machine.
 *
 *  PR-2 step 2 commit 3b (Cindy `OQCA05pivtB8nSTC` + `C2BZGDbQWfnq-bKJ`):
 *
 *  - `runtime_parsed_event` — non-droppable structured sidecar of
 *    `runtime_output`. Each line the driver's `parseLine` recognizes
 *    becomes one of these frames. Raw bytes still go on
 *    `runtime_output` unchanged; this is additive, not a replacement.
 *  - `runtime_parsed_event_dropped` — non-droppable metadata-only
 *    frame the daemon emits when a parsed event's encoded form
 *    exceeds `MAX_FRAME_BYTES`. Carries `parsed_kind` + `encoded_bytes`
 *    + `reason:'frame_too_large'` ONLY; explicitly NO payload (no
 *    raw line, no tool input, no text) so we never half-leak a
 *    truncated event onto the wire.
 */
export const EventFrameSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('ready'),
    socket_path: z.string(),
    daemon_pid: z.number().int(),
    daemon_version: z.string(),
    started_at: z.number().int(),
  }),
  z.object({
    event: z.literal('shutting_down'),
    reason: z.string(),
  }),
  // ── runtime_* events ────────────────────────────────────────────
  z.object({
    event: z.literal('runtime_state'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    state: AgentRunStateSchema,
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_output'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    /** Raw bytes from the child process, base64-free utf-8 string.
     *  This is the ONLY droppable field on the wire — see the per-
     *  stream cap in design doc §2.2.2. */
    chunk: z.string(),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_exit'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    code: z.number().int().nullable(),
    intentional: z.boolean(),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_ready_for_drain'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_startup_delivery_consumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_startup_delivery_failed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    delivery_ids: z.array(z.number().int()).min(1),
    reason: z.enum([
      'child_exit',
      'init_watchdog',
      'write_failed',
      'driver_refused',
    ]),
    ts: z.number().int(),
  }).strict(),
  // ── runtime init lifecycle (locked by Cindy `vqDWkLFF6pAeIE5t`) ──
  //
  // These three events surface the daemon-internal init watchdog +
  // retry loop to backend. Init lifecycle is ORTHOGONAL to
  // `runtime_startup_delivery_*`: empty-inbox and self-init paths
  // have no startup_delivery to attach to but still get watchdog
  // timeouts / retries / cooldown. Backend doesn't own retry — daemon
  // does — but backend translates each event into UI / DB projection
  // (`agent_status` SSE, `updateAgentRuntime` columns, crash
  // notifications) since it owns those surfaces.
  //
  // Sequence over a typical failure path (retry_attempt is 0-indexed,
  // matching CM's `handle.initAttempt`):
  //   runtime_init_timeout (retry_attempt=0, retrying=true) →
  //   runtime_init_retrying (retry_attempt=1 of N) →
  //   runtime_init_timeout (retry_attempt=1, retrying=true) →
  //   ... →
  //   runtime_init_timeout (retry_attempt=N-1, retrying=false, cooldown_until=…) →
  //   runtime_init_cooldown (attempts_exhausted = N).
  // The cooldown path may also fire with retry_attempt=0 if max_retries=0.
  // The terminal `runtime_exit` follows separately when the daemon
  // gives up and the child process is gone.
  z.object({
    event: z.literal('runtime_init_timeout'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** Which watchdog tier tripped (mirrors CM's three-tier
     *  PR-A watchdog: silence between bytes / pre-protocol cap /
     *  post-protocol stall). Names match CM's `InitTimeoutReason` so
     *  backend can pass the value straight through to `agent_init_timeout`
     *  SSE without translation (Cindy `4CJATqU0DdbsGVXW`). */
    timeout_reason: z.enum(['silence', 'pre_protocol_cap', 'post_protocol']),
    /** Wall-clock ms between spawn and watchdog firing — only the
     *  daemon has the precise spawn timestamp, so we ship it on the
     *  same event rather than asking backend to reconstruct it. */
    elapsed_ms: z.number().int().nonnegative(),
    /** The configured timeout value (ms) for the tier that fired —
     *  varies per driver and may be overridden by daemon config. */
    timeout_ms: z.number().int().nonnegative(),
    /** True iff the daemon has already decided to re-spawn after this
     *  timeout. False means cooldown / give-up — a `runtime_exit`
     *  follows and no `runtime_init_retrying` will. Lets backend mark
     *  the projection terminal in a single hop without buffering. */
    retrying: z.boolean(),
    /** 0-indexed attempt number that just timed out (first attempt
     *  is 0). Matches CM's `handle.initAttempt` semantics. */
    retry_attempt: z.number().int().nonnegative(),
    /** Total retry budget the daemon will honor before cooldown. */
    max_retries: z.number().int().nonnegative(),
    /** Optional: present iff this timeout transition also engaged
     *  cooldown — wall-clock epoch ms when backend / user may
     *  attempt a fresh start. Carrying it on the same event keeps the
     *  cooldown-on-timeout path self-contained; backend never has to
     *  wait for a follow-up `runtime_init_cooldown` to know whether
     *  to publish `agent_status:crashed reason=init_cooldown` vs
     *  `init_timeout`. */
    cooldown_until: z.number().int().positive().optional(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_init_retrying'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** The attempt number about to start (= the previous timeout's
     *  retry_attempt + 1). */
    retry_attempt: z.number().int().positive(),
    max_retries: z.number().int().nonnegative(),
    /** How long the daemon will wait before re-spawning, ms. */
    delay_ms: z.number().int().nonnegative(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_init_cooldown'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** Wall-clock epoch ms after which backend / user may attempt a
     *  fresh start. Daemon will NOT auto-retry past this point. */
    cooldown_until: z.number().int().positive(),
    /** Total attempts that failed before cooldown engaged (== max_retries). */
    attempts_exhausted: z.number().int().nonnegative(),
    ts: z.number().int(),
  }).strict(),
  z.object({
    event: z.literal('runtime_output_dropped'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    dropped_count: z.number().int().nonnegative(),
    bytes_dropped: z.number().int().nonnegative(),
    since_ts: z.number().int(),
  }),
  z.object({
    event: z.literal('runtime_output_paused'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  z.object({
    event: z.literal('runtime_output_resumed'),
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  // ── runtime parsed event fanout (locked by Cindy `OQCA05pivtB8nSTC` +
  //     `C2BZGDbQWfnq-bKJ`) ─────────────────────────────────────────
  //
  // `runtime_parsed_event` is the structured sidecar of `runtime_output`:
  // each line the driver's `parseLine` recognizes becomes one of these
  // frames. The raw byte stream stays on `runtime_output` unchanged —
  // backend's observability / activity log / unparsed-line surface all
  // continue to read from there. Parsed events are NOT a replacement;
  // they are a strict superset of recognition signals derived from the
  // same bytes.
  //
  // Non-droppable: backend's `handleParsedEvent` drives the
  // AgentRunState lifecycle (thinking / tool_running / compacting /
  // turn_end) and the `session_events` DB projection. Dropping one
  // would leave run-state stuck or DB out of sync, neither of which
  // is recoverable from `runtime_output` alone (only the driver
  // knows the schema).
  //
  // No `raw_line` field: raw bytes are already on `runtime_output`,
  // so carrying them here would duplicate every byte at twice the
  // wire cost. The `parsed` payload is the only thing this frame
  // contributes beyond what `runtime_output` already provides.
  z
    .object({
      event: z.literal('runtime_parsed_event'),
      conversation_id: z.string().min(1),
      agent_id: z.string().min(1),
      parsed: ParsedEventSchema,
      ts: z.number().int(),
    })
    .strict(),
  // `runtime_parsed_event_dropped` is the safety valve when a parsed
  // event's encoded payload exceeds MAX_FRAME_BYTES. We CANNOT silently
  // truncate the `parsed` payload (Cindy: "frame 保护不要静默改写任意
  // ParsedEvent") — that would let backend believe it received a
  // complete `tool_call` / `text` / `unknown.raw` when it didn't.
  //
  // The dropped frame is metadata-only by hard rule (Cindy
  // `C2BZGDbQWfnq-bKJ`): `parsed_kind` lets backend project a
  // best-effort run-state hint (e.g. "we know a tool_call happened
  // even though we lost the input"), `encoded_bytes` lets backend
  // logs surface the size budget, and `reason` is a single-arm enum.
  // NO payload — explicitly NO `unknown.raw`, NO tool input, NO text.
  //
  // Note: this dropped frame is on the WIRE only. RealSupervisor
  // still updates its in-memory AgentRunState from the original
  // ParsedEvent before encoding — frame-too-large is a broadcast
  // concern, not a run-state concern (Cindy `C2BZGDbQWfnq-bKJ`).
  z
    .object({
      event: z.literal('runtime_parsed_event_dropped'),
      conversation_id: z.string().min(1),
      agent_id: z.string().min(1),
      parsed_kind: ParsedEventKindSchema,
      encoded_bytes: z.number().int().nonnegative(),
      reason: z.literal('frame_too_large'),
      ts: z.number().int(),
    })
    .strict(),
]);
export type EventFrame = z.infer<typeof EventFrameSchema>;

/**
 * Any frame either side may put on the wire. Daemon sends Response
 * (always) or Event (occasionally); client sends Request only. Treat
 * `event` field's presence as the discriminator over `id`.
 */
export const AnyFrameSchema = z.union([
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
]);
export type AnyFrame = z.infer<typeof AnyFrameSchema>;

// ── Wire encoding ───────────────────────────────────────────────────

/** Hard cap on one frame's encoded size. Guards both directions from
 *  pathological payloads and gives us a clean error to surface
 *  instead of letting the splitter buffer grow without bound.
 *  1 MiB is generous for PR-2's intent surface — `runtime_wake` and
 *  `runtime_start.startup_delivery` carry one stream-json line each,
 *  which is well under the cap in practice. */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/** Encode an outgoing frame to its NDJSON wire form (single line +
 *  trailing newline). Throws if the encoded payload would exceed the
 *  per-frame cap so we fail loud at the caller instead of silently
 *  emitting an oversized line the peer will reject. */
export function encodeFrame(frame: AnyFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(
      `host frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  return `${line}\n`;
}

/**
 * Incremental NDJSON splitter — pure function over (buffer, chunk) →
 * (frames[], leftover). Same logic both sides need; lifted out so we
 * can unit-test it on its own.
 *
 * The buffer is held by the caller. We return UTF-8 string frames; the
 * caller JSON.parses + schema-validates each one. Lines longer than
 * `MAX_FRAME_BYTES` are reported via `overflow` so the caller can
 * close the socket with a typed reason rather than letting the buffer
 * grow without bound.
 */
export interface SplitResult {
  /** Newly complete frame strings (without trailing `\n`). */
  frames: string[];
  /** Leftover unterminated bytes — pass back as `buffer` next call. */
  leftover: string;
  /** True if a single line exceeded MAX_FRAME_BYTES while accumulating.
   *  When true, caller must close the socket; further frames cannot be
   *  trusted because we had to drop the overflowing prefix. */
  overflow: boolean;
}

export function splitNdjson(buffer: string, chunk: string): SplitResult {
  const combined = buffer + chunk;
  const frames: string[] = [];
  let start = 0;
  let overflow = false;
  while (true) {
    const nl = combined.indexOf('\n', start);
    if (nl === -1) break;
    const line = combined.slice(start, nl);
    start = nl + 1;
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      overflow = true;
      // Stop accumulating further frames once we detect overflow; the
      // caller is contractually required to tear down the socket.
      return { frames, leftover: '', overflow };
    }
    frames.push(line);
  }
  const leftover = combined.slice(start);
  // Defensive: if the still-unterminated tail already exceeds the cap,
  // we will never close it (no `\n` will arrive in time). Signal
  // overflow now so the caller drops the connection.
  if (Buffer.byteLength(leftover, 'utf8') > MAX_FRAME_BYTES) {
    return { frames, leftover: '', overflow: true };
  }
  return { frames, leftover, overflow };
}
