// Post-commit message distribution + notification side-effects. Everything the
// send aggregate fires AFTER the send transaction commits: runtime delivery to
// recipients (main-line fan-out and follower-gated thread-reply delivery),
// idle auto-start, mention CC, viewer @mention notifications, unread republish,
// and agent-start-failure notifications. All best-effort — a failure here never
// unwinds the committed message. The facade constructs one of these and hands
// off to it after commit.
import type { Database as Db } from 'better-sqlite3';
import { extractMentions } from '@silverhand/shared';
import type { MessageDto } from '@silverhand/shared';
import type { BackendLogger } from '../../context.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import { ccMentionsFromUserMessage } from '../../mention-cc.js';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import { ConversationReadRepo } from '../../repos/conversation-read-repo.js';
import { AttentionBadgeRepo } from '../../repos/attention-badge-repo.js';
import type { ConversationInboxRepo } from '../../repos/conversation-inbox-repo.js';
import type { MessageRepo } from '../../repos/message-repo.js';
import type { NotificationRepo } from '../../repos/notification-repo.js';
import type { UserRepo } from '../../repos/user-repo.js';
import type { WorkspaceRepo } from '../../repos/workspace-repo.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import {
  conversationViewerUserIds,
  publishUnreadUpdatedToConversationViewers,
} from '../../viewer-scope.js';
import {
  excerpt,
  nonEmptyName,
  describeStartFailure,
  type ThreadDeliveryPlan,
} from './contracts.js';

export interface MessageDeliveryCoordinatorDeps {
  db: Db;
  conversations: ConversationRepo;
  conversationInboxes: ConversationInboxRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  users: UserRepo;
  notifications: NotificationRepo;
  workspaces: WorkspaceRepo;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}

export class MessageDeliveryCoordinator {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly conversationReads: ConversationReadRepo;
  private readonly attentionBadges: AttentionBadgeRepo;
  private readonly conversationInboxes: ConversationInboxRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly users: UserRepo;
  private readonly notifications: NotificationRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(deps: MessageDeliveryCoordinatorDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    // Stateless read-model wrapper over the same db (favorites read-model uses
    // the same ad-hoc construction) — powers the authoritative unread counts on
    // the `unread_updated` frame (#task:1283).
    this.conversationReads = new ConversationReadRepo(deps.db);
    // Same stateless-wrapper pattern: the tiered badge (#task:1870) is emitted
    // alongside every `unread_updated`, so it is built from the same db handle.
    this.attentionBadges = new AttentionBadgeRepo(deps.db);
    this.conversationInboxes = deps.conversationInboxes;
    this.messages = deps.messages;
    this.agents = deps.agents;
    this.users = deps.users;
    this.notifications = deps.notifications;
    this.workspaces = deps.workspaces;
    this.runtimeHost = deps.runtimeHost;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /** Publish `unread_updated` to every human member of this conversation. */
  publishUnreadUpdated(conversationId: string): void {
    publishUnreadUpdatedToConversationViewers(
      this.events,
      this.attentionBadges,
      this.conversations,
      this.conversationReads,
      conversationId,
    );
  }

  notifyViewerMentionBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
  ): void {
    try {
      const mentionedHandles = new Set(extractMentions(message.content));
      if (mentionedHandles.size === 0) return;

      for (const viewerUserId of conversationViewerUserIds(
        this.conversations,
        conversation.id,
      )) {
        if (message.from_kind === 'user' && message.from_user_id === viewerUserId) {
          continue;
        }
        const viewer = this.users.get(viewerUserId);
        if (!viewer || !mentionedHandles.has(viewer.name)) continue;

        this.notifications.insert({
          kind: 'mention_self',
          userId: viewerUserId,
          workspaceId: conversation.workspace_id,
          conversationId: conversation.id,
          messageId: message.id,
          sourceWorkspaceId: conversation.workspace_id,
          sourceConversationId: conversation.id,
          sourceMessageId: message.id,
          payload: {
            conversation_title: conversation.title,
            trigger_name: this.resolveMessageSenderName(message),
            mentioned_name: viewer.name,
            mention_excerpt: excerpt(message.content),
          },
        });
        this.events.publishToScope(`viewer:${viewerUserId}`, 'notification', {
          kind: 'mention_self',
          conversation_id: conversation.id,
          message_id: message.id,
        });
      }
    } catch (err) {
      this.logger.warn(
        {
          conversationId: conversation.id,
          messageId: message.id,
          err,
        },
        'conversation-message-service: viewer mention notification failed',
      );
    }
  }

  private resolveMessageSenderName(message: MessageDto): string | null {
    if (message.from_kind === 'agent' && message.from_agent_id) {
      const agent = this.agents.get(message.from_agent_id);
      return (
        nonEmptyName(agent?.display_name)
        ?? nonEmptyName(agent?.name)
        ?? message.from_agent_id
      );
    }
    if (message.from_kind === 'user' && message.from_user_id) {
      const user = this.users.get(message.from_user_id);
      return (
        nonEmptyName(user?.display_name)
        ?? nonEmptyName(user?.name)
        ?? message.from_user_id
      );
    }
    return null;
  }

