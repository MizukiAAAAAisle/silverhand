/**
 * Hono middleware that emits one structured log line per
 * `silverhand <noun> <verb>` CLI invocation.
 *
 * Mounted on `/internal/conversations/:cid/agents/:aid/*` (the family
 * of agent-principal routes). For every request:
 *   - on entry: capture `{cid, aid, noun, verb, request_id, query_keys}`
 *   - on exit:  add `{http_status, duration_ms, status, error_code?}`
 *               and write to `ctx.loggers.cli` with category `cli.invoke`
 *
 * What we deliberately do NOT log here:
 *   - request bodies (message content, attachment bytes, task titles)
 *   - flag values (only the set of query-string keys observed)
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
 * `aid`) but it does its own start/end timing independent of any
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
    c.set('cliRequestId' as never, requestId);

    let httpStatus = 0;
    let errorCode: string | undefined;
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
        errorCode = await peekErrorCode(c);
      }
      const cid = c.req.param('cid') ?? null;
      const aid = c.req.param('aid') ?? null;
      log.info(
        {
          category: 'cli.invoke',
          request_id: requestId,
          cid,
          aid,
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
          ...(thrown && status === 'failure'
            ? { error_kind: 'throw' }
            : {}),
        },
        'cli.invoke',
      );
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
 * Best-effort attempt to read the `error.code` field out of a JSON
 * response body. We clone the response, parse it once, and swallow any
 * error. The original response stays intact.
 */
async function peekErrorCode(c: Context): Promise<string | undefined> {
  try {
    const cloned = c.res.clone();
    const body = await cloned.json().catch(() => null);
    if (body && typeof body === 'object') {
      const errCode =
        (body as { error?: { code?: unknown } }).error?.code ??
        (body as { code?: unknown }).code;
      if (typeof errCode === 'string') return errCode;
      // Some legacy routes use { error: 'forbidden' } as a bare string.
      const bare = (body as { error?: unknown }).error;
      if (typeof bare === 'string') return bare;
    }
  } catch {
    /* swallow */
  }
  return undefined;
}
