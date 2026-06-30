import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  parseSilverhandLogLevel,
  sanitizeLogFields,
  SILVERHAND_LOG_LEVEL_ENV,
  type SilverhandLogLevel,
} from '@silverhand/shared';
import type { BackendLogger } from './context.js';

type LogEventLevel = SilverhandLogLevel | 'error';

export interface FileLoggerOptions {
  /** Directory to write logs into. One file per backend boot. */
  dir: string;
  /** Also mirror lines to console (default: true in dev, false otherwise). */
  alsoConsole?: boolean;
  /** Static fields included on every line (e.g. process pid). */
  base?: Record<string, unknown>;
  /** Filename prefix; the file is `<dir>/<prefix>-<utc>.log`. Defaults
   *  to `backend` so existing callers continue writing to
   *  `backend-<utc>.log`. */
  filenamePrefix?: string;
  /** Shared mutable level/window state. Categorized loggers pass one
   *  instance so system/agent/cli sinks change together. */
  logControl?: LogLevelControl;
  /** Categories that are audit/metrics streams and must persist even
   *  when the severity threshold would otherwise hide an info line.
   *  Keep this scoped to a sink, not global, so ordinary diagnostic
   *  info remains filtered. */
  alwaysWriteCategories?: readonly string[];
}

export interface FileLogger extends BackendLogger {
  /** Absolute path of the log file currently being written. */
  filePath: string;
  /** Mutable level/window state used by this logger and its children. */
  logControl: LogLevelControl;
  debug(obj: unknown, msg?: string): void;
  /** Returns a child logger that merges `bindings` into every line. */
  child(bindings: Record<string, unknown>): FileLogger;
  /** Flush + close the underlying stream. Idempotent. */
  close(): Promise<void>;
}

export interface ConversationDebugStatus {
  enabled: boolean;
  expiresAt: number | null;
}

export interface LogLevelControl {
  getGlobalLevel(): SilverhandLogLevel;
  setGlobalLevel(level: SilverhandLogLevel): void;
  enableConversationDebug(conversationId: string, expiresAt: number): void;
  disableConversationDebug(conversationId: string): void;
  getConversationDebugStatus(conversationId: string): ConversationDebugStatus;
}

/**
 * One JSONL file per backend boot under `<dir>/<prefix>-<utc>.log`
 * (default `prefix = backend`). Format: one JSON object per line —
 * `{ ts, level, msg, ...fields }`.
 *
 * Level is debug|info|warn|error. `SILVERHAND_LOG_LEVEL` accepts
 * error|warn|info|debug and defaults to warn. Per-conversation debug
 * windows are held in the shared `LogLevelControl`; a line must carry
 * `conversationId` to be lifted by that window.
 */