  async deliverBestEffort(
    conversationId: string,
    messageId: string,
    recipients: ReturnType<ConversationRepo['listAgents']>,
    excludeAgentId: string | null,
  ): Promise<void> {
    const selected = recipients.filter(ca => ca.agent_id !== excludeAgentId);
    const failures: Array<{ agentId: string; err: unknown }> = [];
    await Promise.all(
      selected.map(async ca => {
        try {
          await this.runtimeHost.deliverMessage(
            conversationId,
            ca.agent_id,
            messageId,
          );
        } catch (err) {
          failures.push({ agentId: ca.agent_id, err });
        }
      }),
    );
    if (failures.length === 0) return;
    // Only touch the DB on the failure path — the success path stays read-free.
    const conversation = this.conversations.get(conversationId);
    const message = this.messages.getById(messageId);
    if (conversation && message) {
      for (const { agentId, err } of failures) {
        this.notifyAgentStartFailureBestEffort(conversation, message, agentId, err);
      }
    }
    this.logger.warn(
      { conversationId, messageId, excludeAgentId, failures },
      'conversation-message-service: delivery failed',
    );
  }

  notifyAgentStartFailureBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    agentId: string,
    err: unknown,
  ): void {
    if (message.from_kind !== 'user' || !message.from_user_id) return;
    const agent = this.agents.get(agentId);
    const error = describeStartFailure(err);
    try {
      const notification = this.notifications.insert({
        kind: 'agent_start_failed',
        userId: message.from_user_id,
        agentId,
        workspaceId: conversation.workspace_id,
        conversationId: conversation.id,
        messageId: null,
        sourceWorkspaceId: conversation.workspace_id,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
        payload: {
          reason: 'runtime_start_failed',
          error,
          agent_name:
            nonEmptyName(agent?.display_name)
            ?? nonEmptyName(agent?.name)
            ?? agentId,
          runtime: agent?.runtime ?? null,
          host_id: agent?.host_id ?? null,
        },
      });
      this.events.publishToScope(`viewer:${message.from_user_id}`, 'notification', {
        kind: 'agent_start_failed',
        id: notification.id,
        conversation_id: conversation.id,
        agent_id: agentId,
      });
    } catch (notifyErr) {
      this.logger.warn(
        {
          conversationId: conversation.id,
          messageId: message.id,
          agentId,
          err: notifyErr,
        },
        'conversation-message-service: agent start failure notification failed',
      );
    }
  }

  /** Deliver the current thread reply to its follower-gated recipients
   *  (post-commit, best-effort). `turn` recipients get active delivery
   *  (spawn idle / wake ready). `observe` recipients get a durable inbox row
   *  only — they must NOT start an idle runtime, so a normal follower is not
   *  woken by every thread reply (§6.2). Pushing an observe reply into an
   *  already-ready runtime's context without a turn needs the `delivery_kind`
   *  envelope and is 段2. */
  async deliverThreadReplyBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    plan: ThreadDeliveryPlan,
  ): Promise<void> {
    const failures: Array<{ agentId: string; err: unknown }> = [];
    await Promise.all(
      plan.recipients.map(async r => {
        try {
          if (r.kind === 'turn') {
            await this.runtimeHost.deliverMessage(
              conversation.id,
              r.agentId,
              message.id,
            );
          } else {
            this.conversationInboxes.ensureDelivery(
              conversation.id,
              r.agentId,
              message.id,
              'observe',
            );
          }
        } catch (err) {
          failures.push({ agentId: r.agentId, err });
        }
      }),
    );
    if (failures.length === 0) return;
    for (const { agentId, err } of failures) {
      this.notifyAgentStartFailureBestEffort(conversation, message, agentId, err);
    }
    this.logger.warn(
      { conversationId: conversation.id, messageId: message.id, failures },
      'conversation-message-service: thread reply delivery failed',
    );
  }

  async ccMentionsBestEffort(
    sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
  ): Promise<void> {
    const sourceWorkspace = this.workspaces.get(sourceConversation.workspace_id);
    if (!sourceWorkspace) return;
    try {
      await ccMentionsFromUserMessage({
        message,
        sourceConversation,
        sourceWorkspace,
        db: this.db,
        agents: this.agents,
        conversations: this.conversations,
        messages: this.messages,
        notifications: this.notifications,
        runtimeHost: this.runtimeHost,
        logger: this.logger,
        events: this.events,
      });
    } catch (err) {
      this.logger.warn(
        { conversationId: sourceConversation.id, messageId: message.id, err },
        'conversation-message-service: mention cc failed',
      );
    }
  }

  async startIdleRecipientsBestEffort(
    conversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    message: MessageDto,
    recipients: ReturnType<ConversationRepo['listAgents']>,
  ): Promise<void> {
    await Promise.all(
      recipients
        .filter(ca => ca.status !== 'active' && ca.status !== 'starting')
        .map(async ca => {
          try {
            await this.runtimeHost.start(conversation.id, ca.agent_id);
          } catch (err) {
            this.notifyAgentStartFailureBestEffort(
              conversation,
              message,
              ca.agent_id,
              err,
            );
            this.logger.warn(
              { conversationId: conversation.id, agentId: ca.agent_id, err },
              'conversation-message-service: auto-start on message send failed',
            );
          }
        }),
    );
  }
}
