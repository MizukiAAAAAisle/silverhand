import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPaths, PresenceResponseSchema } from '@silverhand/shared';
import { openDatabase } from '../src/db.js';
import { createBackendPersistence } from '../src/persistence/root.js';
import { createPresenceApp } from '../src/routes/presence.js';
import type { BackendContext } from '../src/context.js';

/**
 * TS-first half of the cross-language GET /api/presence whole-wire parity gate
 * (#task:2195, batch 1 P0-2).
 *
 * The SAME checked-in fixtures the Rust parity test replays
 * (backend-server/tests/presence_parity.rs) are replayed here: one `seed.sql`
 * executed against a fresh current-schema database, one `online.json` naming the
 * present viewers, and one `expected.json` the whole body must equal. Here the
 * value is produced by the REAL production authority — the actual
 * `createPresenceApp`, its `users.list()` order, and its per-viewer
 * suppression join over a fixed liveness oracle — so a wrong hand-authored
 * expected body goes red against reality BEFORE the Rust side is ever asked to
 * match it. Neither implementation self-signs the wire: this oracle ratifies it,
 * and the Rust projector is then held to the same artifact byte-for-byte.
 *
 * The auth-refusal (`401`) whole body is NOT here: it is produced by the real
 * bearer perimeter the composition root mounts (#task:2197), split from this
 * pure-answer signer so neither the leaf nor a Rust test invents it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = ['success', 'empty'] as const;

describe('GET /api/presence whole-wire parity (#task:2195)', () => {
  for (const name of FIXTURES) {
    it(`the real TS presence authority produces the shared "${name}" body`, async () => {
      const dir = join(here, 'fixtures', 'presence', name);
      const seed = readFileSync(join(dir, 'seed.sql'), 'utf8');
      const online = new Set(
        JSON.parse(readFileSync(join(dir, 'online.json'), 'utf8')) as string[],
      );
      const expected = JSON.parse(
        readFileSync(join(dir, 'expected.json'), 'utf8'),
      ) as unknown;

      const db = openDatabase(':memory:');
      try {
        db.exec(seed);
        const { repos } = createBackendPersistence(db);
        // The presence route reads only `ctx.presence.isOnline` and
        // `users.list()`; nothing else in the context is consulted, so a real
        // user repo plus a fixed liveness oracle is the whole dependency and
        // exercises the exact production join (list order × per-viewer stamp
        // suppression) the served route runs.
        const ctx = {
          presence: { isOnline: (id: string) => online.has(id) },
        } as unknown as BackendContext;
        const app = createPresenceApp({ ctx, users: repos.users });

        const response = await app.request(apiPaths.presence);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();

        // The body is a valid instance of the published contract, and it equals
        // the fixture the Rust projector is held to byte-for-byte.
        const parsed = PresenceResponseSchema.parse(body);
        expect(parsed).toEqual(expected);
      } finally {
        db.close();
      }
    });
  }
});
