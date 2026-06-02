import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogControl {
  getGlobalLevel(): LogLevel;
  setGlobalLevel(level: LogLevel): void;
  enableConversationDebug(conversationId: string, expiresAt: number): void;
  disableConversationDebug(conversationId: string): void;
  getConversationDebugStatus(conversationId: string): {
    enabled: boolean;
    expiresAt: number | null;
  };
}

interface FileLoggerOptions {
  dir: string;
  alsoConsole?: boolean;
  base?: Record<string, unknown>;
  filenamePrefix?: string;
  logControl?: LogControl;
}

interface FileLogger {
  filePath: string;
  logControl: LogControl;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): FileLogger;
  close(): Promise<void>;
}

interface CategorizedLoggers {
  system: FileLogger;
  agent: FileLogger;
  cli: FileLogger;
  logControl: LogControl;
}

function createLogControl(): LogControl {
  let level: LogLevel = 'warn';
  const debugWindows = new Map<string, number>();
  return {
    getGlobalLevel: () => level,
    setGlobalLevel: next => {
      level = next;
    },
    enableConversationDebug: (conversationId, expiresAt) => {
      debugWindows.set(conversationId, expiresAt);
    },
    disableConversationDebug: conversationId => {
      debugWindows.delete(conversationId);
    },
    getConversationDebugStatus: conversationId => {
      const expiresAt = debugWindows.get(conversationId) ?? null;
      if (expiresAt !== null && expiresAt <= Date.now()) {
        debugWindows.delete(conversationId);
        return { enabled: false, expiresAt: null };
      }
      return { enabled: expiresAt !== null, expiresAt };
    },
  };
}

function normalizeLogArgs(
  obj: unknown,
  msg?: string,
): { fields: Record<string, unknown>; msg: string } {
  if (typeof obj === 'string' && msg === undefined) {
    return { fields: {}, msg: obj };
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return {
      fields: obj as Record<string, unknown>,
      msg: msg ?? '',
    };
  }
  return { fields: { value: obj }, msg: msg ?? '' };
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

function createFileLogger(opts: FileLoggerOptions): FileLogger {
  mkdirSync(opts.dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(opts.dir, `${opts.filenamePrefix ?? 'backend'}-${ts}.log`);
  const stream = createWriteStream(filePath, { flags: 'a' });
  const alsoConsole = opts.alsoConsole ?? true;
  const base = { pid: process.pid, ...(opts.base ?? {}) };
  const logControl = opts.logControl ?? createLogControl();
  let closed = false;

  const write = (
    level: LogLevel,
    obj: unknown,
    msg?: string,
    bindings: Record<string, unknown> = {},
  ): void => {
    if (closed) return;
    const normalized = normalizeLogArgs(obj, msg);
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: normalized.msg,
      ...base,
      ...bindings,
      ...normalized.fields,
    };
    const encoded = `${safeJson(line)}\n`;
    stream.write(encoded);
    if (alsoConsole) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(encoded.trimEnd());
    }
  };

  const makeChild = (bindings: Record<string, unknown>): FileLogger => ({
    filePath,
    logControl,
    debug: (obj, msg) => write('debug', obj, msg, bindings),
    info: (obj, msg) => write('info', obj, msg, bindings),
    warn: (obj, msg) => write('warn', obj, msg, bindings),
    error: (obj, msg) => write('error', obj, msg, bindings),
    child: more => makeChild({ ...bindings, ...more }),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => stream.end(resolve));
    },
  });

  return makeChild({});
}

export function createCategorizedLoggers(
  opts: Omit<FileLoggerOptions, 'filenamePrefix'>,
): CategorizedLoggers {
  const logControl = opts.logControl ?? createLogControl();
  return {
    system: createFileLogger({ ...opts, filenamePrefix: 'backend', logControl }),
    agent: createFileLogger({ ...opts, filenamePrefix: 'agent', logControl }),
    cli: createFileLogger({ ...opts, filenamePrefix: 'cli', logControl }),
    logControl,
  };
}

export async function startEmbeddedSilverhandServer(): Promise<never> {
  throw new Error(
    'This Silverhand Desktop package was built as remote-only; embedded backend startup is unavailable.',
  );
}
