/**
 * Hono middleware that emits one structured log line per
 * `silverhand <noun> <verb>` CLI invocation.
 *
 * Mounted on `/internal/conversations/:cid/agents/:aid/*` (the family
 * of agent-principal routes). For every request:
 *   - on entry: capture `{conversationId, agentId, noun, verb, request_id, query_keys}`
 *   - on exit:  add `{http_status, duration_ms, status, error_code?,
 *               stale_resolution_reason?}`
 *               and write to `ctx.loggers.cli` with category `cli.invoke`
 *
 * What we deliberately do NOT log here:
 *   - request bodies (message content, attachment bytes, task titles)
 *   - arbitrary flag values (the sole allowlisted semantic value is the
 *     validated, low-cardinality `stale_resolution_reason` enum)
 *   - the bearer token / authorization header
 *
 * The cli-trace endpoint itself is excluded (its handler writes a
 * `cli.preflight_failure` line directly so observation events don't
 * pollute the `cli.invoke` success-rate stats).
 */
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { BackendContext } from '../context.js';
import { lookupCliRoute } from './cli-route-map.js';

const INTERNAL_PREFIX = '/internal/conversations/';

/** Suffix the cli-trace endpoint uses; excluded from invoke logging. */
export const CLI_TRACE_SUFFIX = 'cli-trace';

/**
 * Build the middleware. Bound to `ctx.loggers.cli` at install time.
 *
 * Note on ordering: this middleware MUST be registered after the
 * agent-token check (so principal binding is verified before we log
 * `agentId`) but it does its own start/end timing independent of any
 * later auth/ACL middleware. If a later middleware short-circuits
 * with 401/403/etc, we still emit one `cli.invoke` line with that
 * status — the agent's typo experience is preserved.
 */
export function createCliInvokeMiddleware(ctx: BackendContext): MiddlewareHandler {
  // Re-read `ctx.loggers.cli` per request so tests can swap a capture
  // logger in after `createInternalRouter(ctx)` has installed the
  // middleware. The cost is one property read per call.
  return async (c, next) => {
    const log = ctx.loggers.cli;
    const path = c.req.path;
    const suffix = extractAgentRouteSuffix(path);
    if (!suffix) {
      // Not under the conversation/agent route family; nothing to do.
      await next();
      return;
    }
    if (suffix === CLI_TRACE_SUFFIX) {
      // Observability endpoint logs itself as `cli.preflight_failure`.
      await next();
      return;
    }
    const route = lookupCliRoute(c.req.method, suffix);
    const started = process.hrtime.bigint();
    const requestId = randomUUID();

    // Make the request id available to handlers/middlewares that want
    // to correlate downstream backend logs to the same CLI call.
    c.set('cliRequestId', requestId);

    let httpStatus = 0;
    let errorCode: string | undefined;
    let errorIssues: ReadonlyArray<{ path: string; code: string }> | undefined;
    let thrown: unknown;
    try {
      await next();
      httpStatus = c.res.status;
    } catch (err) {
      thrown = err;
      httpStatus = readStatus(c) ?? 500;
      throw err; // Re-throw so the global error handler / Hono can respond.
    } finally {
      const durationMs = nsToMs(process.hrtime.bigint() - started);
      const status = httpStatus >= 200 && httpStatus < 400 ? 'success' : 'failure';
      if (status === 'failure') {
        const peeked = await peekErrorDetail(c);
        errorCode = peeked?.code;
        errorIssues = peeked?.issues;
      }
      const conversationId = c.req.param('cid') ?? null;
      const agentId = c.req.param('aid') ?? null;
      const staleResolutionReason = c.get('cliStaleResolutionReason');
      const payload = {
        category: 'cli.invoke',
        request_id: requestId,
        conversationId,
        agentId,
        noun: route?.noun ?? null,
        verb: route?.verb ?? null,
        method: c.req.method,
        // Normalized route pattern (never the raw URL). For routes
        // with a wildcard segment (e.g. `attachments/*/locate`) the
        // attachment id is collapsed to `*` so it never lands in
        // `cli-*.log`. Falls back to `null` for unmapped paths so
        // we don't accidentally log raw user-controlled data.
        route_suffix: route?.routeSuffix ?? null,
        query_keys: extractQueryKeys(c),
        http_status: httpStatus,
        duration_ms: durationMs,
        status,
        ...(errorCode ? { error_code: errorCode } : {}),
        // Route handlers set this only after validating and authorizing a
        // request carrying a stale event. Unlike `flags_seen`, this records
        // the disposal attempt that reached the freshness authority, including daemon-
        // supplied `force_send` and reason-less `unattributed` retries.
        ...(staleResolutionReason
          ? { stale_resolution_reason: staleResolutionReason }
          : {}),
        // Schema-validation field summary, sanitized: only `path`
        // (joined dotted) and `code` (zod tag like `too_small`,
        // `invalid_type`). NEVER `received` / `minimum` / `message`
        // since those can carry user-supplied values. Closes the 5/14
        // observability gap where `schedule.create | invalid_input`
        // logged with `error_message=''` because the structured
        // `issues[]` was discarded.
        ...(errorIssues && errorIssues.length > 0
          ? { error_issues: errorIssues }
          : {}),
        ...(thrown && status === 'failure'
          ? { error_kind: 'throw' }
          : {}),
      };
      if (status === 'success') {
        log.info(payload, 'cli.invoke');
      } else if (thrown || httpStatus >= 500) {
        log.error(payload, 'cli.invoke');
      } else {
        log.warn(payload, 'cli.invoke');
      }
    }
  };
}

