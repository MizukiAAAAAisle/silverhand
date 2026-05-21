/**
 * Tiny JSONL logger for the daemon process. Mirrors the format of
 * `packages/backend/src/logger.ts` so a future split can promote
 * either logger to a shared package without breaking the on-disk
 * format the user already greps with `jq`.
 *
 * Three observable differences from the backend logger:
 *
 *  1. Filename prefix is `daemon` so `~/.silverhand/logs/` cleanly
 *     groups daemon boots alongside `backend-*` / `agent-*` / `cli-*`.
 *  2. The daemon process may run headless (no Electron). When
 *     `alsoStderr` is true, lines also mirror to stderr so a parent
 *     `silverhand-daemon` invocation prints them where the operator
 *     can see them. We use stderr (not stdout) because stdout is
 *     reserved for the `ready` handshake line.
 *  3. No `child(bindings)`. The daemon doesn't have many concerns to
 *     subdivide; if we need scoping later, lift the backend logger
 *     into shared and use it instead.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export interface DaemonLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  /** Absolute path of the log file currently being written. */
  filePath: string;
  /** Flush + close the underlying stream. Idempotent. */
  close(): Promise<void>;
}

export interface DaemonLoggerOptions {
  dir: string;
  alsoStderr?: boolean;
  base?: Record<string, unknown>;
}

export function createDaemonLogger(opts: DaemonLoggerOptions): DaemonLogger {
  mkdirSync(opts.dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(opts.dir, `daemon-${ts}.log`);
  const stream = createWriteStream(filePath, { flags: 'a' });
  const alsoStderr = opts.alsoStderr ?? false;
  const base: Record<string, unknown> = { pid: process.pid, ...(opts.base ?? {}) };

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
    const encoded = safeStringify(line);
    stream.write(encoded + '\n');
    if (alsoStderr) {
      process.stderr.write(`[daemon ${level}] ${msg ?? ''} ${encoded}\n`);
    }
  };

  return {
    filePath,
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
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
    return JSON.stringify({
      ts: line.ts,
      level: line.level,
      msg: line.msg,
      _stringify_error: true,
    });
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
