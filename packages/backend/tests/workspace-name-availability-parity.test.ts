import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type NameAvailabilityDto,
  NameAvailabilityDtoSchema,
  WorkspaceNameSchema,
} from '@silverhand/shared';
import { openDatabase } from '../src/db.js';
import { createBackendPersistence } from '../src/persistence/root.js';
import { isWorkspaceNameAvailable } from '../src/application/name-availability.js';

/**
 * TS-first half of the cross-language GET /api/workspaces/name-availability
 * parity gate (#task:2193).
 *
 * The SAME checked-in fixture the Rust parity test replays
 * (backend-server/tests/workspace_name_availability_parity.rs) — one `seed.sql`
 * executed against a fresh current-schema database and one `cases.json` of
 * (input → {available, reason}) pairs — is replayed here against the REAL
 * production authority. This test replicates the route body VERBATIM: the
 * `WorkspaceNameSchema.safeParse(name ?? '')` format gate, then the SHARED
 * `isWorkspaceNameAvailable({ workspaces })` uniqueness predicate the create path
 * also calls. The result is validated against the published
 * `NameAvailabilityDtoSchema` (so the `available ⇔ reason==='available'`
 * invariant is a wire fact, not route discipline) and then asserted equal to the
 * fixture the Rust `NameAvailabilityDto` projector is held to byte-for-byte.
 *
 * This test is the ORACLE: the expected values are hand-authored but the real TS
 * authority runs here first, so a wrong expectation goes red against reality
 * before the Rust side is ever asked to match it.
 *
 * The endpoint always answers HTTP 200; an unusable name is carried in `reason`,
 * never a 4xx. Every FORMAT refusal collapses to `invalid`, so the TS refusal
 * PRECEDENCE (`forbidden_code_point` vs `too_long`) is NOT observable here — the
 * two cross-length cases both land on `invalid`. That precedence is gated where
 * it reaches the wire: slice 2's PATCH admission (Zod issue code at 400).
 *
 * The one native `db.exec(seed)` is why this file is whitebox-inventoried
 * (db-boundary Gate 4): the seed is a shared contract both languages replay
 * byte-identically, so it cannot go through TS repos without ceasing to be the
 * same seed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'fixtures', 'workspace-name-availability');
const SEED_SQL = readFileSync(join(FX, 'seed.sql'), 'utf8');
const CASES = JSON.parse(readFileSync(join(FX, 'cases.json'), 'utf8')) as {
  readonly status: number;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly input: string;
    readonly expected: NameAvailabilityDto;
  }>;
};

describe('GET /api/workspaces/name-availability parity (#task:2193)', () => {
  it('the real TS authority produces the shared expected verdicts', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(SEED_SQL);
      const { repos } = createBackendPersistence(db);
      const workspaces = repos.workspaces;

      for (const testCase of CASES.cases) {
        // The route body, verbatim (routes/workspaces.ts): format gate first, then
        // the shared regular-namespace uniqueness predicate.
        const parsed = WorkspaceNameSchema.safeParse(testCase.input);
        const dto: NameAvailabilityDto = !parsed.success
          ? { available: false, reason: 'invalid' }
          : (() => {
              const available = isWorkspaceNameAvailable({ workspaces }, parsed.data);
              return { available, reason: available ? 'available' : 'taken' };
            })();

        const projected = NameAvailabilityDtoSchema.parse(dto);
        expect(projected, testCase.name).toEqual(testCase.expected);
      }
    } finally {
      db.close();
    }
  });
});