/** `/internal/conversations/<cid>/agents/<aid>/<suffix...>` → suffix. */
function extractAgentRouteSuffix(path: string): string | null {
  if (!path.startsWith(INTERNAL_PREFIX)) return null;
  const rest = path.slice(INTERNAL_PREFIX.length);
  // rest = `<cid>/agents/<aid>/<suffix>`
  const parts = rest.split('/');
  if (parts.length < 4 || parts[1] !== 'agents') return null;
  return parts.slice(3).join('/') || null;
}

/** Set of query-string keys observed on the request — never values. */
function extractQueryKeys(c: Context): string[] {
  const url = new URL(c.req.url);
  const seen = new Set<string>();
  for (const [k] of url.searchParams) seen.add(k);
  return [...seen].sort();
}

function nsToMs(ns: bigint): number {
  return Math.round(Number(ns) / 1e3) / 1e3;
}

function readStatus(c: Context): number | null {
  try {
    return c.res.status;
  } catch {
    return null;
  }
}

/**
 * Best-effort attempt to read structured error info out of a JSON
 * response body. We clone the response, parse it once, and swallow any
 * error. The original response stays intact.
 *
 * Returns:
 *   - `code`: the stable backend error code (e.g. `invalid_input`,
 *     `forbidden`). Same field that used to be returned by the previous
 *     `peekErrorCode`; the legacy bare-string `error: 'forbidden'`
 *     shape is still picked up so existing tests stay green.
 *   - `issues`: zod schema-validation summary, ONE object per failing
 *     field. Each entry carries:
 *        path: dotted path (`'every_seconds'`, `'tasks.0.title'`)
 *        code: zod issue code (`'too_small'`, `'invalid_type'`, ...)
 *     Privacy contract: only `path` and `code` are surfaced. Fields
 *     like `received`/`minimum`/`message` can carry user-supplied
 *     values and are deliberately discarded so they never reach
 *     `cli-*.log`.
 */
async function peekErrorDetail(c: Context): Promise<
  | {
      code?: string;
      issues?: ReadonlyArray<{ path: string; code: string }>;
    }
  | undefined
> {
  try {
    const cloned = c.res.clone();
    const body = await cloned.json().catch(() => null);
    if (!body || typeof body !== 'object') return undefined;
    const code = extractCode(body);
    const issues = extractIssueSummary(body);
    if (code === undefined && issues === undefined) return undefined;
    return {
      ...(code !== undefined ? { code } : {}),
      ...(issues !== undefined ? { issues } : {}),
    };
  } catch {
    return undefined;
  }
}

function extractCode(body: unknown): string | undefined {
  const obj = body as Record<string, unknown>;
  const errCode =
    (obj.error as { code?: unknown } | undefined)?.code ?? obj.code;
  if (typeof errCode === 'string') return errCode;
  // Some legacy routes use { error: 'forbidden' } as a bare string.
  if (typeof obj.error === 'string') return obj.error;
  return undefined;
}

/**
 * Extract a privacy-safe summary of zod `issues[]` if present in the
 * response body. We tolerate the issues array landing under either
 * `body.issues` (e.g. `agentScheduleCreate` / `agentCliTrace`) or
 * `body.error.issues` for routes that nest. Anything that doesn't look
 * like a zod issue array is ignored (returns undefined → no field is
 * logged, vs an empty array which would still pollute lines).
 */
function extractIssueSummary(
  body: unknown,
): ReadonlyArray<{ path: string; code: string }> | undefined {
  const obj = body as Record<string, unknown>;
  const raw =
    (obj.issues as unknown) ??
    ((obj.error as { issues?: unknown } | undefined)?.issues as unknown);
  if (!Array.isArray(raw)) return undefined;
  const out: { path: string; code: string }[] = [];
  // Cap at 16 issues to bound the log line size; a malformed body with
  // hundreds of issues is still a single anomaly we want one line for.
  for (const issue of raw.slice(0, 16)) {
    if (!issue || typeof issue !== 'object') continue;
    const i = issue as Record<string, unknown>;
    const code = typeof i.code === 'string' ? i.code : undefined;
    const pathArr = Array.isArray(i.path) ? i.path : undefined;
    if (!code || !pathArr) continue;
    // Coerce each path segment to a string so numeric array indexes
    // (e.g. `['tasks', 0, 'title']` → `'tasks.0.title'`) read sensibly.
    // Reject segments that don't fit short identifier shape — guards
    // against the (currently unused) `z.record(...)` case where keys
    // could be agent-supplied. 64-char cap mirrors `path` field in
    // CliTraceInputSchema.
    const safe = pathArr
      .map(p => (typeof p === 'string' || typeof p === 'number' ? String(p) : ''))
      .filter(s => s.length > 0 && s.length <= 64 && /^[\w.\-:]+$/.test(s));
    if (safe.length === 0 && pathArr.length > 0) continue;
    out.push({ path: safe.join('.'), code });
  }
  return out.length > 0 ? out : undefined;
}
