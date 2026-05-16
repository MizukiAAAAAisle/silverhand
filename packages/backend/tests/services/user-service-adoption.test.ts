import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared';
import { runMigrations } from '../../src/db.js';
import { UserService } from '../../src/services/user-service.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { makeTempSilverhandDir } from '../utils/db.js';

/**
 * Deferred Adoption tests for the v21 → POST /api/register bridge.
 *
 * Migration v21 stages pre-v21 user-owned facts into four
 * `legacy_*_v21` holding tables; `UserService.register()` consumes
 * them in the same transaction that creates the first registered
 * viewer, rewriting legacy ids to the new viewer's id. After
 * successful registration the staging tables are dropped and an
 * audit row is written to `app_settings`.
 *
 * These tests build a v20-shape DB seeded with realistic dirty data,
 * run all migrations to v22 (which puts staging tables in place),
 * register a viewer, and assert the post-state.
 */

/**
 * Open an in-memory DB at exactly migration `version` (no migrations
 * past `version` are applied). Lifted from db-migrations.test.ts so
 * adoption tests can prepare a v20 DB and seed dirty data before v21
 * stages it.
 */
function openDbAt(version: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of migrations) {
    if (migration.version > version) break;
    const apply = () => {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name, Date.now());
    };
    if (migration.foreignKeyEscape) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
    } else {
      db.transaction(apply)();
    }
  }
  return db;
}

interface AdoptionFixture {
  db: Database.Database;
  service: UserService;
  cleanup: () => void;
}

/**
 * Build a v20 DB, seed dirty user-owned legacy data, then run all
 * migrations so the staging tables are populated. Returns a
 * `UserService` ready to call `register()`.
 *
 * Optional `seed` lets each test customize the dirty data shape.
 */