export function createFileLogger(opts: FileLoggerOptions): FileLogger {
  mkdirSync(opts.dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = opts.filenamePrefix ?? 'backend';
  const filePath = join(opts.dir, `${prefix}-${ts}.log`);
  const stream = createWriteStream(filePath, { flags: 'a' });
  const alsoConsole = opts.alsoConsole ?? true;
  const base: Record<string, unknown> = { pid: process.pid, ...(opts.base ?? {}) };
  const logControl = opts.logControl ?? createLogLevelControl();

  return makeLogger(
    stream,
    filePath,
    alsoConsole,
    base,
    logControl,
    new Set(opts.alwaysWriteCategories ?? []),
  );
}

/**
 * Categorized logger triple — three independent JSONL files under the
 * same `<dir>` so events from different concerns can be queried
 * separately:
 *
 *   - `system`: backend HTTP server lifecycle, scheduler, ws, auth, DB.
 *     Writes `backend-<utc>.log` (historical name preserved).
 *   - `agent`:  agent runtime spawn / drain / exit / compaction (now
 *     owned by silverhand-daemon and surfaced through
 *     `DaemonAgentRuntimeHost` + `RuntimeEventHandler`).
 *     Writes `agent-<utc>.log`.
 *   - `cli`:    every `silverhand` CLI invocation (success + failure)
 *     plus pre-flight failures reported by the CLI itself. These are
 *     audit/metrics events, so `cli.invoke` and
 *     `cli.preflight_failure` persist even when the global diagnostic
 *     level is warn.
 *     Writes `cli-<utc>.log`.
 *
 * All three share the same JSONL format and base fields. The split is
 * by sink only — callers route events to the appropriate logger via
 * `ctx.loggers.system|agent|cli` instead of `ctx.logger`.
 */
export interface CategorizedLoggers {
  system: FileLogger;
  agent: FileLogger;
  cli: FileLogger;
  logControl: LogLevelControl;
}

export function createCategorizedLoggers(
  opts: Omit<FileLoggerOptions, 'filenamePrefix' | 'alwaysWriteCategories'>,
): CategorizedLoggers {
  const logControl = opts.logControl ?? createLogLevelControl();
  return {
    system: createFileLogger({
      ...opts,
      filenamePrefix: 'backend',
      logControl,
      alwaysWriteCategories: EVENT_WS_DIAGNOSTIC_CATEGORIES,
    }),
    agent: createFileLogger({ ...opts, filenamePrefix: 'agent', logControl }),
    cli: createFileLogger({
      ...opts,
      filenamePrefix: 'cli',
      logControl,
      alwaysWriteCategories: CLI_AUDIT_CATEGORIES,
    }),
    logControl,
  };
}

const CLI_AUDIT_CATEGORIES = ['cli.invoke', 'cli.preflight_failure'] as const;
const EVENT_WS_DIAGNOSTIC_CATEGORIES = [
  'event_ws.publish',
  'event_ws.subscribe',
  'event_ws.unsubscribe',
  'event_ws.resume',
  'event_ws.snapshot_required',
  'event_ws.send_skipped_non_open',
  'event_ws.renderer',
] as const;

export function createLogLevelControl(
  initialLevel: SilverhandLogLevel = parseSilverhandLogLevel(
    process.env[SILVERHAND_LOG_LEVEL_ENV],
  ),
): LogLevelControl {
  let globalLevel = initialLevel;
  const windows = new Map<string, { expiresAt: number; timer: ReturnType<typeof setTimeout> }>();

  const clearWindow = (conversationId: string): void => {
    const existing = windows.get(conversationId);
    if (existing) clearTimeout(existing.timer);
    windows.delete(conversationId);
  };

  const purgeExpired = (conversationId: string, now = Date.now()): void => {
    const existing = windows.get(conversationId);
    if (!existing) return;
    if (existing.expiresAt <= now) clearWindow(conversationId);
  };

  return {
    getGlobalLevel: () => globalLevel,
    setGlobalLevel: level => {
      globalLevel = level;
    },
    enableConversationDebug: (conversationId, expiresAt) => {
      clearWindow(conversationId);
      const delay = expiresAt - Date.now();
      if (delay <= 0) return;
      const timer = setTimeout(() => {
        windows.delete(conversationId);
      }, delay);
      timer.unref?.();
      windows.set(conversationId, { expiresAt, timer });
    },
    disableConversationDebug: conversationId => {
      clearWindow(conversationId);
    },
    getConversationDebugStatus: conversationId => {
      purgeExpired(conversationId);
      const existing = windows.get(conversationId);
      return existing
        ? { enabled: true, expiresAt: existing.expiresAt }
        : { enabled: false, expiresAt: null };
    },
  };
}

function makeLogger(
  stream: WriteStream,
  filePath: string,
  alsoConsole: boolean,
  base: Record<string, unknown>,
  logControl: LogLevelControl,
  alwaysWriteCategories: ReadonlySet<string> = new Set(),
): FileLogger {
  const safeBase = sanitizeLogFields(base);
  const write = (level: LogEventLevel, obj: unknown, msg?: string) => {
    const rawFields =
      obj && typeof obj === 'object' && !(obj instanceof Error)
        ? (obj as Record<string, unknown>)
        : { data: serializeUnknown(obj) };
    const fields = sanitizeLogFields(rawFields);
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: msg ?? '',
      ...safeBase,
      ...fields,
    };
    if (!shouldWrite(level, line, logControl, alwaysWriteCategories)) return;
    stream.write(safeStringify(line) + '\n');
    if (alsoConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[${level}] ${msg ?? ''}`, fields);
    }
  };

  return {
    filePath,
    logControl,
    debug: (obj, msg) => write('debug', obj, msg),
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
    child: bindings =>
      makeLogger(
        stream,
        filePath,
        alsoConsole,
        { ...safeBase, ...bindings },
        logControl,
        alwaysWriteCategories,
      ),
    close: () =>
      new Promise<void>(resolve => {
        stream.end(() => resolve());
      }),
  };
}

function shouldWrite(
  eventLevel: LogEventLevel,
  line: Record<string, unknown>,
  logControl: LogLevelControl,
  alwaysWriteCategories: ReadonlySet<string>,
): boolean {
  if (eventLevel === 'error') return true;
  const category = typeof line.category === 'string' ? line.category : null;
  if (category && alwaysWriteCategories.has(category)) return true;
  const conversationId = typeof line.conversationId === 'string' ? line.conversationId : null;
  const effectiveLevel =
    conversationId && logControl.getConversationDebugStatus(conversationId).enabled
      ? 'debug'
      : logControl.getGlobalLevel();
  return LEVEL_RANK[eventLevel] >= LEVEL_RANK[effectiveLevel];
}

const LEVEL_RANK: Record<LogEventLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function serializeUnknown(v: unknown): unknown {
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  return v;
}

function safeStringify(line: Record<string, unknown>): string {
  try {
    return JSON.stringify(line, errorReplacer);
  } catch {
    return JSON.stringify({ ts: line.ts, level: line.level, msg: line.msg, _stringify_error: true });
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
