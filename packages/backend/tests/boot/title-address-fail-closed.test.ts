/**
 * Boot REFUSES to compose a server on a database whose title addresses are
 * half-written (#task:2016).
 *
 * The audit itself is a pure function with its own unit tests, and every defect
 * class is fault-injected in `tests/conversation-title-address-migration.test.ts`.
 * What is unprovable from those is the thing an operator depends on: that a
 * defect stops the process BEFORE it serves. A detector wired to a `warn` line is
 * indistinguishable, from the outside, from no detector at all — the failure it
 * exists to prevent is a MISDELIVERY, which produces no error anywhere.
 *
 * So the falsifier is not "an error was thrown". It is that boot NEVER BECAME
 * READY: no `backend listening`, and the handle the boot opened is closed, so a
 * repair — or `silverhand-server admin scan-title-addresses` — meets an unlocked
 * file. Both are asserted on the log the boot actually wrote rather than by
 * probing the port, because a port probe races the very listener whose absence is
 * the claim.
 *
 * The defect is seeded through `testHooks.onDatabaseOpened`, which fires after
 * migrations and before the audit — the one window in which a database can hold
 * a half-state the production writer cannot produce. Raw SQL is the only way to
 * produce one, which is the point of the branded pair.
 *
 * The clean-database control is not decoration: without it, a harness that
 * failed to boot for any unrelated reason (a bad seed, a missing column, a
 * changed option) would read as a passing fail-closed proof.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { resolveBackendDataPaths } from '@silverhand/shared/app-data-layout';
import type { ServerConfig } from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../../src/index.js';
import type { BackendLogger } from '../../src/context.js';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: unknown;
  msg: string | undefined;
}

function collectLogger(): { logger: BackendLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: BackendLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
  return { logger, entries };
}

function makeServerConfig(): ServerConfig {
  return {
    mode: 'remote',
    url: 'http://127.0.0.1:0',
    auth_token: 'e'.repeat(32),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
}

/**
 * One workspace placement, written by SQL rather than by `ConversationRepo`.
 *
 * `titleKey` is a parameter and not derived, which is the whole fixture: the
 * repository cannot be asked for a row whose key disagrees with its title, so a
 * test that wants one has to write both columns itself.
 */
function seedWorkspaceConversation(
  db: Db,
  args: { readonly title: string; readonly titleKey: string },
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, name_key, description, owner_agent_id, archived_at,
        created_at, updated_at)
     VALUES ('w_fc', 'fail-closed', 'fail-closed', NULL, NULL, NULL, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, placement_kind, roster_policy, title,
        title_key, status, spawned_by_agent_id, closed_at, close_summary,
        pinned_at, created_at, updated_at, archived_at, latest_message_seq,
        visibility)
     VALUES ('cFailClosed0001', 'w_fc', 'workspace', 'open', @title,
             @title_key, 'idle', NULL, NULL, NULL, NULL, 1, 1, NULL, 0,
             'private')`,
  ).run({ title: args.title, title_key: args.titleKey });
}

describe('startBackend — title address defects fail closed (#task:2016)', () => {
  let running: RunningBackend | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    if (running) {
      await running.close().catch(() => undefined);
      running = null;
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it('refuses to become ready when a conversation shows one name and answers to another', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-title-fail-closed-'));
    const { logger, entries } = collectLogger();
    let handle: Db | undefined;

    await expect(
      startBackend({
        mode: 'standalone',
        dbPath: join(tmp, 'silverhand.db'),
        ...resolveBackendDataPaths(tmp),
        serverConfig: makeServerConfig(),
        authConfig: { signupEnabled: false, sessionTtlMs: 1_000 * 60 * 60 * 24 },
        logger,
        listen: { hostname: '127.0.0.1', port: 0 },
        testHooks: {
          onDatabaseOpened: db => {
            handle = db;
            // Shows `Renamed`, answers to `design`: a resolver on this database
            // routes a message typed as `design` to a channel nobody named that.
            seedWorkspaceConversation(db, {
              title: 'Renamed',
              titleKey: 'design',
            });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'conversation_title_address_defects' });

    // Never became ready. Asserted on the boot's own log because the listener's
    // absence cannot be proven by failing to connect to a port that was never
    // chosen.
    expect(
      entries.filter(e => e.msg === 'backend listening'),
    ).toHaveLength(0);

    // The handle is released, so the operator's next move — repair, or the
    // read-only admin scan — is not blocked by the process that refused.
    expect(handle).toBeDefined();
    expect(handle!.open).toBe(false);

    const refusal = entries.find(
      e => e.level === 'error' && e.msg?.startsWith('title address defects:'),
    );
    expect(refusal?.msg).toContain('stale_key');
    expect(refusal?.obj).toMatchObject({
      scanned: 1,
      defects: 1,
      kinds: ['stale_key'],
      remediation: 'silverhand-server admin scan-title-addresses',
    });
  });

  it('boots the same fixture when the pair agrees, so the refusal is the defect and not the harness', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-title-fail-closed-clean-'));
    const { logger, entries } = collectLogger();

    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: false, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      logger,
      listen: { hostname: '127.0.0.1', port: 0 },
      testHooks: {
        onDatabaseOpened: db => {
          seedWorkspaceConversation(db, {
            title: 'Design',
            titleKey: 'design',
          });
        },
      },
    });

    expect(running.context.readiness.listenReady).toBe(true);
    expect(entries.filter(e => e.msg === 'backend listening')).toHaveLength(1);
    // A clean database says nothing at boot — the positive answer is the admin
    // command's job — so the only assertion available is silence.
    expect(
      entries.filter(e => e.msg?.includes('title address')),
    ).toHaveLength(0);
  });

  it('also refuses before ready when a regular workspace shows one root and answers to another', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-workspace-fail-closed-'));
    const { logger, entries } = collectLogger();
    let handle: Db | undefined;

    await expect(startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: false, sessionTtlMs: 86_400_000 },
      logger,
      listen: { hostname: '127.0.0.1', port: 0 },
      testHooks: {
        onDatabaseOpened: db => {
          handle = db;
          db.prepare(
            `INSERT INTO workspaces
               (id, name, name_key, description,
                owner_agent_id, archived_at, created_at, updated_at)
             VALUES ('w_bad', 'Renamed', 'design', NULL,
                     NULL, NULL, 1, 1)`,
          ).run();
        },
      },
    })).rejects.toMatchObject({ code: 'workspace_name_address_defects' });

    expect(entries.filter(entry => entry.msg === 'backend listening')).toHaveLength(0);
    expect(handle?.open).toBe(false);
    expect(entries.find(entry => entry.level === 'error'
      && entry.msg === 'workspace address integrity audit failed')?.obj).toMatchObject({
      scanned: 1,
      defects: 1,
      kinds: ['stale_key'],
      remediation: 'silverhand-server admin scan-workspace-addresses',
    });
  });
});
