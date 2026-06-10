import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import type { Database as Db } from 'better-sqlite3';

/**
 * Open an in-memory SQLite + run migrations + bootstrap the 'local'
 * host (matches what `startBackend` does). Tests get a fresh DB per
 * call so they're independent.
 *
 * Production identity model (post pre-ship rewrite): the `users` table
 * is empty after migrations and `app_settings.viewer_user_id` is unset.
 * The renderer hits the auth gate; tests would have to sign up / log in
 * for every test.
 *
 * Test fixture compatibility: 50+ pre-rewrite route tests assume a
 * registered viewer with id `'local'`. To keep them working without
 * per-test registration calls, this helper INSERTs a fixed set of
 * **test fixture registered users** (NOT a product fallback). The HTTP
 * test helper sends an explicit legacy user header by default; tests
 * that need the registration-required state should override that header
 * to an empty value and/or wipe the legacy settings pointer.
 */
export interface OpenTestDbOptions {
  /**
   * Legacy compatibility mode for pre-v25 route/repo tests that create
   * workspaces/conversations directly. Disable this in permission-sensitive
   * tests so membership rows must come from the same route/service surfaces
   * production uses.
   */
  seedAllFixtureMemberships?: boolean;
}

export function openTestDb(options: OpenTestDbOptions = {}): {
  db: Db;
  localHostId: string;
  /** The viewer id resolved by the principal middleware in this
   *  fixture. Always `'local'` — the test fixture registered user. */
  viewerUserId: string;
  /** Legacy fixture user id used by pre-PR1 tests. Always `'local'`. */
  legacyTestUserId: string;
} {
  const db = openDatabase(':memory:');
  const local = new HostRepo(db).ensureLocal();

  // Insert test fixture registered users. These are NOT auto-seeded
  // by the migration (the post-rewrite migration leaves `users`
  // empty); they are inserted here purely to keep pre-rewrite route
  // tests compatible. Names end in `-test` so they cannot collide
  // with `agents.name` rows via the cross-namespace uniqueness
  // trigger. The id literal `'local'` is reserved as the primary
  // viewer for these tests.
  const now = Date.now();
  const fixtureUsers: Array<{ id: string; name: string; display: string }> = [
    { id: 'local', name: 'local-test', display: 'Local Test User' },
    { id: 'alice', name: 'alice-test', display: 'Alice Test User' },
    { id: 'bob', name: 'bob-test', display: 'Bob Test User' },
    { id: 'carol', name: 'carol-test', display: 'Carol Test User' },
    { id: 'teammate', name: 'teammate-test', display: 'Teammate' },
    { id: 'other', name: 'other-test', display: 'Other Test User' },
    { id: 'someone', name: 'someone-test', display: 'Someone' },
    { id: 'someone-else', name: 'someone-else-test', display: 'Someone Else' },
  ];
  const insertUser = db.prepare(
    `INSERT INTO users (id, name, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const u of fixtureUsers) {
    insertUser.run(u.id, u.name, u.display, now, now);
  }

  // Keep a stale legacy viewer pointer in the fixture so tests prove
  // current viewer resolution does not depend on it. Production no
  // longer writes this key on auth/signup/bootstrap paths.
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('viewer_user_id', 'local')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();

  const seedAllFixtureMemberships = options.seedAllFixtureMemberships ?? true;

  // v25 test-fixture compatibility: production permission gates now
  // require explicit `workspace_users` / `conversation_users`
  // membership for human principals. Production code adds the viewer
  // through routes/services (POST /api/workspaces, ChannelService,
  // ThreadService, createAgentWithHome). Many tests bypass those
  // surfaces and create workspaces/conversations directly via repos —
  // they would otherwise lose user access. These triggers snapshot
  // ALL fixture users into membership on every workspace/conversation
  // insert so direct-repo tests keep working without per-test
  // boilerplate. Routes-driven tests still pass because the explicit
  // route inserts are `INSERT OR IGNORE`.
  if (seedAllFixtureMemberships) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS test_seed_workspace_users
      AFTER INSERT ON workspaces
      BEGIN
        INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
        SELECT NEW.id, u.id, NEW.created_at,
               CASE WHEN u.id = (SELECT value FROM app_settings WHERE key = 'viewer_user_id')
                    THEN 'owner' ELSE 'member' END
          FROM users u;
      END;

      CREATE TRIGGER IF NOT EXISTS test_seed_conversation_users
      AFTER INSERT ON conversations
      BEGIN
        INSERT OR IGNORE INTO conversation_users (conversation_id, user_id, joined_at)
        SELECT NEW.id, u.id, NEW.created_at FROM users u;
      END;
    `);
  }

  return {
    db,
    localHostId: local.id,
    viewerUserId: 'local',
    legacyTestUserId: 'local',
  };
}

/**
 * Disposable workspace root for tests that touch the filesystem
 * (provisionChannel, spawn-prep, etc). Caller should pass `cleanup()`
 * to `afterEach` / `afterAll`.
 */
export function makeTempSilverhandDir(): {
  silverhandDir: string;
  workspacesRoot: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-test-'));
  const workspacesRoot = join(dir, 'workspaces');
  return {
    silverhandDir: dir,
    workspacesRoot,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
