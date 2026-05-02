import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tiny file logger for chat-bridge — runs as a child process spawned by
 * the agent CLI, so it has no shared logger with the backend. We write
 * to the same `<silverhandDir>/logs/` directory the backend writes to,
 * gated by the `SILVERHAND_LOG_DIR` env var (set by SessionManager).
 *
 * Format: one JSON object per line. No-op when the env var is unset
 * (e.g. running standalone for local debugging).
 */

let filePath: string | null = null;
let base: Record<string, unknown> = {};

export function initBridgeLogger(bindings: Record<string, unknown>): void {
  const dir = process.env.SILVERHAND_LOG_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  const sid = String(bindings.sessionId ?? 'unknown');
  const aid = String(bindings.agentId ?? 'unknown');
  filePath = join(dir, `chat-bridge-${sid}-${aid}.log`);
  base = { pid: process.pid, ...bindings };
  log('info', { startedAt: new Date().toISOString() }, 'chat-bridge: started');
}

export function log(level: 'info' | 'warn' | 'error', obj: unknown, msg?: string): void {
  if (!filePath) return;
  const fields =
    obj && typeof obj === 'object' && !(obj instanceof Error)
      ? (obj as Record<string, unknown>)
      : { data: serialize(obj) };
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: msg ?? '',
    ...base,
    ...fields,
  };
  try {
    appendFileSync(filePath, JSON.stringify(line, errorReplacer) + '\n');
  } catch {
    // best-effort; never let logging crash the bridge
  }
}

function serialize(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
