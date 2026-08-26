import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { installPublicBearerMiddleware } from '../src/auth/bearer.js';
import { createPresenceApp } from '../src/routes/presence.js';
import type { AppEnv } from '../src/auth/principal.js';
import type { BackendContext } from '../src/context.js';

/**
 * TS-first half of the cross-language GET /api/presence AUTH-REFUSAL parity gate
 * (#task:2197, presence phase 3).
 *
 * `presence-cold-read-parity.test.ts` signs the answer a reaching request gets;
 * this signs what the perimeter returns to a request that must never reach the
 * route at all. It is split from that gate deliberately: the refusal is not the
 * presence leaf's — it belongs to the bearer middleware the composition root
 * mounts, and neither the leaf nor a Rust composition test may invent it.
 *
 * The value is produced by the REAL production perimeter: the actual
 * `installPublicBearerMiddleware` mounted over the actual `createPresenceApp`, in
 * the same order `createApiRouter` mounts them. Both reachable refusal arms are
 * driven — no `Authorization` header at all, and a header carrying a token the
 * real session validator rejects — and both must produce the ONE checked-in
 * `refusal.json` the Rust composition (`backend-app`, the perimeter test) is then
 * held to byte-for-byte. The fixture stores the raw body TEXT, not a parsed
 * object, so the comparison is over bytes and cannot be laundered through two
 * serializers.
 *
 * The route is mounted for real rather than stubbed so this also witnesses that
 * the refusal happens BEFORE the route: `users.list()` is instrumented and must
 * never be consulted. A perimeter that let the request through and then refused
 * would emit the same body and pass a body-only assertion.
 */
const here = dirname(fileURLToPath(import.meta.url));

interface Refusal {
  status: number;
  body: string;
}

function fixture(): Refusal {
  return JSON.parse(
    readFileSync(join(here, 'fixtures', 'presence', 'unauthorized', 'refusal.json'), 'utf8'),
  ) as Refusal;
}

/**
 * The whole dependency the perimeter and the presence route consult on a refused
 * request: the session validator that rejects, the warn logger the middleware
 * audits through, and the liveness/user authorities the route would read. The
 * latter two record every consultation so the test can assert the route never ran.
 */
function harness() {
  const consulted: string[] = [];
  const ctx = {
    logger: { warn: () => {} },
    authSessions: {
      validateSessionToken: () => ({ ok: false as const, reason: 'invalid' }),
    },
    presence: {
      isOnline: (id: string) => {
        consulted.push(`isOnline:${id}`);
        return false;
      },
    },
  } as unknown as BackendContext;
  const users = {
    list: () => {
      consulted.push('users.list');
      return [];
    },
  } as unknown as Parameters<typeof createPresenceApp>[0]['users'];

  // The production mount order: the bearer middleware installs on `/api/*`
  // first, then the presence route is mounted under the same app.
  const app = new Hono<AppEnv>();
  installPublicBearerMiddleware(app, ctx, {});
  app.route('/', createPresenceApp({ ctx, users }));

  return { app, consulted };
}

describe('GET /api/presence auth-refusal parity (#task:2197)', () => {
  const cases = [
    { name: 'a request with no Authorization header', headers: {} },
    {
      name: 'a request whose bearer token the session validator rejects',
      headers: { authorization: 'Bearer not-a-session' },
    },
  ] as const;

  for (const { name, headers } of cases) {
    it(`the real perimeter refuses ${name} with the shared body`, async () => {
      const { app, consulted } = harness();
      const expected = fixture();

      const response = await app.request(apiPaths.presence, { headers });

      expect(response.status).toBe(expected.status);
      expect(await response.text()).toBe(expected.body);
      // The refusal preceded the route: neither presence authority was read.
      expect(consulted).toEqual([]);
    });
  }
});
