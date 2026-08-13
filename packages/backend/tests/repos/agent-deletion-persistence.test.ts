import { describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import {
  createSqliteAgentDeletionMarkerReadPort,
  createSqliteAgentTeardownPersistence,
} from '../../src/repos/agent-teardown-persistence.js';
import { openTestDb } from '../utils/db.js';

function fixture() {
  const { db, localHostId } = openTestDb();
  const agents = new AgentRepo(db);
  const persistence = createSqliteAgentTeardownPersistence(db);
  const create = (name: string) =>
    agents.create({ name, runtime: 'claude' }, localHostId, 'local');
  return { db, localHostId, agents, persistence, create };
}

describe('agent deletion lifecycle persistence', () => {
  it('prepares a marker-only boolean projection for the mutator hot path', () => {
    const { db } = openTestDb();
    const prepare = vi.spyOn(db, 'prepare');
    createSqliteAgentDeletionMarkerReadPort(db);
    const sql = String(prepare.mock.calls.at(-1)?.[0]);
    expect(sql).toContain('SELECT 1 AS present');
    expect(sql).toContain('deletion_started_at IS NOT NULL');
    expect(sql).not.toContain('SELECT *');
  });

  it('conditionally begins once, lists the durable attempt and CAS-completes it', () => {
    const t = fixture();
    const agent = t.create('delete-once');
    const startedAt = 1_234;

    expect(t.persistence.deletion.begin(agent.id, startedAt)).toEqual({
      kind: 'started',
      attempt: {
        agentId: agent.id,
        hostId: t.localHostId,
        deletionStartedAt: startedAt,
      },
    });
    expect(t.persistence.deletion.begin(agent.id, 9_999)).toEqual({
      kind: 'alreadyPending',
      attempt: {
        agentId: agent.id,
        hostId: t.localHostId,
        deletionStartedAt: startedAt,
      },
    });
    expect(t.persistence.deletion.listPending()).toContainEqual({
      agentId: agent.id,
      hostId: t.localHostId,
      deletionStartedAt: startedAt,
    });

    expect(
      t.persistence.deletion.complete({
        agentId: agent.id,
        hostId: t.localHostId,
        deletionStartedAt: startedAt + 1,
      }),
    ).toEqual({ kind: 'attemptLost' });
    expect(t.agents.get(agent.id)).not.toBeNull();

    expect(
      t.persistence.deletion.complete({
        agentId: agent.id,
        hostId: t.localHostId,
        deletionStartedAt: startedAt,
      }).kind,
    ).toBe('committed');
    expect(t.agents.get(agent.id)).toBeNull();
  });

  it('begin and runtime-transition admission are mutually exclusive', () => {
    const t = fixture();
    const switching = t.create('switching-first');
    expect(t.agents.beginRuntimeTransition(switching.id, 'codex')).toBe('started');
    expect(t.persistence.deletion.begin(switching.id, 1)).toEqual({
      kind: 'runtimeTransitionInProgress',
    });

    const deleting = t.create('deleting-first');
    expect(t.persistence.deletion.begin(deleting.id, 2).kind).toBe('started');
    expect(t.agents.beginRuntimeTransition(deleting.id, 'codex')).toBe(
      'deleting',
    );
  });

  it('begin accepts only active rows and never clears a failed-forward marker', () => {
    const t = fixture();
    const pending = t.agents.reserveForMaterialize(
      { name: 'still-materializing', runtime: 'claude' },
      t.localHostId,
      'local',
      'pending-delete-test',
    );
    expect(t.persistence.deletion.begin(pending.id, 1)).toEqual({
      kind: 'notActive',
    });
    expect(t.persistence.deletion.begin('missing', 1)).toEqual({
      kind: 'notFound',
    });

    const active = t.create('terminal-marker');
    expect(t.persistence.deletion.begin(active.id, 77).kind).toBe('started');
    expect(t.persistence.read.isDeletionPending(active.id)).toBe(true);
    expect(t.agents.get(active.id)?.deletion_started_at).toBe(77);
  });
});
