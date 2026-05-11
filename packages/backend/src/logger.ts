import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { BackendLogger } from './context.js';

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
}

export interface FileLogger extends BackendLogger {
  /** Absolute path of the log file currently being written. */
  filePath: string;
  /** Returns a child logger that merges `bindings` into every line. */
  child(bindings: Record<string, unknown>): FileLogger;
  /** Flush + close the underlying stream. Idempotent. */
  close(): Promise<void>;
}

/**
 * One JSONL file per backend boot under `<dir>/<prefix>-<utc>.log`
 * (default `prefix = backend`). Format: one JSON object per line —
 * `{ ts, level, msg, ...fields }`.
 *
 * Level is info|warn|error. We expose a separate `debug` mirror that
 * only writes when `SILVERHAND_LOG_DEBUG=1` so high-volume parser
 * traces don't drown the file by default.
 */
export function createFileLogger(opts: FileLoggerOptions): FileLogger {
  mkdirSync(opts.dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = opts.filenamePrefix ?? 'backend';
  const filePath = join(opts.dir, `${prefix}-${ts}.log`);
  const stream = createWriteStream(filePath, { flags: 'a' });
  const alsoConsole = opts.alsoConsole ?? true;
  const base: Record<string, unknown> = { pid: process.pid, ...(opts.base ?? {}) };

  return makeLogger(stream, filePath, alsoConsole, base);
}

/**
 * Categorized logger triple — three independent JSONL files under the
 * same `<dir>` so events from different concerns can be queried
 * separately:
 *
 *   - `system`: backend HTTP server lifecycle, scheduler, ws, auth, DB.
 *     Writes `backend-<utc>.log` (historical name preserved).
 *   - `agent`:  ConversationManager spawn / drain / exit / compaction.
 *     Writes `agent-<utc>.log`.
 *   - `cli`:    every `silverhand` CLI invocation (success + failure)
 *     plus pre-flight failures reported by the CLI itself.
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
}

export function createCategorizedLoggers(
  opts: Omit<FileLoggerOptions, 'filenamePrefix'>,
): CategorizedLoggers {
  return {
    system: createFileLogger({ ...opts, filenamePrefix: 'backend' }),
    agent: createFileLogger({ ...opts, filenamePrefix: 'agent' }),
    cli: createFileLogger({ ...opts, filenamePrefix: 'cli' }),
  };
}

function makeLogger(
  stream: WriteStream,
  filePath: string,
  alsoConsole: boolean,
  base: Record<string, unknown>,
): FileLogger {
  const write = (level: 'info' | 'warn' | 'error', obj: unknown, msg?: string) => {
    const fields =
      obj && typeof obj === 'object' && !(obj instanceof Error)
        ? (obj as Record<string, unknown>)
        : { data: serializeUnknown(obj) };
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: msg ?? '',
      ...base,
      ...fields,
    };
    stream.write(safeStringify(line) + '\n');
    if (alsoConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[${level}] ${msg ?? ''}`, fields);
    }
  };

  return {
    filePath,
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
    child: bindings => makeLogger(stream, filePath, alsoConsole, { ...base, ...bindings }),
    close: () =>
      new Promise<void>(resolve => {
        stream.end(() => resolve());
      }),
  };
}

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
