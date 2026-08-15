/**
 * CLI error contract — the single source of truth for what stderr looks
 * like, what exit codes mean, and how HTTP failures from the backend
 * map onto stable, agent-readable error codes.
 *
 * Scope:
 * - `code`: a short, stable identifier from `ERROR_CODES`. Backend
 *   `internal/*` routes either return one of these directly in
 *   `{error: {code, message}}` shape, or the CLI infers it from the
 *   HTTP status. Either way, the agent gets the same code.
 * - `subkind`: a finer classification the agent may branch on without
 *   the closed `code` enum having to grow. Raised locally by pre-flight
 *   refusals, and ADOPTED from the backend for the address vocabulary
 *   (`DELIVERY_TARGET_REFUSAL_CODES`, #task:2021 P4-4) — otherwise the
 *   status would be all that survived, and "an inbox is not a write
 *   destination" would reach the agent as a bare 400.
 * - `retriable`: whether the agent can retry without changing input.
 *   Validation/auth/not-found are NOT retriable; rate-limit and
 *   upstream-unavailable are.
 * - exit codes:
 *     0 = ok
 *     1 = user/input error (do not retry)
 *     2 = transient (may retry with backoff)
 *     3 = auth (stop, report to caller)
 * - stderr line:
 *     One short, friendly, action-oriented line. Never a stack trace,
 *     never a raw HTTP status string.
 *     In `--json` mode (default), the stderr line is a one-line JSON
 *     `{error: {code, message, retriable}}` object so the agent can
 *     parse and branch.
 *
 * The contract is exercised by `tests/errors.test.ts` and is the
 * agreement Cindy's backend slice (#193) maps backend errors onto.
 */

import {
  CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
  DELIVERY_TARGET_REFUSAL_CODES,
  SLOT_REACH_REFUSAL_CODE,
} from '@silverhand/shared';

