import { fixedWorkspaceName } from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite, { type Database } from 'better-sqlite3';
import { migrations } from '@silverhand/shared/db/migrations';
import { MIN_SUPPORTED_MIGRATION_STEP } from '@silverhand/shared/db/schema-epochs';
import { fixedConversationTitle } from '@silverhand/shared';
import { currentMigrationStep, runMigrations } from '../src/db.js';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../src/repos/runtime-slot-repo.js';
import { WorkspaceRepo } from '../src/repos/workspace-repo.js';
import { openTestDb } from './utils/db.js';

describe('migration v77 agent_runtime_control_audit', () => {
  let db: Database | null = null;
  afterEach(() => {
    db?.close();
    db = null;
  });

  it('upgrades the reviewed v76 schema through only v77', () => {
    const database = new Sqlite(':memory:');
    db = database;
    const throughV76 = migrations.filter(migration => migration.version <= 76);
    const initial = runMigrations(database, {
      migrations: throughV76,
      expectedStep: 76,
      minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
    });
    expect(initial.afterStep).toBe(76);
    expect(currentMigrationStep(database)).toBe(76);

    const schemaNamesBefore = new Set(
      database
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
            WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
        )
        .all()
        .map(row => row.name),
    );
    const upgraded = runMigrations(database, {
      migrations: migrations.filter(migration => migration.version <= 77),
      expectedStep: 77,
      minimumSupportedStep: MIN_SUPPORTED_MIGRATION_STEP,
    });
    expect(upgraded).toMatchObject({
      beforeStep: 76,
      afterStep: 77,
      appliedSteps: [77],
    });
    expect(currentMigrationStep(database)).toBe(77);

    const schemaNamesAfter = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map(row => row.name);
    expect(schemaNamesAfter.filter(name => !schemaNamesBefore.has(name)).sort()).toEqual([
      'agent_runtime_control_events',
      'agent_runtime_control_events_append_only_delete',
      'agent_runtime_control_events_append_only_update',
      'agent_runtime_slots_daemon_claim_generation_bound',
      'idx_agent_runtime_control_events_agent',
    ]);
  });

  it('forbids daemon rebinding inside one generation while allowing a successor claim', () => {
    const fixture = openTestDb();
    db = fixture.db;
    const workspaces = new WorkspaceRepo(fixture.db);
    const conversations = new ConversationRepo(fixture.db);
    const agents = new AgentRepo(fixture.db);
    const slots = new RuntimeSlotRepo(fixture.db);
    const workspace = workspaces.insert({ name: fixedWorkspaceName('claim-lifecycle'), description: null });
    const channel = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('Claim lifecycle'),
    });
    const agent = agents.create(
      { name: 'claim-lifecycle-agent', runtime: 'claude', host_id: fixture.localHostId },
      fixture.localHostId,
      fixture.viewerUserId,
    );
    conversations.addAgent(channel.id, agent.id);
    const scope = {
      kind: 'conversation' as const,
      conversationId: channel.id,
      agentId: agent.id,
    };
    const first = slots.claimGeneration({ scope, daemonInstanceId: 'daemon-a' })!;

    expect(() => fixture.db.prepare(
      `UPDATE agent_runtime_slots
          SET claimed_by_daemon_instance_id = 'daemon-b'
        WHERE id = ?`,
    ).run(first.id)).toThrow(/cannot rebind within a generation/);
    expect(slots.get(scope)?.claimed_by_daemon_instance_id).toBe('daemon-a');

    const successor = slots.claimGeneration({ scope, daemonInstanceId: 'daemon-b' })!;
    expect(successor).toMatchObject({
      generation: first.generation + 1,
      claimed_by_daemon_instance_id: 'daemon-b',
    });
  });

  it('is an append-only agent-level fact with historical coordinates and no conversation axis', () => {
    const database = openTestDb().db;
    db = database;
    const columns = database.pragma(
      'table_info(agent_runtime_control_events)',
    ) as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual([
      'id',
      'agent_id',
      'generation',
      'actor_user_id',
      'reason',
      'was_running',
      'previous_cli_session_id_prefix',
      'occurred_at',
    ]);
    expect(database.pragma('foreign_key_list(agent_runtime_control_events)')).toEqual([]);

    const insert = database.prepare(
      `INSERT INTO agent_runtime_control_events (
         agent_id, generation, actor_user_id, reason, was_running,
         previous_cli_session_id_prefix, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // Historical ids need not resolve to live rows: deleting an Agent or actor
    // must not erase or block the audit fact.
    expect(insert.run(
      'deleted-agent',
      3,
      'deleted-actor',
      'session_cleared',
      1,
      'session-',
      1234,
    ).changes).toBe(1);
    expect(() => insert.run(
      'agent', 3, 'actor', 'runtime_exited', 1, null, 1234,
    )).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(
      'agent', 3, null, 'session_cleared', 1, null, 1234,
    )).toThrow(/NOT NULL constraint failed/);

    const row = database.prepare(
      'SELECT * FROM agent_runtime_control_events WHERE agent_id = ?',
    ).get('deleted-agent') as Record<string, unknown>;
    expect(row).toMatchObject({
      generation: 3,
      actor_user_id: 'deleted-actor',
      reason: 'session_cleared',
      was_running: 1,
      previous_cli_session_id_prefix: 'session-',
    });
    expect(() => database.prepare(
      `UPDATE agent_runtime_control_events SET occurred_at = 0 WHERE id = ?`,
    ).run(row.id)).toThrow(/agent_runtime_control_events is append-only/);
    expect(() => database.prepare(
      `DELETE FROM agent_runtime_control_events WHERE id = ?`,
    ).run(row.id)).toThrow(/agent_runtime_control_events is append-only/);
  });
});
