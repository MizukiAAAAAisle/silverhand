// Auth session metadata projection (#task:983 — P17 prep).
//
// Pure request-header → session-metadata projection shared by the embedded
// bootstrap route (stays in the composition root) and the carved auth routes
// (routes/auth.ts). It is not part of any route domain, so it lives in a
// neutral leaf both sides import — keeping the projection single-source without
// a routes.ts ↔ routes/auth.ts back-edge.
import type { Context } from 'hono';

export function authSessionMetadata(c: Context): {
  userAgent: string | null;
  ipFirstSeen: string | null;
} {
  return {
    userAgent: c.req.header('user-agent') ?? null,
    ipFirstSeen:
      firstForwardedFor(c.req.header('x-forwarded-for'))
      ?? c.req.header('x-real-ip')
      ?? null,
  };
}

function firstForwardedFor(value: string | undefined): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}
