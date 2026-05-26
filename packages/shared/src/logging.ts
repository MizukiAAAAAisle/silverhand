export const SILVERHAND_LOG_LEVEL_ENV = 'SILVERHAND_LOG_LEVEL';

export const SILVERHAND_LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type SilverhandLogLevel = (typeof SILVERHAND_LOG_LEVELS)[number];

export const DEFAULT_SILVERHAND_LOG_LEVEL: SilverhandLogLevel = 'warn';

export const TEMP_CONVERSATION_DEBUG_WINDOW_MS = 10 * 60 * 1000;

export const FORBIDDEN_LOG_FIELDS = [
  'payload',
  'chunk',
  'body',
  'text',
  'prompt',
  'line',
  'env',
  'stdout',
  'stderr',
  'soft_directive',
] as const;

export const FORBIDDEN_LOG_FIELD_PREFIXES = ['env_'] as const;

export function parseSilverhandLogLevel(
  value: string | undefined,
): SilverhandLogLevel {
  if (
    value === 'error' ||
    value === 'warn' ||
    value === 'info' ||
    value === 'debug'
  ) return value;
  return DEFAULT_SILVERHAND_LOG_LEVEL;
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { value, redacted } = sanitizeLogRecord(fields, new WeakSet<object>());
  if (redacted > 0) value.redactedFieldCount = redacted;
  return value;
}

export function findForbiddenLogFields(entry: Record<string, unknown>): string[] {
  const hits: string[] = [];
  collectForbiddenLogFields(entry, hits, new WeakSet<object>());
  return hits;
}

function sanitizeLogValue(
  value: unknown,
  seen: WeakSet<object>,
): { value: unknown; redacted: number } {
  if (Array.isArray(value)) {
    if (seen.has(value)) return { value: '[Circular]', redacted: 0 };
    seen.add(value);
    let redacted = 0;
    const out = value.map(item => {
      const sanitized = sanitizeLogValue(item, seen);
      redacted += sanitized.redacted;
      return sanitized.value;
    });
    seen.delete(value);
    return { value: out, redacted };
  }

  if (isPlainRecord(value)) {
    return sanitizeLogRecord(value, seen);
  }

  return { value, redacted: 0 };
}

function sanitizeLogRecord(
  fields: Record<string, unknown>,
  seen: WeakSet<object>,
): { value: Record<string, unknown>; redacted: number } {
  if (seen.has(fields)) return { value: { _circular: true }, redacted: 0 };
  seen.add(fields);
  const sanitized: Record<string, unknown> = {};
  let redacted = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (isForbiddenLogField(key)) {
      redacted += 1;
      continue;
    }
    const nested = sanitizeLogValue(value, seen);
    sanitized[key] = nested.value;
    redacted += nested.redacted;
  }
  seen.delete(fields);
  return { value: sanitized, redacted };
}

function isForbiddenLogField(key: string): boolean {
  if ((FORBIDDEN_LOG_FIELDS as readonly string[]).includes(key)) return true;
  return FORBIDDEN_LOG_FIELD_PREFIXES.some(prefix => key.startsWith(prefix));
}

function collectForbiddenLogFields(
  value: unknown,
  hits: string[],
  seen: WeakSet<object>,
): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) collectForbiddenLogFields(item, hits, seen);
    seen.delete(value);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenLogField(key)) hits.push(key);
    collectForbiddenLogFields(child, hits, seen);
  }
  seen.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
