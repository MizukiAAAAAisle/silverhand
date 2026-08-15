import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fixedConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

describe('AgentRepo', () => {
  it('create defaults to provided host_id when input omits it', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);

    const agent = repo.create(
      { name: 'alice', runtime: 'claude' },
      localHostId,
      'local',
    );
    expect(agent.host_id).toBe(localHostId);
    expect(agent.runtime).toBe('claude');
    expect(agent.model).toBeNull();
    expect(agent.description).toBeNull();
    expect(agent.created_by_user_id).toBe('local');
  });

  it('create honors explicit host_id, model, and description', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);

    const agent = repo.create(
      {
        name: 'bob',
        runtime: 'claude',
        model: 'claude-sonnet-4-6',
        description: 'reviewer',
        host_id: localHostId,
      },
      localHostId,
      'local',
    );
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.description).toBe('reviewer');
  });

  it('list orders by created_at ASC; getByName resolves; delete removes', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);

    const a = repo.create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
    const b = repo.create({ name: 'b', runtime: 'claude' }, localHostId, 'local');
    const list = repo.list();
    expect(list.map(x => x.id)).toEqual([a.id, b.id]);

    expect(repo.getByName('a')?.id).toBe(a.id);

    repo.delete(a.id);
    expect(repo.get(a.id)).toBeNull();
    expect(repo.list().map(x => x.id)).toEqual([b.id]);
  });

  it('create defaults display_name to name and reasoning_effort to null', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const a = repo.create({ name: 'alice', runtime: 'codex' }, localHostId, 'local');
    expect(a.display_name).toBe('alice');
    expect(a.reasoning_effort).toBeNull();
    expect(a.fast_mode).toBeNull();
  });

  it('round-trips fast_mode boolean through SQLite as a real boolean', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);

    const enabled = repo.create(
      { name: 'fast-on', runtime: 'codex', fast_mode: true },
      localHostId,
      'local',
    );
    expect(enabled.fast_mode).toBe(true);

    const disabled = repo.create(
      { name: 'fast-off', runtime: 'codex', fast_mode: false },
      localHostId,
      'local',
    );
    expect(disabled.fast_mode).toBe(false);

    const cleared = repo.update(enabled.id, { fast_mode: null })!;
    expect(cleared.fast_mode).toBeNull();
  });

  it('update only writes provided keys; bumps updated_at', async () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const a = repo.create(
      { name: 'alice', runtime: 'claude', model: 'sonnet' },
      localHostId,
      'local',
    );
    // small delay so updated_at is observably newer
    await new Promise(r => setTimeout(r, 5));
    const updated = repo.update(a.id, { display_name: 'Alice 🌸' })!;
    expect(updated.display_name).toBe('Alice 🌸');
    expect(updated.model).toBe('sonnet'); // untouched
    expect(updated.runtime).toBe('claude');
    expect(updated.updated_at).toBeGreaterThan(a.updated_at);
  });

  it('update returns null on unknown id', () => {
    const { db } = openTestDb();
    const repo = new AgentRepo(db);
    expect(repo.update('does-not-exist', { display_name: 'x' })).toBeNull();
  });

  it('update can null out model / description / reasoning_effort', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const a = repo.create(
      { name: 'a', runtime: 'codex', model: 'o1', description: 'x' },
      localHostId,
      'local',
    );
    const u = repo.update(a.id, { model: null, description: null })!;
    expect(u.model).toBeNull();
    expect(u.description).toBeNull();
  });

  it('runtime transition is compare-and-set and commits runtime+tuning atomically', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const agent = repo.create(
      { name: 'switcher', runtime: 'claude', model: 'sonnet' },
      localHostId,
      'local',
    );

    expect(() =>
      db.prepare(
        'UPDATE agents SET runtime_transition_started_at = 1 WHERE id = ?',
      ).run(agent.id),
    ).toThrow(/runtime transition lock must be a pair/i);

    expect(repo.beginRuntimeTransition(agent.id, 'codex', 123)).toBe('started');
    expect(repo.beginRuntimeTransition(agent.id, 'qoder', 456)).toBe('in_progress');
    expect(repo.getRow(agent.id)).toMatchObject({
      runtime: 'claude',
      model: 'sonnet',
      runtime_transition_target: 'codex',
      runtime_transition_started_at: 123,
    });

    const updated = repo.completeRuntimeTransition(agent.id, {
      runtime: 'codex',
      model: 'gpt-5-codex',
      reasoning_effort: 'xhigh',
      fast_mode: false,
    });
    expect(updated).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5-codex',
      reasoning_effort: 'xhigh',
      fast_mode: false,
    });
    expect(repo.getRow(agent.id)).toMatchObject({
      runtime_transition_target: null,
      runtime_transition_started_at: null,
    });
  });

  it('boot recovery clears stale transition locks without changing runtime', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    const agent = repo.create(
      { name: 'stale-switch', runtime: 'claude' },
      localHostId,
      'local',
    );
    expect(repo.beginRuntimeTransition(agent.id, 'codex')).toBe('started');

    expect(repo.clearStaleRuntimeTransitions()).toBe(1);
    expect(repo.getRow(agent.id)).toMatchObject({
      runtime: 'claude',
      runtime_transition_target: null,
      runtime_transition_started_at: null,
    });
  });

  it('create rejects an unknown user id (FK to users.id)', () => {
    const { db, localHostId } = openTestDb();
    const repo = new AgentRepo(db);
    expect(() =>
      repo.create({ name: 'orphan', runtime: 'claude' }, localHostId, 'no-such-user'),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('AgentRepo.listRuntimeConversations — archived scoping (#task:1398)', () => {
  // `excludeArchived` is a DISPLAY-only scope (the agent Activity roster hides
  // archived channels). The default (no flag) must stay COMPLETE so control-plane
  // callers — Stop-all + delete-agent purge — can still reach a runtime left in
  // an archived channel (archive-stop is best-effort/async, may fail when the
  // host is offline). This test locks both halves of that contract.
  function seed() {
    const { db, localHostId } = openTestDb();
    const tmp = makeTempSilverhandDir();
    const repo = new AgentRepo(db);
    const conversations = new ConversationRepo(db);
    const workspaces = new WorkspaceRepo(db);
    const agent = repo.create(
      { name: 'alice', runtime: 'claude' },
      localHostId,
      'local',
    );
    const workspace = workspaces.insert({
      name: 'eng',
      description: null,
    });
    workspaces.insertMembership(workspace.id, agent.id);
    const live = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('live'),
    });
    const archived = conversations.insertChannel({
      workspaceId: workspace.id,
      title: fixedConversationTitle('archived'),
    });
    conversations.addAgent(live.id, agent.id);
    conversations.addAgent(archived.id, agent.id);
    conversations.setArchived(archived.id, true);
    return { repo, agent, live, archived, cleanup: tmp.cleanup };
  }

  it('default view includes archived channels (control-plane completeness)', () => {
    const t = seed();
    try {
      const ids = t.repo
        .listRuntimeParticipations(t.agent.id)
        .map(r => r.conversation_id);
      expect(new Set(ids)).toEqual(new Set([t.live.id, t.archived.id]));
    } finally {
      t.cleanup();
    }
  });

  it('excludeArchived drops archived channels (display roster)', () => {
    const t = seed();
    try {
      const ids = t.repo
        .listRuntimeParticipations(t.agent.id, { excludeArchived: true })
        .map(r => r.conversation_id);
      expect(ids).toEqual([t.live.id]);
    } finally {
      t.cleanup();
    }
  });
});
