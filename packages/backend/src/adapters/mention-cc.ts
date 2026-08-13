// Cross-channel mention cc adapter (#task:1981, ports completed by #task:1982
// W2). The named place where the cc fan-out effect gets its raw DB access and
// concrete repos, so the message service holds only `MentionCcPort` — and the
// use case itself (`application/mention-cc.ts`) holds no `Database` handle and
// no repo at all.
//
// Every port method below is a thin, PROVEN-equivalent delegation: where the
// use case previously prepared its own statement, the replacement is the
// existing repo method with the same effect —
//   - `reads.lastReadSeq` → `ConversationReadRepo.getLastReadSeq`, the same
//     `user_id = ? AND conversation_id = ? AND thread_root_id IS ?` lookup with
//     the same `?? 0` for "no cursor row yet".
// Pinned by tests in `tests/services/mention-cc.test.ts`.
//
// The three membership rows are NOT among those delegations any more (#task:1987):
// they are one atomic placement for two subjects, so this adapter hands the use
// case the roster half of the membership UnitOfWork and holds no membership repo
// of its own. Together the rows are the agent-home DM admission / ACL repair
// (#task:1989): a mention is DM admission, never a workspace invitation.
// `WorkspaceRepo.addUserMember`'s default `role = 'member'` — what the
// old bare INSERT got from the column default — now lives behind
// `addWorkspaceHumanMembership`.
import type { Database as Db } from 'better-sqlite3';
import { ccMentionsFromUserMessage } from '../application/mention-cc.js';
import type { MentionCcOpts } from '../application/mention-cc.js';
import { AgentRepo } from '../repos/agent-repo.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { NotificationRepo } from '../repos/notification-repo.js';
import { createSqliteMembershipPersistence } from '../repos/membership-persistence.js';
import type { MentionCcPort } from '../services/conversation-message/ports.js';
import { singleConversationViewerUserId } from '../viewer-scope.js';
import { createViewerUnreadPublishAdapter } from './unread-publish.js';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

export function createMentionCcAdapter(deps: {
  db: Db;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}): MentionCcPort {
  const composition = createMentionCcComposition(deps);
  return {
    ccMentionsFromUserMessage: args =>
      ccMentionsFromUserMessage({ ...composition, ...args }),
  };
}

/**
 * The composed capability bundle, minus the per-message trigger.
 *
 * Named and exported so ONE port can be substituted while every other port stays
 * the production one: a fault injected into the roster UnitOfWork then proves
 * what THIS orchestration does with a mid-transaction failure, not what a
 * hand-assembled bundle would. That is a composition seam, not a test hook —
 * `createMentionCcAdapter` is its only production caller and the split changes
 * no behavior.
 */
export type MentionCcComposition = Omit<
  MentionCcOpts,
  'message' | 'sourceConversation' | 'sourceWorkspace' | 'references'
>;

export function createMentionCcComposition(deps: {
  db: Db;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}): MentionCcComposition {
  const agentRepo = new AgentRepo(deps.db);
  const conversationRepo = new ConversationRepo(deps.db);
  const messageRepo = new MessageRepo(deps.db);
  const notificationRepo = new NotificationRepo(deps.db);
  const membershipPersistence = createSqliteMembershipPersistence(deps.db);
  const readRepo = new ConversationReadRepo(deps.db);
  const unread = createViewerUnreadPublishAdapter({
    db: deps.db,
    events: deps.events,
  });

  return {
    agents: {
      getByName: name => {
        const agent = agentRepo.getByName(name);
        return agent ? { id: agent.id, name: agent.name } : null;
      },
    },
    conversations: {
      listAgentIds: conversationId =>
        conversationRepo.listAgents(conversationId).map(ca => ca.agent_id),
      findDmChannelForAgent: (agentId, opts) =>
        conversationRepo.findDmChannelForAgent(agentId, opts ?? {}),
      insertDmChannel: input => conversationRepo.insertDmChannel(input),
      singleViewerUserId: conversationId =>
        singleConversationViewerUserId(conversationRepo, conversationId),
    },
    roster: membershipPersistence.uow,
    reads: {
      lastReadSeq: (viewerUserId, conversationId, threadRootId) =>
        readRepo.getLastReadSeq(viewerUserId, conversationId, threadRootId),
    },
    messages: {
      insertSystemMessage: input =>
        messageRepo.insertForConversation({
          conversationId: input.conversationId,
          fromKind: 'system',
          content: input.content,
          metadata: input.metadata,
        }),
    },
    notifications: {
      insertMentionExternal: input => {
        notificationRepo.insert({ kind: 'mention_external', ...input });
      },
    },
    unread,
    runtimeHost: deps.runtimeHost,
    logger: deps.logger,
    events: deps.events,
  };
}
