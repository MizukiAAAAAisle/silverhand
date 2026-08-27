import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ViewerWorkspaceDtoSchema } from '@silverhand/shared';
import { openDatabase } from '../src/db.js';
import { createBackendPersistence } from '../src/persistence/root.js';
import { canViewWorkspace } from '../src/permissions.js';
import { toViewerWorkspace } from '../src/application/workspace-cold-read.js';
import type { BackendContext } from '../src/context.js';
import type { UserPrincipal } from '../src/auth/principal.js';

/**
 * TS-first half of the cross-language GET /api/workspaces/:id detail parity gate
 * (#task:2193).
 *
 * The SAME checked-in fixture the Rust parity test replays
 * (backend-server/tests/workspace_detail_parity.rs) — one `seed.sql` executed
 * against a fresh current-schema database and one `cases.json` of
 * (id → {status, body}) pairs — is replayed here against the REAL production
 * authority. This replicates the route body VERBATIM: `workspaces.get(id)`
 * resolves existence FIRST (absent ⇒ 404), the real `canViewWorkspace`
 * membership rule then grades visibility (present but unseen ⇒ 403, distinct from
 * 404), and only a visible workspace is projected through the SAME
 * `toViewerWorkspace` face the list read emits.
 *
 * This test is the ORACLE: the expected status+body are hand-authored but the
 * real TS authority runs here first, so a wrong expectation goes red against
 * reality before the Rust side is ever asked to match it.
 *
 * The one native `db.exec(seed)` is why this file is whitebox-inventoried
 * (db-boundary Gate 4): the seed is a shared contract both languages replay
 * byte-identically (it constructs a present-but-unseen workspace no TS repo write
 * arranges for this viewer), so it cannot go through TS repos without ceasing to
 * be the same seed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'fixtures', 'workspace-detail');
const SEED_SQL = readFileSync(join(FX, 'seed.sql'), 'utf8');
const CASES = JSON.parse(readFileSync(join(FX, 'cases.json'), 'utf8')) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly expected: { readonly status: number; readonly body: unknown };
  }>;
};

const VIEWER: UserPrincipal = { kind: 'user', userId: 'user-1' };

describe('GET /api/workspaces/:id detail parity (#task:2193)', () => {
  it('the real TS authority produces the shared expected responses', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(SEED_SQL);
      const { repos, authorizationReads } = createBackendPersistence(db);
      // `canViewWorkspace` reads only `ctx.authorizationReads` (workspace
      // existence + `workspace_users` membership); the rest of the context is not
      // consulted on this path, so the minimal real port is the whole dependency.
      const ctx = { authorizationReads } as unknown as BackendContext;

      for (const testCase of CASES.cases) {
        // The route body, verbatim (routes/workspaces.ts): existence before
        // visibility, then the published face.
        const workspace = repos.workspaces.get(testCase.id);
        let status: number;
        let body: unknown;
        if (!workspace) {
          status = 404;
          body = { error: 'workspace not found' };
        } else if (!canViewWorkspace(ctx, VIEWER, workspace.id)) {
          status = 403;
          body = { error: 'forbidden' };
        } else {
          status = 200;
          const face = toViewerWorkspace(workspace);
          // The face is a valid instance of the published contract before it is
          // held to the fixture the Rust projector must also match.
          body = { workspace: ViewerWorkspaceDtoSchema.parse(face) };
        }

        expect({ status, body }, testCase.name).toEqual(testCase.expected);
      }
    } finally {
      db.close();
    }
  });
});