export const ERROR_CODES = [
  'not_found',
  'forbidden',
  'capability_denied',
  'unauthorized',
  'validation_error',
  'conflict',
  'rate_limited',
  'upstream_unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Optional, descriptive sub-classification of a `validation_error`.
 * `code` remains the stable behavioral contract (drives `exitCodeFor`
 * and `retriable`); `subkind` lets agents and telemetry distinguish
 * input-shape variants without enlarging the closed `code` enum.
 *
 * The CLI-side union below is the source of truth. The shared
 * `CliTraceInputSchema.error_subkind` field is a wide
 * `string().max(64)` so adding a new subkind here does not require a
 * shared schema bump.
 */
export type ErrorSubkind =
  | 'flag_removed'
  | 'verb_removed'
  | 'missing_required_flag'
  | 'unexpected_arguments'
  | 'stdin_is_tty'
  /** Stdin closed with 0 bytes where content was required. `message send`
   *  with no body and no attachment; and `task create/edit --body` with an
   *  EMPTY pipe — which is fail-closed (writes nothing), NOT a silent clear,
   *  so a forgotten heredoc cannot wipe a task description. Clearing a task
   *  body is the explicit, separate `task edit --clear-body`. */
  | 'empty_stdin'
  | 'invalid_utf8'
  /** `task create/edit --body` was given an inline value. The Markdown body
   *  now comes only from stdin (a value-less `--body` switch), so the removed
   *  `--body <string>` form is refused before any stdin read. */
  | 'body_requires_stdin'
  /** Piped stdin exceeds a domain size cap. Raised early (during the read)
   *  as a memory bound when the byte total blows past the cap, and again as
   *  an exact check after decode (e.g. `task` body vs `TASK_CONTENT_MAX_LEN`
   *  UTF-16 code units). `details` carries `max_bytes` or `max_length`. */
  | 'content_too_long'
  | 'unknown_flag'
  | 'enum_invalid'
  | 'mutually_exclusive'
  /** A destination-taking door was called without `--target` (#task:2021 P4-4).
   *  Its own subkind rather than `missing_required_flag` because it is the one
   *  omission the cutover guarantees — an agent carrying the old habit sends
   *  with no address at all — and because the refusal carries the correction:
   *  `details.correct_target` is the id form of the caller's own stream, which
   *  is what an agent answering where it was woken should have passed. */
  | 'target_required'
  /** `--target` was spelled but is not an address. Mirrors the backend
   *  resolver's `target_malformed` 1:1 (same shared grammar decides both), and
   *  raised pre-flight so a body is never read — let alone uploaded — for a
   *  send that could not have landed. Says nothing about what exists: no
   *  lookup happened.
   *
   *  Also ADOPTED from the backend on the rare path where a token this CLI
   *  accepted is refused there (a door with a narrower grammar): same subkind
   *  for the same fact, whichever side noticed. */
  | 'target_malformed'
  /* The rest of the address vocabulary, ADOPTED from the backend's refusal —
   * one subkind per published code, no reinterpretation (#task:2021 P4-4).
   * They carry no branch: `target_unresolved` is where unknown and
   * unauthorized collapse, and `thread_not_in_target` where all three ways a
   * suffix can miss do, so publishing them tells the actor what to DO
   * (fix the token / ask for access / drop the suffix) without telling them
   * what exists. `tests/delivery-target-refusal-subkind.test.ts` fails if the
   * published set ever grows past this list. */
  /** The address names no stream this agent may use. */
  | 'target_unresolved'
  /** An agent inbox is a read face, never a write destination. */
  | 'inbox_not_writable'
  /** The `/thread:<root>` suffix names no reply cluster of that conversation. */
  | 'thread_not_in_target'
  /** `dm:@<own handle>` — a direct message needs another participant. */
  | 'self_pair_not_addressable'
  /** The door acts on a conversation and was handed a reply cluster: the
   *  address resolved, the SUFFIX has no operation here. Drop it. */
  | 'thread_suffix_not_supported'
  /** The address is fine and the stream is the agent's; this DOOR still acts
   *  only where the session is anchored (#task:2021 P4-4). Adopted for the same
   *  reason as the rest: without it a 403 says "you may not", when the fact the
   *  agent needs is narrower — a conversation-scoped session writes, uploads,
   *  adds members and forks in ITS OWN conversation, and reads / files tasks /
   *  schedules anywhere it participates. Not retriable and not fixable by
   *  changing the address: either run the door from the session anchored there,
   *  or ask a human. */
  | 'slot_out_of_scope'
  /** A by-number `task` verb (`detail`/`edit`/`status`/`unclaim`/`claim`) was
   *  called without its positional `<task_number>` operand. Distinct from
   *  `missing_required_flag`: the task number is no longer a flag, so an
   *  agent still reaching for `--task-number` gets `flag_removed` instead —
   *  the two subkinds separate "wrong shape" from "nothing supplied". */
  | 'missing_task_number'
  /** The positional `<task_number>` operand was not a positive integer.
   *  Task numbers are a per-workspace counter, so `0` / `-3` / `4.5` /
   *  `4abc` name nothing that can exist and are refused before the
   *  request rather than returning a 404 for an impossible number. An
   *  all-digit string too large to survive as an exact integer (past
   *  `Number.MAX_SAFE_INTEGER`) is refused for the same reason: it would
   *  otherwise be sent as a rounded, different number. */
  | 'invalid_task_number'
  /** A flag that requires a value arrived value-less or empty — e.g. the
   *  task `--id` global-identity selector spelled as a bare switch or fed an
   *  unset shell variable. Refused pre-flight: sending it on would either be
   *  a schema 400 or a plausible-looking lookup for a value the caller never
   *  supplied. */
  | 'missing_flag_value'
  /** A `message search` range selector was spelled but names no range:
   *  `--no-current-workspace` (presence IS the signal, so negating it says
   *  nothing) or an id selector whose value arrived empty (typically an
   *  unset shell variable). Dropping either would silently narrow the search
   *  to the calling conversation and return a plausible, wrong answer, so
   *  the call is refused before the request. */
  | 'empty_selector'
  /** `task create --source-message-id` hit the permanent 1:1 provenance lock:
   *  another task already owns that source. Carries `details.existing_task` so
   *  the agent can hand off to the winner instead of retrying. */
  | 'source_conflict'
  /** `task create --claim` was combined with a cross-conversation `--conversation-id`.
   *  A cross-conversation create is a dispatch (filed unclaimed so a destination
   *  member picks it up), so the self-claim is refused. Omit `--claim`. */
  | 'cross_conversation_claim'
  /** `message stale-receive` non-custody arbitration failures (#task:1614),
   *  mirroring the daemon's typed codes 1:1 — the pull call could not
   *  arbitrate; custody and the stale event are unchanged. */
  | 'pull_already_active'
  | 'stale_event_replaced'
  | 'runtime_replaced';

export interface CliErrorPayload {
  code: ErrorCode;
  /** Optional descriptive sub-classification of `code`. */
  subkind?: ErrorSubkind;
  message: string;
  retriable: boolean;
  /** Optional structured context for the agent reading stderr. NEVER
   *  forwarded to `cli-trace` — see `cli-trace.ts` for the privacy
   *  contract. Typical contents: `{flag, replacement}` for
   *  `flag_removed`, `{positional, rest}` for `unexpected_arguments`. */
  details?: Record<string, unknown>;
}

export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly subkind?: ErrorSubkind;
  public readonly retriable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(payload: CliErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.subkind = payload.subkind;
    this.retriable = payload.retriable;
    this.details = payload.details;
  }

  toPayload(): CliErrorPayload {
    return {
      code: this.code,
      ...(this.subkind ? { subkind: this.subkind } : {}),
      message: this.message,
      retriable: this.retriable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/**
 * The backend refusal codes this CLI ADOPTS as a subkind (#task:2021 P4-4).
 *
 * Derived from the shared vocabulary rather than listed here, so a code the
 * resolver starts raising cannot reach an agent as a bare HTTP status: the set is
 * closed on the shared side and this file only decides where it lands. Adoption is
 * as a SUBKIND, never as a `code` — `code` drives the exit class and retriability
 * and stays the closed enum above, while the status already carries the right
 * class for every one of these (400 for "fix your token", 404 for "not for you",
 * 403 for "not through this door from here" — which lands as `forbidden`, i.e.
 * exit 3: stop and report, exactly the right class for a boundary no retry moves).
 */
const ADOPTED_REFUSAL_SUBKINDS: readonly string[] = [
  ...DELIVERY_TARGET_REFUSAL_CODES,
  CONVERSATION_TARGET_SUFFIX_REFUSAL_CODE,
  SLOT_REACH_REFUSAL_CODE,
];

/** Map an HTTP status + an error body from the backend onto a `CliError` with a
 *  stable code. The CLI's job is to hide raw HTTP from the agent; if the backend
 *  already supplies a stable code we use it, otherwise we infer from status and
 *  keep the backend's own finer code as `subkind` when it is one we publish.
 *
 *  The `bodyText` parameter is the raw response body (already read
 *  upstream). We try JSON-parse defensively — backends sometimes return
 *  HTML for proxy errors. */
export function mapHttpError(status: number, bodyText: string): CliError {
  const parsed = safeParseErrorBody(bodyText);
  const subkind =
    parsed?.code && ADOPTED_REFUSAL_SUBKINDS.includes(parsed.code)
      ? { subkind: parsed.code as ErrorSubkind }
      : {};

  // Trust an explicit backend code only when it's in our enum.
  if (parsed?.code && (ERROR_CODES as readonly string[]).includes(parsed.code)) {
    const code = parsed.code as ErrorCode;
    return new CliError({
      code,
      message: parsed.message ?? defaultMessageForCode(code),
      retriable: isRetriableCode(code),
      ...(parsed.details ? { details: parsed.details } : {}),
    });
  }

  const code = inferCodeFromStatus(status);
  return new CliError({
    code,
    ...subkind,
    message: parsed?.message ?? defaultMessageForStatus(status, code),
    retriable: isRetriableCode(code),
    ...(parsed?.details ? { details: parsed.details } : {}),
  });
}

/** Wrap a low-level fetch / network failure (TCP refused, DNS fail,
 *  abort) as a transient error so the agent can retry. */
export function fromNetworkError(err: unknown): CliError {
  const reason = err instanceof Error ? err.message : String(err);
  return new CliError({
    code: 'upstream_unavailable',
    message: `cannot reach silverhand backend: ${reason}`,
    retriable: true,
  });
}

/** Map an unknown thrown value (zod parse failure, programmer error,
 *  etc.) to a `CliError`. Programmer errors land as `internal` so we
 *  don't leak stack traces; zod errors land as `validation_error`. */
export function fromUnknown(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (isZodError(err)) {
    return new CliError({
      code: 'validation_error',
      message: formatZodError(err),
      retriable: false,
    });
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new CliError({
    code: 'internal',
    message: `internal cli error: ${reason}`,
    retriable: false,
  });
}

export function exitCodeFor(code: ErrorCode): 1 | 2 | 3 {
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
    // A capability denial is an authorization failure (the agent is
    // authenticated but lacks the workspace capability) — same "stop and
    // report, do not retry" class as `forbidden`. No new exit class.
    case 'capability_denied':
      return 3;
    case 'rate_limited':
    case 'upstream_unavailable':
      return 2;
    default:
      return 1;
  }
}

/** Write a `CliError` to stderr per the contract.
 *  - `human` mode: short tag + message line; if `details.blocking_tasks`
 *    is present, each task gets its own follow-up line so the agent /
 *    operator can see exactly which tasks blocked the operation.
 *  - `json` mode (default): one-line JSON `{error:{code,subkind?,message,retriable,details?}}`.
 *  Never logs stack traces. The exit code is the caller's responsibility
 *  (use `exitCodeFor`). */
export function writeError(
  err: CliError,
  opts: { json: boolean; stderr?: { write(s: string): unknown } } = { json: true },
): void {
  const out = opts.stderr ?? process.stderr;
  if (opts.json) {
    out.write(JSON.stringify({ error: err.toPayload() }) + '\n');
    return;
  }
  const tag = err.subkind ? `${err.code}/${err.subkind}` : err.code;
  out.write(`silverhand: ${tag}: ${err.message}\n`);
  const blocking = readBlockingTasks(err.details);
  if (blocking && blocking.length > 0) {
    for (const t of blocking) {
      const assignee = t.assignee_name ? ` @${t.assignee_name}` : '';
      const title = t.title ? ` — ${t.title}` : '';
      out.write(`  #task:${t.task_number} (${t.status})${assignee}${title}\n`);
    }
  }
}

/** Best-effort extractor for the structured `blocking_tasks` array the
 *  backend attaches to `has_open_tasks` conflicts. Returns null when
 *  the shape doesn't match — `writeError` falls back to the message
 *  line only. We intentionally don't import the shared zod schema here:
 *  the CLI's render path must stay tolerant of slightly drifted
 *  details payloads. */
interface BlockingTaskRow {
  task_number: number;
  status: string;
  title: string;
  assignee_name: string | null;
}

function readBlockingTasks(
  details: Record<string, unknown> | undefined,
): BlockingTaskRow[] | null {
  if (!details) return null;
  const raw = details['blocking_tasks'];
  if (!Array.isArray(raw)) return null;
  const out: BlockingTaskRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const num = typeof e['task_number'] === 'number' ? e['task_number'] : null;
    const status = typeof e['status'] === 'string' ? e['status'] : null;
    if (num === null || status === null) continue;
    out.push({
      task_number: num,
      status,
      title: typeof e['title'] === 'string' ? e['title'] : '',
      assignee_name:
        typeof e['assignee_name'] === 'string' ? e['assignee_name'] : null,
    });
  }
  return out;
}

// ── internals ────────────────────────────────────────────────────

function inferCodeFromStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status < 600) return 'upstream_unavailable';
  // 4xx without a more specific mapping — treat as validation so the
  // agent doesn't blindly retry.
  if (status >= 400 && status < 500) return 'validation_error';
  return 'internal';
}

