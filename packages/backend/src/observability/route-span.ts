// Route-span timing helpers (#task:981 — P10 prep). Shared observability glue
// extracted from routes.ts so both the public API router (routes.ts) and the
// internal-agent router (routes/internal-agent.ts) can use it without a reverse
// import. Moved verbatim — same thresholds, same log shape, same behavior.
import { performance } from 'node:perf_hooks';
import type { BackendContext } from '../context.js';

export const SLOW_ROUTE_SPAN_MS = 100;

export function timedRouteSpan<T>(
  ctx: BackendContext,
  span: string,
  fields: Record<string, unknown>,
  fn: () => T,
  resultFields?: (result: T) => Record<string, unknown>,
): T {
  const startedAt = performance.now();
  try {
    const result = fn();
    const elapsedMs = elapsedSince(startedAt);
    if (elapsedMs >= SLOW_ROUTE_SPAN_MS) {
      ctx.logger.warn(
        {
          span,
          elapsedMs,
          thresholdMs: SLOW_ROUTE_SPAN_MS,
          ...fields,
          ...(resultFields?.(result) ?? {}),
        },
        'api: slow route span',
      );
    }
    return result;
  } catch (err) {
    ctx.logger.warn(
      {
        span,
        elapsedMs: elapsedSince(startedAt),
        ...fields,
        err,
      },
      'api: route span failed',
    );
    throw err;
  }
}

export function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
