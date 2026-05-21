/**
 * `event-sanitize` — pure helpers for sanitizing `ParsedEvent`
 * payloads before they go on the wire as `agent_event` SSE.
 *
 * ## Why this lives here (not as CM-private anymore)
 *
 * CM owns the `agent_event` publish today; PR-2 step 2 commit 5 makes
 * `RuntimeEventHandler` the second publisher (legacy CM keeps working
 * via the gated `SILVERHAND_RUNTIME_HOST=legacy|daemon` switch).
 * Both call sites MUST apply the same sanitization or the daemon
 * path would silently regress two contracts:
 *
 *   1. `tool_call.input` size cap — large tool inputs (e.g. multi-MB
 *      JSON) would flood SSE listeners + bloat the Events panel.
 *   2. Recursion depth / circular reference protection — without it,
 *      a self-referencing input crashes JSON.stringify on the wire.
 *
 * Cindy `ch9ZsU0v0ATr6tr8` blocker (carried forward from commit-4
 * review): `sanitizeParsedEventForBroadcast` MUST be reused across
 * both paths, not duplicated. Living in a shared module is the only
 * way to make that a static invariant.
 *
 * The behavior is preserved byte-for-byte from CM's prior private
 * implementation — no relaxation, no new caps. Constants are
 * re-exported so tests can pin the boundary explicitly.
 */
import type { ParsedEvent } from '@silverhand/shared';

/** Per-string truncation cap. Strings longer than this are tail-trimmed
 *  with a `...<truncated N chars>` marker so the operator can see size. */
export const RAW_AGENT_EVENT_STRING_MAX_CHARS = 500;

/** Per-array slice cap. Arrays longer than this lose their tail; a
 *  `{__truncatedItems: N}` marker is appended so the renderer can
 *  show "+N more". */
export const RAW_AGENT_EVENT_ARRAY_MAX_ITEMS = 20;

/** Per-object key cap. Objects with more keys lose the trailing keys
 *  (entries iteration order); a `__truncatedKeys: N` field is added. */
export const RAW_AGENT_EVENT_OBJECT_MAX_KEYS = 40;

/** Recursion depth cap. Anything below this returns `'[Truncated object]'`
 *  so we don't blow the call stack on deep nesting. */
export const RAW_AGENT_EVENT_MAX_DEPTH = 4;

/**
 * Wrapper that only sanitizes `tool_call` events — every other
 * `ParsedEvent` kind passes through unchanged. CM published it on
 * the `agent_event` SSE; daemon-path publisher does the same.
 *
 * The `as {} | null` cast is the same one CM used: shared
 * `RequiredUnknownSchema` infers `Exclude<unknown, undefined>` =
 * `{} | null`, and the sanitizer's `unknown` return is narrowed
 * back to that. The sanitizer never returns `undefined`, so the
 * cast is sound at runtime.
 */
export function sanitizeParsedEventForBroadcast(ev: ParsedEvent): ParsedEvent {
  if (ev.kind !== 'tool_call') return ev;
  return {
    ...ev,
    input: sanitizeRawAgentEventValue(ev.input) as {} | null,
  };
}

/**
 * Recursive value sanitizer — caps strings, arrays, objects, and
 * depth. Bigints stringify (JSON can't carry them). Functions /
 * symbols (which JSON would drop anyway) fall through to `String()`
 * as a defensive fallback.
 *
 * Cycle detection uses a per-call `WeakSet`. The set is mutated as
 * we descend and entries are removed on the way out so siblings can
 * still reference the same object (only a true cycle returns
 * `'[Circular]'`).
 *
 * Exported so tests can validate the contract directly; in app code,
 * call `sanitizeParsedEventForBroadcast` — `sanitizeRawAgentEventValue`
 * is the underlying engine.
 */
export function sanitizeRawAgentEventValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return truncateRawAgentEventString(value);
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= RAW_AGENT_EVENT_MAX_DEPTH) return '[Truncated object]';

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, RAW_AGENT_EVENT_ARRAY_MAX_ITEMS)
      .map(item => sanitizeRawAgentEventValue(item, depth + 1, seen));
    const omitted = value.length - items.length;
    if (omitted > 0) items.push({ __truncatedItems: omitted });
    seen.delete(value);
    return items;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(
    0,
    RAW_AGENT_EVENT_OBJECT_MAX_KEYS,
  )) {
    out[key] = sanitizeRawAgentEventValue(entryValue, depth + 1, seen);
  }
  const omitted = entries.length - Object.keys(out).length;
  if (omitted > 0) out.__truncatedKeys = omitted;
  seen.delete(value);
  return out;
}

/**
 * String tail-truncation with an explicit byte-count marker. Used by
 * `sanitizeRawAgentEventValue` for terminal string nodes.
 */
export function truncateRawAgentEventString(value: string): string {
  if (value.length <= RAW_AGENT_EVENT_STRING_MAX_CHARS) return value;
  const omitted = value.length - RAW_AGENT_EVENT_STRING_MAX_CHARS;
  return `${value.slice(0, RAW_AGENT_EVENT_STRING_MAX_CHARS)}...<truncated ${omitted} chars>`;
}
