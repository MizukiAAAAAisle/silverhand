/**
 * Semantic test context: repository-contract builders over openTestDb.
 *
 * Business tests built on this layer never touch the native DB — they see
 * DTOs, repository/service contracts, and purpose-named fixture seams. Native
 * SQL is concentrated HERE (and in utils/db.ts), which is what lets the
 * db-boundary test gate pin business tests to zero native statements: when a
 * PostgreSQL adapter eventually exists, these tests rerun against it by
 * swapping the context internals, not by rewriting assertions.
 *
 * Grow this file builder-by-builder as tests migrate; do not pre-build a
 * fixture empire.
 */
import type { AgentDto, ConversationDto, RuntimeKind, WorkspaceDto } from '@silverhand/shared';
import { slugifyConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb, type OpenTestDbOptions } from './db.js';

export interface CreateAgentOptions {
  runtime?: RuntimeKind;
  displayName?: string;
}

export interface MemberOptions {
  /** Pin a distinct joined_at so ordering tests never race the clock. */
  joinedAt?: number;
}

export type TestContext = ReturnType<typeof makeTestContext>;

export function makeTestContext(options: OpenTestDbOptions = {}) {
  const { db, localHostId, viewerUserId } = openTestDb(options);
  const tmp = makeTempSilverhandDir();
  const repos = {
    agents: new AgentRepo(db),
    users: new UserRepo(db),
    conversations: new ConversationRepo(db),
    workspaces: new WorkspaceRepo(db),
  };

  const pinAgentJoinedAt = db.prepare(
    'UPDATE conversation_agents SET joined_at = ? WHERE conversation_id = ? AND agent_id = ?',
  );
  const pinUserJoinedAt = db.prepare(
    'UPDATE conversation_users SET joined_at = ? WHERE conversation_id = ? AND user_id = ?',
  );

  /**
   * Per-context ordinal for fixture channel ADDRESSES (#task:2016). A workspace
   * conversation must hold a name allocation to exist, and callers of
   * `createChannel` pass a title (often the same default twice). Production
   * answers a colliding address with a 409; a fixture has no such intent, so the
   * address is the derived slug plus an ordinal — unique by construction, and
   * still readable in a failure message.
   */
  let channelOrdinal = 0;

  return {
    repos,
    localHostId,
    viewerUserId,
    cleanup: tmp.cleanup,
    tempDirs: tmp,

    createWorkspace(name = 'eng'): WorkspaceDto {
      return repos.workspaces.insert({ name, description: null });
    },

    createChannel(workspace: WorkspaceDto, title = 'general'): ConversationDto {
      channelOrdinal += 1;
      return repos.conversations.insertChannel({
        workspaceId: workspace.id,
        title,
        name: `${slugifyConversationTitle(title)}-${channelOrdinal}`,
      });
    },

    createAgent(name: string, opts: CreateAgentOptions = {}): AgentDto {
      const agent = repos.agents.create(
        { name, runtime: opts.runtime ?? 'claude' },
        localHostId,
        viewerUserId,
      );
      if (opts.displayName === undefined) return agent;
      return repos.agents.update(agent.id, { display_name: opts.displayName }) ?? agent;
    },

    addAgentMember(conversation: ConversationDto, agent: AgentDto, opts: MemberOptions = {}): void {
      repos.conversations.addAgent(conversation.id, agent.id);
      if (opts.joinedAt !== undefined) {
        pinAgentJoinedAt.run(opts.joinedAt, conversation.id, agent.id);
      }
    },

    addUserMember(conversation: ConversationDto, userId: string, opts: MemberOptions = {}): void {
      repos.conversations.addUser(conversation.id, userId);
      if (opts.joinedAt !== undefined) {
        pinUserJoinedAt.run(opts.joinedAt, conversation.id, userId);
      }
    },

    /**
     * White-box seam: delete an agents row while KEEPING its membership rows —
     * a referentially-broken state production FK cascades forbid. For tests
     * proving read surfaces tolerate dangling references.
     */
    forceDeleteAgentRowKeepingMemberships(agentId: string): void {
      db.pragma('foreign_keys = OFF');
      try {
        db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },

    /**
     * White-box seam: insert a conversation_users row for a user id that does
     * not exist — unreachable through any production surface (FK enforced).
     */
    forceInsertDanglingUserMember(conversation: ConversationDto, userId: string): void {
      db.pragma('foreign_keys = OFF');
      try {
        db.prepare(
          'INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
        ).run(conversation.id, userId, Date.now());
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  };
}
