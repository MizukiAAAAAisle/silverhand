import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { MembershipService } from '../../src/services/membership-service.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  // Strip the test-fixture autoseed triggers so each test controls
  // exactly which users / agents are members of the conversation it
  // builds. Without this, every fixture user (8 of them) gets inserted
  // into conversation_users on every channel insert, which would
  // wreck the deterministic order assertions below.
  db.exec(
    `DROP TRIGGER IF EXISTS test_seed_workspace_users;
     DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
  );
  const tmp = makeTempSilverhandDir();
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const service = new MembershipService({ agents, users, conversations });

  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'general',
  });
  return {
    db,
    agents,
    users,
    conversations,
    workspaces,
    workspace,
    channel,
    service,
    cleanup: tmp.cleanup,
    localHostId,
  };
}

describe('MembershipService.listMembers', () => {
  it('returns agents (joined-order) followed by humans (joined-order)', () => {
    const t = bootstrap();
    try {
      const alice = t.agents.create(
        { name: 'alice', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      const bob = t.agents.create(
        { name: 'bob', runtime: 'codex' },
        t.localHostId,
        'local',
      );
      // Add bob first to verify joined-order ASC vs name-order or
      // creation-order: the resulting list must be [bob, alice], not
      // [alice, bob]. Use direct SQL to pin distinct joined_at values
      // so the test isn't flaky when two addAgent / addUser calls land
      // in the same millisecond.
      t.db
        .prepare(
          `INSERT INTO conversation_agents
             (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
           VALUES (?, ?, NULL, NULL, 'idle', ?)`,
        )
        .run(t.channel.id, bob.id, 1000);
      t.db
        .prepare(
          `INSERT INTO conversation_agents
             (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
           VALUES (?, ?, NULL, NULL, 'idle', ?)`,
        )
        .run(t.channel.id, alice.id, 2000);

      t.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
           VALUES (?, ?, ?)`,
        )
        .run(t.channel.id, 'teammate', 1500);
      t.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
           VALUES (?, ?, ?)`,
        )
        .run(t.channel.id, 'local', 2500);

      const members = t.service.listMembers(t.channel.id);
      expect(members.map(m => ({ kind: m.kind, name: m.name }))).toEqual([
        { kind: 'agent', name: 'bob' },
        { kind: 'agent', name: 'alice' },
        { kind: 'human', name: 'teammate-test' },
        { kind: 'human', name: 'local-test' },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('returns the full DTO shape per member kind', () => {
    const t = bootstrap();
    try {
      const alice = t.agents.create(
        { name: 'alice', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      // Patch display_name so the DTO carries something distinct from
      // `name`. Repo doesn't expose updateProfile for agents, so write
      // direct.
      t.db
        .prepare(`UPDATE agents SET display_name = ? WHERE id = ?`)
        .run('Alice (lead)', alice.id);
      t.conversations.addAgent(t.channel.id, alice.id);

      t.conversations.addUser(t.channel.id, 'local');

      const members = t.service.listMembers(t.channel.id);
      expect(members).toEqual([
        {
          kind: 'agent',
          agent_id: alice.id,
          name: 'alice',
          display_name: 'Alice (lead)',
          runtime: 'claude',
        },
        {
          kind: 'human',
          user_id: 'local',
          name: 'local-test',
          display_name: 'Local Test User',
          avatar_url: null,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('returns [] for a conversation with no members', () => {
    const t = bootstrap();
    try {
      const empty = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'empty',
      });
      expect(t.service.listMembers(empty.id)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('drops orphaned agent / user rows whose primary record is gone', () => {
    // Defensive case: if a conversation_agents row references a
    // deleted agent, listMembers should silently skip rather than
    // surface a half-resolved row. Same for users. Production should
    // never let this state happen (FK CASCADE is set), but the
    // service should be robust to it.
    const t = bootstrap();
    try {
      const ghost = t.agents.create(
        { name: 'ghost', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.conversations.addAgent(t.channel.id, ghost.id);
      // Force-insert a conversation_users row pointing at a user that
      // doesn't exist. Bypass FK temporarily so the dangling reference
      // can be observed.
      t.db.pragma('foreign_keys = OFF');
      t.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
           VALUES (?, ?, ?)`,
        )
        .run(t.channel.id, 'phantom', Date.now());
      // Now delete the ghost agent row directly, leaving the dangling
      // conversation_agents reference.
      t.db.prepare(`DELETE FROM agents WHERE id = ?`).run(ghost.id);
      t.db.pragma('foreign_keys = ON');

      // Add one real human so we can prove the live row survives
      // alongside the dropped phantom.
      t.conversations.addUser(t.channel.id, 'local');

      const members = t.service.listMembers(t.channel.id);
      expect(members).toEqual([
        {
          kind: 'human',
          user_id: 'local',
          name: 'local-test',
          display_name: 'Local Test User',
          avatar_url: null,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });
});