function buildAdoptionFixture(
  seed?: (db: Database.Database, now: number) => void,
): AdoptionFixture {
  const db = openDbAt(20);
  const now = 1_700_000_000_000;
  // Common fixtures every adoption test needs: a host + workspace +
  // conversation so the FK rebuilds in v21 don't trip.
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at)
    VALUES ('host_local', 'local', 'local', ${now});

    INSERT INTO workspaces
      (id, name, description, workspace_kind, workspace_path, workspace_host_id,
       owner_agent_id, archived_at, pinned_at, created_at, updated_at)
    VALUES
      ('ws_main', 'Main', NULL, 'regular', '/tmp/ws_main', 'host_local',
       NULL, NULL, NULL, ${now}, ${now});

    INSERT INTO conversations
      (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
       status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
       archived_at, created_at, updated_at)
    VALUES
      ('conv_main', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'general',
       'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});
  `);
  if (seed) seed(db, now);
  // Now run the rest of the migrations (v21 onwards) against the dirty
  // pre-v21 data — staging tables should capture the legacy refs.
  runMigrations(db);

  const tmp = makeTempSilverhandDir();
  const blobStorage = createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir });
  const service = new UserService({
    db,
    users: new UserRepo(db),
    blobStorage,
  });

  return {
    db,
    service,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      tmp.cleanup();
    },
  };
}

describe('UserService.register() — Deferred Adoption', () => {
  let f: AdoptionFixture | null = null;
  afterEach(() => {
    f?.cleanup();
    f = null;
  });

  it('on a fresh DB (no pre-v21 data) registration succeeds with all-zero adoption counts', () => {
    f = buildAdoptionFixture(); // No seed — staging tables exist but empty.
    const dto = f.service.register({ name: 'shiki', display_name: 'Shiki' });
    expect(dto.name).toBe('shiki');
    expect(dto.display_name).toBe('Shiki');

    // Audit row: completed_at written, counts all zero.
    const completed = f.db
      .prepare<[], { value: string }>(
        `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_completed_at'`,
      )
      .get();
    expect(completed?.value).toBeDefined();
    expect(Number.parseInt(completed!.value, 10)).toBeGreaterThan(0);

    const counts = f.db
      .prepare<[], { value: string }>(
        `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_counts'`,
      )
      .get();
    expect(JSON.parse(counts!.value)).toEqual({
      messages_from: 0,
      messages_task: 0,
      conversation_reads: 0,
      attachments: 0,
    });

    // Staging tables dropped.
    const remaining = f.db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'legacy_%_v21'`,
      )
      .all();
    expect(remaining).toEqual([]);
  });

  it('rewrites legacy message attribution only for originally-non-null rows', () => {
    f = buildAdoptionFixture((db, now) => {
      db.exec(`
        INSERT INTO agents
          (id, name, runtime, model, host_id, description, created_at, updated_at,
           display_name, reasoning_effort, fast_mode)
        VALUES
          ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, ${now}, ${now},
           'Alice', NULL, NULL);

        INSERT INTO messages
          (id, conversation_id, from_kind, from_agent_id, from_user_id, content,
           metadata, seq, created_at, task_number, task_status,
           task_assignee_agent_id, task_assignee_user_id, task_title,
           task_workspace_id)
        VALUES
          -- user message with from_user_id='local' → adopt
          ('msg_user_a', 'conv_main', 'user', NULL, 'local', 'hi',
           NULL, 1, ${now}, NULL, NULL, NULL, NULL, NULL, NULL),
          -- user message with from_user_id='teammate' → adopt (V1 single-viewer)
          ('msg_user_b', 'conv_main', 'user', NULL, 'teammate', 'hello',
           NULL, 2, ${now + 1}, NULL, NULL, NULL, NULL, NULL, NULL),
          -- agent message with from_user_id IS NULL → stays NULL
          ('msg_agent', 'conv_main', 'agent', 'agent_alice', NULL, 'hey',
           NULL, 3, ${now + 2}, NULL, NULL, NULL, NULL, NULL, NULL),
          -- task message with task_assignee_user_id='local' → adopt
          ('msg_task_a', 'conv_main', 'user', NULL, 'local', 'do thing',
           NULL, 4, ${now + 3}, 1, 'todo', NULL, 'local', 'task A', 'ws_main'),
          -- task message with task_assignee_user_id='teammate' → adopt
          ('msg_task_b', 'conv_main', 'user', NULL, 'local', 'do other',
           NULL, 5, ${now + 4}, 2, 'todo', NULL, 'teammate', 'task B', 'ws_main'),
          -- task message with no user assignee → stays NULL
          ('msg_task_unassigned', 'conv_main', 'user', NULL, 'local', 'unassigned',
           NULL, 6, ${now + 5}, 3, 'todo', NULL, NULL, 'task C', 'ws_main');
      `);
    });

    const dto = f.service.register({ name: 'shiki', display_name: 'Shiki' });

    // All originally-user-attributed messages now point at viewer.
    const userMsgs = f.db
      .prepare<[], { id: string; from_user_id: string | null }>(
        `SELECT id, from_user_id FROM messages
          WHERE id IN ('msg_user_a','msg_user_b','msg_agent') ORDER BY id`,
      )
      .all();
    expect(userMsgs).toEqual([
      { id: 'msg_agent',  from_user_id: null },
      { id: 'msg_user_a', from_user_id: dto.id },
      { id: 'msg_user_b', from_user_id: dto.id },
    ]);

    // Task assignees: only originally-non-null rows adopted; the
    // unassigned task stays NULL (review #3 — never over-claim).
    const taskMsgs = f.db
      .prepare<[], { id: string; task_assignee_user_id: string | null }>(
        `SELECT id, task_assignee_user_id FROM messages
          WHERE task_number IS NOT NULL ORDER BY id`,
      )
      .all();
    expect(taskMsgs).toEqual([
      { id: 'msg_task_a', task_assignee_user_id: dto.id },
      { id: 'msg_task_b', task_assignee_user_id: dto.id },
      { id: 'msg_task_unassigned', task_assignee_user_id: null },
    ]);

    // Audit counts reflect what was rewritten.
    const counts = JSON.parse(
      (f.db
        .prepare<[], { value: string }>(
          `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_counts'`,
        )
        .get())!.value,
    );
    expect(counts.messages_from).toBe(5);
    expect(counts.messages_task).toBe(2);
  });

  it('merges duplicate legacy conversation_reads to a single viewer row using MAX(last_read_seq, read_at)', () => {
    f = buildAdoptionFixture((db, now) => {
      db.exec(`
        INSERT INTO conversations
          (id, workspace_id, workspace_path, kind, parent_conversation_id, title,
           status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
           archived_at, created_at, updated_at)
        VALUES
          ('conv_other', 'ws_main', '/tmp/ws_main', 'channel', NULL, 'other',
           'idle', NULL, NULL, NULL, NULL, NULL, ${now}, ${now});

        INSERT INTO conversation_reads
          (user_id, conversation_id, last_read_seq, read_at)
        VALUES
          -- two legacy ids pointing at the same conversation: must
          -- collapse into a single row keyed on the new viewer id,
          -- with MAX(last_read_seq) and MAX(read_at).
          ('local',    'conv_main', 5, ${now + 100}),
          ('teammate', 'conv_main', 7, ${now + 50}),
          -- legacy id pointing at another conversation: separate row.
          ('local',    'conv_other', 3, ${now + 10});
      `);
    });

    const dto = f.service.register({ name: 'shiki' });

    const reads = f.db
      .prepare<[], {
        user_id: string;
        conversation_id: string;
        last_read_seq: number;
        read_at: number;
      }>(`SELECT user_id, conversation_id, last_read_seq, read_at
            FROM conversation_reads ORDER BY conversation_id`)
      .all();
    expect(reads).toEqual([
      // V1 single-viewer merge: most-permissive read marker wins.
      // last_read_seq=MAX(5,7)=7; read_at=MAX(now+100, now+50)=now+100.
      {
        user_id: dto.id,
        conversation_id: 'conv_main',
        last_read_seq: 7,
        read_at: 1_700_000_000_100,
      },
      {
        user_id: dto.id,
        conversation_id: 'conv_other',
        last_read_seq: 3,
        read_at: 1_700_000_000_010,
      },
    ]);

    const counts = JSON.parse(
      (f.db
        .prepare<[], { value: string }>(
          `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_counts'`,
        )
        .get())!.value,
    );
    // INSERT changes count: 2 conversations × 1 viewer-merged row.
    expect(counts.conversation_reads).toBe(2);
  });

  it('re-INSERTs legacy user-kind attachments with viewer as the owner', () => {
    f = buildAdoptionFixture((db, now) => {
      db.exec(`
        INSERT INTO agents
          (id, name, runtime, model, host_id, description, created_at, updated_at,
           display_name, reasoning_effort, fast_mode)
        VALUES
          ('agent_alice', 'alice', 'claude', NULL, 'host_local', NULL, ${now}, ${now},
           'Alice', NULL, NULL);

        INSERT INTO attachments
          (id, channel_id, source_conversation_id, filename, size,
           content_type, storage, storage_key, created_by_kind, created_by_id,
           created_at)
        VALUES
          -- user attachment: must be re-INSERTed pointing at viewer.
          ('att_user_a', 'conv_main', 'conv_main', 'photo.jpg', 1024,
           'image/jpeg', 'local', 'attachments/photo.jpg', 'user', 'local', ${now}),
          ('att_user_b', 'conv_main', 'conv_main', 'doc.pdf', 2048,
           'application/pdf', 'local', 'attachments/doc.pdf', 'user', 'teammate', ${now + 1}),
          -- agent attachment: untouched, stays in main attachments.
          ('att_agent',  'conv_main', 'conv_main', 'gen.png', 512,
           'image/png', 'local', 'attachments/gen.png', 'agent', 'agent_alice', ${now + 2});
      `);
    });

    const dto = f.service.register({ name: 'shiki' });

    const atts = f.db
      .prepare<[], {
        id: string;
        filename: string;
        created_by_kind: string;
        created_by_id: string;
      }>(
        `SELECT id, filename, created_by_kind, created_by_id
           FROM attachments ORDER BY id`,
      )
      .all();
    expect(atts).toEqual([
      // Agent row passed through v21 untouched.
      {
        id: 'att_agent',
        filename: 'gen.png',
        created_by_kind: 'agent',
        created_by_id: 'agent_alice',
      },
      // User rows re-INSERTed by adoption with created_by_id = viewerId.
      {
        id: 'att_user_a',
        filename: 'photo.jpg',
        created_by_kind: 'user',
        created_by_id: dto.id,
      },
      {
        id: 'att_user_b',
        filename: 'doc.pdf',
        created_by_kind: 'user',
        created_by_id: dto.id,
      },
    ]);

    const counts = JSON.parse(
      (f.db
        .prepare<[], { value: string }>(
          `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_counts'`,
        )
        .get())!.value,
    );
    expect(counts.attachments).toBe(2);
  });

  it('drops all four staging tables after a successful adoption', () => {
    f = buildAdoptionFixture((db, now) => {
      db.exec(`
        INSERT INTO conversation_reads
          (user_id, conversation_id, last_read_seq, read_at)
        VALUES ('local', 'conv_main', 1, ${now});
      `);
    });

    f.service.register({ name: 'shiki' });

    const remaining = f.db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'legacy_%_v21'
          ORDER BY name`,
      )
      .all();
    expect(remaining).toEqual([]);
  });

  it('a second register() call rejects with already_registered and leaves staging untouched', () => {
    // Fresh DB; first register drops staging on success.
    f = buildAdoptionFixture();

    f.service.register({ name: 'shiki' });

    // Staging is gone after the first successful registration.
    const remainingBefore = f.db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'legacy_%_v21'`,
      )
      .all();
    expect(remainingBefore).toEqual([]);

    // Second call: viewer already registered → 409. Adoption helper
    // is defensive against absent staging, so the throw originates
    // from the already-registered guard, not staging access.
    expect(() => f!.service.register({ name: 'other' })).toThrow(
      /already.registered/i,
    );

    // Audit row from the first run is still there.
    const completed = f.db
      .prepare<[], { value: string }>(
        `SELECT value FROM app_settings WHERE key = 'legacy_v21_adoption_completed_at'`,
      )
      .get();
    expect(completed?.value).toBeDefined();
  });

  it('rolls back atomically when adoption fails (transaction guarantee)', () => {
    f = buildAdoptionFixture((db, now) => {
      db.exec(`
        INSERT INTO conversation_reads
          (user_id, conversation_id, last_read_seq, read_at)
        VALUES ('local', 'conv_main', 1, ${now});
      `);
    });

    // Force a failure mid-adoption by deleting a staging table while
    // also sabotaging the conversations FK referenced by the staging
    // row. Simpler: drop the conversations row that conv_reads depends
    // on so the INSERT INTO conversation_reads fails its FK check.
    f.db.exec(`DELETE FROM conversations WHERE id = 'conv_main'`);

    expect(() => f!.service.register({ name: 'shiki' })).toThrow();

    // No user row, no viewer pointer (transaction rolled back).
    const userCount = f.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM users`)
      .get();
    expect(userCount?.c).toBe(0);

    const pointer = f.db
      .prepare<[], { value: string }>(
        `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
      )
      .get();
    expect(pointer).toBeUndefined();

    // Staging tables still exist with their data — retry possible.
    const stagingReads = f.db
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) as c FROM legacy_conversation_reads_v21`,
      )
      .get();
    expect(stagingReads?.c).toBe(1);
  });
});