function isRetriableCode(code: ErrorCode): boolean {
  return code === 'rate_limited' || code === 'upstream_unavailable';
}

function defaultMessageForCode(code: ErrorCode): string {
  switch (code) {
    case 'not_found':
      return 'resource not found';
    case 'forbidden':
      return 'forbidden';
    case 'capability_denied':
      return 'missing a required workspace capability';
    case 'unauthorized':
      return 'auth token rejected by backend';
    case 'validation_error':
      return 'request rejected: invalid input';
    case 'conflict':
      return 'request conflicts with current state';
    case 'rate_limited':
      return 'rate limited; back off and retry';
    case 'upstream_unavailable':
      return 'silverhand backend is unreachable';
    case 'internal':
      return 'silverhand backend reported an internal error';
  }
}

function defaultMessageForStatus(status: number, code: ErrorCode): string {
  return `${defaultMessageForCode(code)} (HTTP ${status})`;
}

interface ParsedErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

function safeParseErrorBody(bodyText: string): ParsedErrorBody | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // Accept either `{error: {code, message, details?}}` or a flat
      // `{code, message, details?}`.
      const inner =
        obj.error && typeof obj.error === 'object'
          ? (obj.error as Record<string, unknown>)
          : obj;
      const code = typeof inner.code === 'string' ? inner.code : undefined;
      // `{error: "<sentence>", code?}` is what `internal/*` routes actually
      // send — the message IS the `error` field there. Reading only
      // `error.message` is why every one of those sentences used to reach the
      // agent as `... (HTTP 400)`: the backend named the problem and the CLI
      // replaced it with a status. The nested form wins when both exist.
      const message =
        typeof inner.message === 'string'
          ? inner.message
          : typeof obj.error === 'string'
            ? obj.error
            : undefined;
      const details =
        inner.details && typeof inner.details === 'object'
          ? (inner.details as Record<string, unknown>)
          : undefined;
      if (code || message || details) return { code, message, details };
    }
  } catch {
    // not JSON; fall through and let the caller use default messages.
  }
  return null;
}

function isZodError(err: unknown): err is { errors: Array<{ path: Array<string | number>; message: string }> } {
  return (
    !!err &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name: unknown }).name === 'ZodError' &&
    Array.isArray((err as { errors?: unknown }).errors)
  );
}

function formatZodError(err: { errors: Array<{ path: Array<string | number>; message: string }> }): string {
  const first = err.errors[0];
  if (!first) return 'request rejected: invalid input';
  const path = first.path.length > 0 ? first.path.join('.') : '<root>';
  return `invalid argument \`${path}\`: ${first.message}`;
}
