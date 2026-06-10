import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../utils/app.js';
import goldenRoutes from './endpoint-registry-snapshot.json' with { type: 'json' };

/**
 * Endpoint-registry drift guard for the #task:966 routes.ts context split.
 * routes.ts is being carved into per-context route modules; the one real risk
 * of moving handlers between files is *dropping, renaming, or reordering* an
 * endpoint. This test enumerates the mounted Hono app's concrete routes (in
 * registration order) and asserts they equal a golden list captured before the
 * split.
 *
 * Ordered, not a sorted set: registration order is behavior-relevant (Hono
 * param-route shadowing), and the ordered snapshot is what proves the split
 * keeps every route at its original position.
 *
 * It guards path+method completeness/order only, NOT handler behavior — that
 * stays covered by the route suites (conversation-members / agent-capabilities)
 * and the P0 application-level tests.
 *
 * To intentionally re-baseline (e.g. when an endpoint is legitimately added or
 * a real sub-app mount changes path composition), run with
 * `UPDATE_ROUTE_SNAPSHOT=1` and review the resulting diff.
 */

const CONCRETE = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'endpoint-registry-snapshot.json',
);

function concreteRoutes(t: TestApp): string[] {
  return t.app.routes
    .filter(r => CONCRETE.has(r.method))
    .map(r => `${r.method} ${r.path}`);
}

describe('endpoint registry drift (#task:966)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('mounts exactly the golden set of concrete routes, in order', () => {
    t = buildTestApp();
    const live = concreteRoutes(t);

    if (process.env.UPDATE_ROUTE_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(live, null, 2) + '\n');
      return;
    }

    expect(live).toEqual(goldenRoutes);
  });
});
