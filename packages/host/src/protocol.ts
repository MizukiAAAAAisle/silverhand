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
import { AgentRunStateSchema } from '@silverhand/shared';

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
 * PR-2 step 1: shape held opaque (`unknown`) on the wire because the
 * daemon never inspects it — it just buffers + writes to stdin per
 * driver semantics. Step 2 moves the hydration logic into a typed
 * helper inside backend; the daemon contract is "I write whatever
 * bytes you give me on this field".
 */
export const StreamJsonPayloadSchema = z.unknown();
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

export const RuntimeStopParamsSchema = z
  .object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    /** soft = directive user message, hard = SIGTERM/SIGKILL cascade.
     *  Mirrors CM today. */
    mode: z.enum(['soft', 'hard']),
  })
  .strict();
export type RuntimeStopParams = z.infer<typeof RuntimeStopParamsSchema>;

export const RuntimeStopResultSchema = z
  .object({
    stopped: z.boolean(),
    exit_code: z.number().int().nullable(),
  })
  .strict();
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
  }),
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
 *  1 MiB is generous for PR-1's intent surface (largest payload is
 *  echo, ~kB) and leaves headroom for PR-2's runtime_inject which
 *  may carry env maps and small JSON arg lists. */
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
