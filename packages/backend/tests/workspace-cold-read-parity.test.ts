import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkspaceColdReadResponseSchema } from '@silverhand/shared';
import { openDatabase } from '../src/db.js';
import { createBackendPersistence } from '../src/persistence/root.js';
import { canViewWorkspace } from '../src/permissions.js';
import type { BackendContext } from '../src/context.js';
import type { UserPrincipal } from '../src/auth/principal.js';
import { buildWorkspaceColdReadEnvelope } from '../src/application/workspace-cold-read.js';

/**
 * TS-first half of the cross-language cold-read parity gate (#task:2190).
 *
 * The SAME checked-in fixture — one `seed.sql` executed against a fresh
 * current-schema database, one `expected-envelope.json` — is replayed here
 * against the REAL production authority (`WorkspaceRepo`, `SortRepo`, the real
 * `canViewWorkspace` membership rule, and the extracted
 * `buildWorkspaceColdReadEnvelope` the route itself calls) and, on the Rust side,
 * against the real `SqliteWorkspaceColdRead` + `WorkspaceColdReadResponse`
 * projector. Both must produce a value that validates against the published
 * `WorkspaceColdReadResponseSchema` AND equals the expected envelope, so the two
 * implementations cannot drift on discrimination, two-key ordering, DM
 * derivation, or the visible-and-non-archived sort filter.
 *
 * This test is the ORACLE: the expected JSON is authored by hand but the real TS
 * authority runs here first, so a wrong hand-authored value goes red against
 * reality before the Rust side is ever asked to match it.
 *
 * The one native `db.exec(seed)` is why this file is whitebox-inventoried
 * (db-boundary Gate 4): the seed is a shared contract both languages replay and
 * constructs states no repository writes (a non-member's workspace; orphan sort
 * entries for archived / foreign workspaces), so it cannot go through TS repos
 * without ceasing to be the same seed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'fixtures', 'workspace-cold-read');
const SEED_SQL = readFileSync(join(FX, 'seed.sql'), 'utf8');
const EXPECTED_ENVELOPE = JSON.parse(
  readFileSync(join(FX, 'expected-envelope.json'), 'utf8'),
) as unknown;

const VIEWER: UserPrincipal = { kind: 'user', userId: 'user-1' };

describe('GET /api/workspaces cold-read parity (#task:2190)', () => {
  it('the real TS authority produces the shared expected envelope', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(SEED_SQL);
      const { repos, authorizationReads } = createBackendPersistence(db);
      // `canViewWorkspace` reads only `ctx.authorizationReads`; the rest of the
      // context is not consulted on this path, so the minimal real port is the
      // whole dependency. This exercises the exact production visibility rule
      // (workspace existence + `workspace_users` membership) the route uses.
      const ctx = { authorizationReads } as unknown as BackendContext;
      const envelope = buildWorkspaceColdReadEnvelope(
        {
          workspaces: repos.workspaces,
          sort: repos.sort,
          canViewWorkspace: id => canViewWorkspace(ctx, VIEWER, id),
        },
        VIEWER.userId,
      );

      // The envelope is a valid instance of the published contract, and it
      // equals the fixture the Rust projector is held to byte-for-byte.
      const parsed = WorkspaceColdReadResponseSchema.parse(envelope);
      expect(parsed).toEqual(EXPECTED_ENVELOPE);
    } finally {
      db.close();
    }
  });
});
