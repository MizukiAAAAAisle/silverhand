import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { setPrincipal, type AppEnv } from '../src/auth/principal.js';
import type { BackendContext } from '../src/context.js';
import { openDatabase } from '../src/db.js';
import { createBackendPersistence } from '../src/persistence/root.js';
import { createAvailabilityApp } from '../src/routes/availability.js';

/**
 * TS-first half of the cross-language GET /api/agents/:id/availability whole-wire
 * parity gate (#task:2195, batch 2).
 *
 * The SAME checked-in fixtures the Rust parity test replays
 * (backend-server/tests/availability_parity.rs) are replayed here: one `seed.sql`
 * against a fresh current-schema database, one `input.json` naming the
 * authenticated viewer, the agent asked about, and the hosts the delivery
 * transport is attached to, and one `expected.json` — status AND body — the wire
 * response must equal. The value is produced by the REAL production authority:
 * the actual `createAvailabilityApp`, its `canViewAgent` ACL (creator ∪
 * human direct-pair endpoints ∪ shared-workspace members, evaluated ACL-first),
 * and its reachability resolution over a fixed attachment oracle. A wrong
 * hand-authored expectation goes red against reality BEFORE the Rust side is ever
 * asked to match it. Neither implementation self-signs the wire: this oracle
 * ratifies it, and the Rust projector is then held to the same artifact.
 *
 * Two authorities are composed in a fixed order, so BOTH the 200 (online/offline)
 * and the 404 (anti-enumeration) bodies belong to this gate — an absent agent, a
 * refused viewer, and a stage this view hides collapse to ONE byte-identical
 * `404 {"error":"agent not found"}`. The auth-refusal (`401`) body is NOT here: it
 * is the bearer perimeter the composition root mounts (#task:2197), split off so
 * neither the leaf nor a Rust test invents it. The viewer principal this gate
 * needs is injected the way that perimeter would attach it.
 */
const here = dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  'online-creator',
  'online-direct-pair',
  'online-workspace-member',
  'online-agent-home',
  'offline-deleted',
  'offline-revoked',
  'offline-detached',
  'deny-not-viewer',
  'miss-absent-agent',
  'stage-hidden',
] as const;

interface AvailabilityInput {
  viewer: string;
  agent_id: string;
  attached_hosts: string[];
}

interface AvailabilityExpected {
  status: number;
  body: unknown;
}

describe('GET /api/agents/:id/availability whole-wire parity (#task:2195)', () => {
  for (const name of FIXTURES) {
    it(`the real TS availability authority produces the shared "${name}" response`, async () => {
      const dir = join(here, 'fixtures', 'availability', name);
      const seed = readFileSync(join(dir, 'seed.sql'), 'utf8');
      const input = JSON.parse(
        readFileSync(join(dir, 'input.json'), 'utf8'),
      ) as AvailabilityInput;
      const expected = JSON.parse(
        readFileSync(join(dir, 'expected.json'), 'utf8'),
      ) as AvailabilityExpected;

      const db = openDatabase(':memory:');
      try {
        db.exec(seed);
        const { repos, authorizationReads } = createBackendPersistence(db);

        // Availability reads exactly two things off the context: the
        // authorization facts `canViewAgent` decides on, and the outbound
        // attachment the reachability rule reads. A real `authorizationReads`
        // plus a fixed attachment oracle (the hosts named in `attached_hosts`
        // read connected) is the whole dependency and exercises the exact
        // production ACL and reachability the served route runs.
        const attached = new Set(input.attached_hosts);
        const ctx = {
          authorizationReads,
          outboundFrameAdapter: () => ({
            connectionIdForHost: (hostId: string) =>
              attached.has(hostId) ? `conn-${hostId}` : null,
          }),
        } as unknown as BackendContext;

        const app = new Hono<AppEnv>();
        // The authenticated principal is the composition perimeter's contribution;
        // this gate isolates the production authority, so it injects the viewer
        // the auth layer would otherwise attach.
        app.use('*', async (c, next) => {
          setPrincipal(c, { kind: 'user', userId: input.viewer });
          await next();
        });
        app.route(
          '/',
          createAvailabilityApp({ ctx, agents: repos.agents, hosts: repos.hosts }),
        );

        const response = await app.request(
          `/api/agents/${input.agent_id}/availability`,
        );
        expect(response.status).toBe(expected.status);
        const body: unknown = await response.json();
        expect(body).toEqual(expected.body);
      } finally {
        db.close();
      }
    });
  }
});
