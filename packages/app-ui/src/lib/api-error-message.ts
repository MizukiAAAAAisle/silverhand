import { ApiError } from "./api";

const MAX_DETAIL_LENGTH = 320;

export interface DescribeApiErrorOptions {
  backendUnreachableMessage: string;
  fallbackMessage: string;
  actionLabel: string;
  knownCodeMessages?: Readonly<Record<string, string>>;
}

interface ParsedApiErrorBody {
  code: string | null;
  detail: string | null;
}

/**
 * Convert an API mutation failure into a user-facing sentence while keeping
 * backend details bounded. Known product codes keep their tailored copy; new
 * backend failures still surface their structured `error`/`message` instead
 * of being collapsed into a generic retry line.
 */
export function describeApiError(err: unknown, options: DescribeApiErrorOptions): string {
  if (err instanceof ApiError) {
    if (err.kind === "backend_unreachable") {
      return options.backendUnreachableMessage;
    }

    const parsed = parseApiErrorBody(err.body);
    if (parsed.code) {
      const knownMessage = options.knownCodeMessages?.[parsed.code];
      if (knownMessage) return knownMessage;
    }

    const detail = parsed.detail ?? httpStatusDetail(err);
    if (detail) {
      return finishSentence(`${options.actionLabel}: ${appendCode(detail, parsed.code)}`);
    }
    return options.fallbackMessage;
  }

  if (err instanceof Error && err.message.trim()) {
    return finishSentence(`${options.actionLabel}: ${boundedText(err.message)}`);
  }

  return options.fallbackMessage;
}

export function parseApiErrorBody(body: string): ParsedApiErrorBody {
  if (!body.trim()) return { code: null, detail: null };

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) {
      return { code: null, detail: boundedText(body) };
    }

    return {
      code: firstString(parsed, ["code", "error_code"]),
      detail: firstString(parsed, ["error", "message", "reason", "detail"]),
    };
  } catch {
    return { code: null, detail: boundedText(body) };
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const bounded = boundedText(value);
    if (bounded) return bounded;
  }
  return null;
}

function appendCode(detail: string, code: string | null): string {
  return code ? `${detail} (${code})` : detail;
}

function httpStatusDetail(err: ApiError): string {
  const statusText = err.statusText.trim();
  return statusText ? `HTTP ${err.status} ${statusText}` : `HTTP ${err.status}`;
}

function boundedText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_DETAIL_LENGTH) return compact;
  return `${compact.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function finishSentence(value: string): string {
  return /[.!?。！？]$/.test(value) ? value : `${value}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
