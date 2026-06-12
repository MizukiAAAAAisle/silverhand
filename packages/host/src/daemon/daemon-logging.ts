/**
 * §3.4 daemon logging contract — typed helpers that bind every
 * structured-log emit point on the daemon side to a fixed schema.
 *
 * The contract (locked by shiki `OZ8q7lDg9rgei4fy` + `02nX0D-JNcnmgfyJ`,
 * scoped by Cindy `c8GvzR8Q5pcqp2QI`):
 *
 *  - **Structured fields only.** No payload bodies, no stdin / stdout
 *    chunks, no inbox row content, no system-prompt / MEMORY content,
 *    no env values.
 *  - **Field-name guard.** Any field whose name suggests content
 *    (`payload`, `chunk`, `body`, `text`, `prompt`, `env`, `env_*`,
 *    `stdout`, `stderr`, `soft_directive`) is
 *    forbidden — even an empty string. This is enforced **at compile
 *    time** by the `*Log` parameter types: each helper accepts only
 *    the listed allow-list of field names.
 *
 * Five emit kinds (one helper each):
 *
 *  - `logIntent` — request-lifecycle events on the daemon side
 *    (`received | ok | error`). Used by `IntentDispatcher`.
 *  - `logEvent` — non-droppable / droppable events the daemon emitted
 *    to its socket peers. Used by `DaemonServer.broadcast`.
 *  - `logProcess` — child-process lifecycle (spawn / exit / sigterm /
 *    sigkill / reclaim). Used by reclaim + future supervisor.
 *  - `logDaemon` — daemon-process lifecycle (boot / shutting_down /
 *    pid_claim / pid_reclaim). Used by `runDaemon` + lifecycle.
 *  - `logBackpressure` — output-cap drop / pause / resume hooks.
 *    Used by the default `OutputBackpressure.logDrop` wiring inside
 *    `DaemonServer`.
 *
 * Why typed helpers rather than raw `logger.info({...})` calls
 * everywhere: the contract is one file, the redaction tests in
 * `daemon-logging.test.ts` exercise every helper against fixture
 * payloads with forbidden field names embedded as strings to assert
 * neither name nor value reaches the log line. Drift ("someone added
 * `chunk: '...'` to an intent log") is caught by the type system,
 * not by hoping reviewers spot it.
 */
import {
  findForbiddenLogFields,
  FORBIDDEN_LOG_FIELD_PREFIXES,
  FORBIDDEN_LOG_FIELDS,
} from '@silverhand/shared';
import type { DaemonLogger } from './logger.js';

/**
 * Forbidden field-name prefixes / exact matches. The redaction tests
 * verify no log entry passed through any helper carries any of these
 * as a field name.
 */
export { FORBIDDEN_LOG_FIELD_PREFIXES, FORBIDDEN_LOG_FIELDS };

// ── Intent ──────────────────────────────────────────────────────────

/**
 * Daemon-side request lifecycle. Three statuses:
 *
 *  - `received` — request frame parsed; before handler runs.
 *  - `ok` — handler returned successfully + result passed schema mirror.
 *  - `error` — handler threw, returned `unknown_intent`, returned
 *    `invalid_params`, or daemon is `shutting_down`. `error_code`
 *    carries the wire `ResponseError.code`.
 */
export interface IntentLog {
  intent: string;
  request_id: string;
  status: 'received' | 'ok' | 'error';
  conversationId?: string;
  agent_id?: string;
  error_code?: string;
  duration_ms?: number;
}

export function logIntent(logger: DaemonLogger, entry: IntentLog): void {
  const { status, intent } = entry;
  const level = status === 'error' ? 'warn' : 'info';
  logger[level]({ kind: 'intent', ...entry }, `intent ${intent} ${status}`);
}

// ── Event ───────────────────────────────────────────────────────────

/**
 * Daemon-emitted unsolicited event. Logged once per broadcast,
 * regardless of how many sockets received it.
 *
 * `delivery_ids` allowed because it's an integer array. `dropped_count`
 * / `bytes_dropped` allowed for the runtime_output_dropped summary.
 * NOT allowed: any field carrying byte content (chunk, etc.).
 */
export interface EventLog {
  event: string;
  conversationId?: string;
  agent_id?: string;
  pid?: number;
  delivery_ids?: number[];
  dropped_count?: number;
  bytes_dropped?: number;
}

export function logEvent(logger: DaemonLogger, entry: EventLog): void {
  logger.info({ kind: 'event', ...entry }, `event ${entry.event}`);
}

// ── Process ────────────────────────────────────────────────────────

/**
 * Child-process lifecycle. Used at agent CLI spawn / exit / signal,
 * and by `reclaimStaleDaemonIfPresent` for the reclaim path.
 */
export interface ProcessLog {
  action: 'spawn' | 'exit' | 'sigterm' | 'sigkill' | 'reclaim';
  pid: number;
  conversationId?: string;
  agent_id?: string;
  exit_code?: number | null;
  /** Whether the cmdline of `pid` matched our identity tokens (for
   *  reclaim). Boolean only — we do NOT log the cmdline itself. */
  cmdline_match?: boolean;
}

export function logProcess(logger: DaemonLogger, entry: ProcessLog): void {
  const { action } = entry;
  const level = action === 'sigkill' ? 'warn' : 'info';
  logger[level]({ kind: 'process', ...entry }, `process ${action}`);
}

// ── Daemon lifecycle ───────────────────────────────────────────────

/**
 * Daemon-process boot / shutdown / pid-file events.
 */
export interface DaemonLifecycleLog {
  action: 'boot' | 'shutting_down' | 'pid_claim' | 'pid_reclaim';
  pid: number;
  socket_path?: string;
  pid_file_path?: string;
  conflict_pid?: number;
}

export function logDaemon(logger: DaemonLogger, entry: DaemonLifecycleLog): void {
  logger.info({ kind: 'daemon', ...entry }, `daemon ${entry.action}`);
}

// ── Backpressure ───────────────────────────────────────────────────

/**
 * Output-cap drop / pause / resume hook. Kept symmetric so a future
 * `runtime_output_pause` / `_resume` driver wires through the same
 * helper.
 */
export interface BackpressureLog {
  conversationId: string;
  agent_id: string;
  action: 'dropped' | 'paused' | 'resumed';
  buffer_bytes: number;
  dropped_count?: number;
  bytes_dropped?: number;
}

export function logBackpressure(
  logger: DaemonLogger,
  entry: BackpressureLog,
): void {
  logger.warn({ kind: 'backpressure', ...entry }, `backpressure ${entry.action}`);
}

/**
 * Self-test helper used by `daemon-logging.test.ts`. Returns whether
 * `entry` would violate §3.4 by carrying any forbidden field name.
 * The runtime check is informational only; the typed interfaces above
 * are the primary guard.
 */
export function findForbiddenFields(
  entry: Record<string, unknown>,
): string[] {
  return findForbiddenLogFields(entry);
}
