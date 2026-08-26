import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPresenceEventSchema } from '@silverhand/shared';
import { PresenceRegistry } from '../src/presence/presence-registry.js';
import type { ScopeEventBus } from '../src/ws/scope-event-bus.js';

/**
 * TS-first half of the cross-language `user_presence` EVENT-wire parity gate
 * (#task:2197, presence phase 1).
 *
 * The GET /api/presence gate (presence-cold-read-parity.test.ts) signs the pull
 * answer; this signs the PUSH the same axis emits. The SAME checked-in fixtures
 * the Rust producer replays (backend-server/src/scope_events.rs, the
 * `user_presence_wire_parity` unit test) are asserted here: one `online.json`
 * and one `offline.json`, each the `{scope, kind, payload}` the registry hands
 * to `publishToScope`. The value is produced by the REAL production authority —
 * the actual `PresenceRegistry`, driven through a genuine online transition and
 * a genuine grace-expiry offline transition — so a wrong hand-authored payload
 * goes red against reality BEFORE the Rust side is ever asked to match it. The
 * registry decides the whole projection (scope `'app'`, kind `'user_presence'`,
 * the online arm's suppressed `last_seen_at: null`, the offline arm's persisted
 * stamp); the bus is captured at the registry's own emit edge, so nothing about
 * the row is invented by the test.
 *
 * This is the SOLE `user_presence` projection contract both impls share: the WS
 * lifecycle FEED that calls `onConnect`/`onDisconnect` (phase 2) and the
 * composition that shares one registry between feed, sink and GET (phase 3) are
 * verified elsewhere; this gate pins only the domain-fact -> wire-row shape.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_234_000;
const GRACE_MS = 50;

interface Captured {
  scope: string;
  kind: string;
  payload: unknown;
}

function fixture(name: 'online' | 'offline'): Captured {
  return JSON.parse(
    readFileSync(join(here, 'fixtures', 'presence-event', `${name}.json`), 'utf8'),
  ) as Captured;
}

describe('user_presence event-wire parity (#task:2197)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the real presence authority emits the shared online then offline rows', () => {
    const captured: Captured[] = [];
    // The bus is a pure sink of the registry's decision: capture the exact
    // `(scope, kind, payload)` triple at the registry's own emit edge. Only
    // `publishToScope` is consulted, so this faithfully records the authority.
    const events = {
      publishToScope(scope: string, kind: string, payload: unknown) {
        captured.push({ scope, kind, payload });
      },
    } as unknown as ScopeEventBus;
    const touched: Array<{ id: string; ts: number }> = [];

    const registry = new PresenceRegistry({
      events,
      users: {
        touchLastSeen: (id: string, ts: number) => {
          touched.push({ id, ts });
          return true;
        },
      },
      offlineGraceMs: GRACE_MS,
      now: () => FIXED_NOW,
    });

    // A genuine online transition: first connection for a viewer that was offline.
    registry.onConnect('viewer-1', 'conn-1');
    expect(captured).toHaveLength(1);

    // A genuine offline transition: last connection drops, grace window expires.
    registry.onDisconnect('viewer-1', 'conn-1');
    expect(captured).toHaveLength(1); // grace window: not offline yet
    vi.advanceTimersByTime(GRACE_MS);
    expect(captured).toHaveLength(2);

    const online = captured[0]!;
    const offline = captured[1]!;

    // Each payload is a valid instance of the published contract, and the whole
    // emitted triple equals the fixture the Rust producer is held to.
    UserPresenceEventSchema.parse(online.payload);
    UserPresenceEventSchema.parse(offline.payload);
    expect(online).toEqual(fixture('online'));
    expect(offline).toEqual(fixture('offline'));

    // The offline stamp the wire carries is the one persisted to the store.
    expect(touched).toEqual([{ id: 'viewer-1', ts: FIXED_NOW }]);

    registry.dispose();
  });
});
