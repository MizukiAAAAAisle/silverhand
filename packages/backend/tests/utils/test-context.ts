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
import type { AgentDto, ConversationDto, RuntimeKind, Workspace } from '@silverhand/shared';
import { fixedConversationTitle, fixedWorkspaceName } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createBackendPersistence } from '../../src/persistence/root.js';
import { makeTempSilverhandDir, openTestDb, type OpenTestDbOptions } from './db.js';

export interface CreateAgentOptions {
  runtime?: RuntimeKind;
  displayName?: string;
}

/** The three materialization stages a fixture agent can be seeded into. */
export type SeededAgentStatus = 'active' | 'failed' | 'pending';

export interface CreateAgentAsOptions {
  /** The creator user id written to `created_by_user_id` (the ACL creator arm). */
  createdBy: string;
  /**
   * The `created_at` instant to pin. `AgentRepo.list()` orders `created_at ASC`
   * with no id tiebreak, so a visibility/ordering fixture must choose it — and
   * no repo write expresses an instant (see the inventory note beside the
   * `pinAgentCreatedAt` statement).
   */
  createdAt: number;
  /** Which materialization stage to leave the row in. Defaults to `active`. */
  status?: SeededAgentStatus;
  runtime?: RuntimeKind;
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
  // `created_at` IS the ordering contract of `AgentRepo.list()` (created_at ASC,
  // no id tiebreak), and no repo write expresses a specific instant — the same
  // reason `participation-enumeration` / `conversation-member-refs` pin their
  // ordering columns natively. Concentrated here so business tests carry none.
  const pinAgentCreatedAt = db.prepare('UPDATE agents SET created_at = ? WHERE id = ?');

  // The authorization read port assembled over THIS seeded database, so an ACL
  // predicate (`canViewAgent`) reads the same rows the builders wrote. Extracted
  // from the composition root; the manual `repos` above stay the builder handles.
  const { authorizationReads } = createBackendPersistence(db);

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
    authorizationReads,
    localHostId,
    viewerUserId,
    cleanup: tmp.cleanup,
    tempDirs: tmp,

    createWorkspace(name = 'eng'): Workspace {
      return repos.workspaces.insert({ name: fixedWorkspaceName(name), description: null });
    },

    createChannel(workspace: Workspace, title = 'general'): ConversationDto {
      channelOrdinal += 1;
      return repos.conversations.insertChannel({
        workspaceId: workspace.id,
        title: fixedConversationTitle(title),
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

    /**
     * Seed an agent with a chosen creator, `created_at` and materialization
     * stage, returning its generated id. `active` goes through the normal
     * `create` path; `failed` / `pending` go through the reserve path (a
     * `pending_materialization` row), and `failed` is then flipped — the only
     * production ways those stages exist. `created_at` is pinned last because it
     * is the list ordering contract no repo write can set.
     */
    createAgentAs(name: string, opts: CreateAgentAsOptions): string {
      const runtime = opts.runtime ?? 'qoder';
      const status = opts.status ?? 'active';
      let id: string;
      if (status === 'active') {
        id = repos.agents.create({ name, runtime }, localHostId, opts.createdBy).id;
      } else {
        id = repos.agents.reserveForMaterialize(
          { name, runtime },
          localHostId,
          opts.createdBy,
          `idem-${name}`,
        ).id;
        if (status === 'failed') {
          repos.agents.flipToFailed(id, 'internal_error', opts.createdAt);
        }
      }
      pinAgentCreatedAt.run(opts.createdAt, id);
      return id;
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
