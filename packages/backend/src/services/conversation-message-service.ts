import type { Database as Db } from 'better-sqlite3';
import type {
  AgentRunTerminalReason,
  MessageDto,
  SendMessageTarget,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { ConversationManager } from '../conversation-manager.js';
import { ccMentionsFromUserMessage } from '../mention-cc.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { NotificationRepo } from '../repos/notification-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { SettingsRepo } from '../repos/settings-repo.js';
import type { AttachmentService } from './attachment-service.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import {
  assertActorConversationMatch,
  type AgentPrincipal,
  type UserPrincipal,
} from '../auth/principal.js';

/**
 * ConversationMessageService is the single owner of send-message business
 * side effects. Routes translate auth and input shapes, then call this
 * service; they must not replicate attachment validation, message insert,
 * realtime publish, unread invalidation, thread refresh, run resolution,
 * mention CC, agent delivery, or auto-start behavior.
 *
 * Contract:
 * - User callers cannot target parent/child conversations; reject before
 *   target resolution so the service is not a target-existence oracle.
 * - Agent callers must be members of their source conversation.
 * - Attachment snapshots are validated against the effective target
 *   conversation's owner channel.
 * - Attachment validation plus seq allocation plus message insert happen in
 *   one DB transaction.
 * - Message/unread/thread events and agent run resolution happen after commit
 *   and before any best-effort delivery/start work.
 */

export type SendMessageActor =
  | UserPrincipal
  | AgentPrincipal;

export interface SendMessageInput {
  conversationId: string;
  actor: SendMessageActor;
  content: string;
  attachmentIds?: string[];
  target?: SendMessageTarget;
}

export interface SendMessageResult {
  message: MessageDto;
  targetConversationId: string;
}

interface SendMessagePolicy {
  requireSenderMembership: boolean;
  allowTarget: boolean;
  distributeExcludeSender: boolean;
  /**
   * Default auto-start behavior for the actor. The runtime decision in
   * `sendMessage` overrides this for agent cross-target sends — see the
   * `shouldAutoStartIdle` derivation. Agents sending to their own
   * conversation (`target = self`) keep this `false` so in-channel
   * back-and-forth does not ping-pong every idle member; agents sending
   * across conversations (`target = parent` or `target = <thread_id>`)
   * always auto-start the target's idle members so the receiving session
   * can take over the work.
   */
  autoStartIdleRecipients: boolean;
  ccMentions: boolean;
  resolveRun: boolean;
}

const POLICIES: Record<SendMessageActor['kind'], SendMessagePolicy> = {
  user: {
    requireSenderMembership: false,
    allowTarget: false,
    distributeExcludeSender: false,
    autoStartIdleRecipients: true,
    ccMentions: true,
    resolveRun: false,
  },
  agent: {
    requireSenderMembership: true,
    allowTarget: true,
    distributeExcludeSender: true,
    // Same-target (self) baseline: no auto-start. Cross-target sends are
    // promoted to auto-start at runtime in `sendMessage`.
    autoStartIdleRecipients: false,
    ccMentions: false,
    resolveRun: true,
  },
};

export type ConversationErrorCode =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'conversation_archived';

export class ConversationError extends Error {
  constructor(
    public readonly code: ConversationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationError';
  }
}

export type ActorErrorCode =
  | 'agent_not_found'
  | 'agent_not_member_of_conversation';

export class ActorError extends Error {
  constructor(
    public readonly code: ActorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActorError';
  }
}

export type TargetErrorCode =
  | 'no_parent'
  | 'thread_not_found'
  | 'thread_not_child'
  | 'target_closed'
  | 'target_archived';

export class TargetError extends Error {
  constructor(
    public readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}

export type PolicyErrorCode = 'target_not_allowed_for_user';

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export type AttachmentErrorCode =
  | 'attachment_owner_unresolved'
  | 'attachment_outside_channel';

export class AttachmentError extends Error {
  constructor(
    public readonly code: AttachmentErrorCode,
    message: string,
    public readonly attachmentId?: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface ConversationMessageServiceOptions {
  db: Db;
  conversations: ConversationRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  notifications: NotificationRepo;
  workspaces: WorkspaceRepo;
  attachmentService: AttachmentService;
  conversationManager: ConversationManager;
  events: ScopeEventBus;
  logger: BackendLogger;
}

interface SendMessageTxResult {
  sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>;
  targetConversation: NonNullable<ReturnType<ConversationRepo['get']>>;
  message: MessageDto;
  recipients: ReturnType<ConversationRepo['listAgents']>;
}

const REPLIED: AgentRunTerminalReason = 'replied';

export class ConversationMessageService {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly notifications: NotificationRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly attachmentService: AttachmentService;
  private readonly conversationManager: ConversationManager;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(opts: ConversationMessageServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.notifications = opts.notifications;
    this.workspaces = opts.workspaces;
    this.attachmentService = opts.attachmentService;
    this.conversationManager = opts.conversationManager;
    this.events = opts.events;
    this.logger = opts.logger;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    assertActorConversationMatch(input.actor, input.conversationId);
    const policy = POLICIES[input.actor.kind];
    const target = input.target ?? 'self';
    if (!policy.allowTarget && target !== 'self') {
      throw new PolicyError(
        'target_not_allowed_for_user',
        'user messages cannot target another conversation',
      );
    }

    const txResult = this.db.transaction((): SendMessageTxResult => {
      const sourceConversation = this.conversations.get(input.conversationId);
      if (!sourceConversation) {
        throw new ConversationError(
          'conversation_not_found',
          'conversation not found',
        );
      }
      if (sourceConversation.closed_at !== null) {
        throw new ConversationError(
          'conversation_closed',
          'conversation is closed',
        );
      }
      if (sourceConversation.archived_at !== null) {
        throw new ConversationError(
          'conversation_archived',
          'conversation is archived',
        );
      }
      this.validateActor(input.actor, policy, sourceConversation.id);

      const targetConversation = this.resolveTarget(sourceConversation, target);
      const attachmentIds = input.attachmentIds ?? [];
      const snapshots = this.resolveAttachmentSnapshots(targetConversation, attachmentIds);
      const message = this.messages.insertForConversation({
        conversationId: targetConversation.id,
        fromKind: input.actor.kind,
        fromUserId: input.actor.kind === 'user' ? input.actor.userId : null,
        fromAgentId: input.actor.kind === 'agent' ? input.actor.agentId : null,
        content: input.content,
        attachments: snapshots.length > 0 ? snapshots : null,
      });
      return {
        sourceConversation,
        targetConversation,
        message,
        recipients: this.conversations.listAgents(targetConversation.id),
      };
    })();

    this.logger.info(
      {
        sourceConversationId: txResult.sourceConversation.id,
        targetConversationId: txResult.targetConversation.id,
        messageId: txResult.message.id,
        actorKind: input.actor.kind,
        actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
        target,
        contentBytes: input.content.length,
        recipientCount: txResult.recipients.length,
      },
      'conversation-message-service: message inserted',
    );

    this.events.publish(txResult.targetConversation.id, {
      kind: 'message',
      payload: { message: txResult.message },
    });
    this.publishUnreadUpdated(txResult.targetConversation.id);

    if (txResult.targetConversation.parent_conversation_id) {
      this.events.publish(txResult.targetConversation.parent_conversation_id, {
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: txResult.targetConversation.parent_conversation_id,
          thread_id: txResult.targetConversation.id,
        },
      });
    }

    if (policy.resolveRun && input.actor.kind === 'agent') {
      this.conversationManager.resolveRun(
        txResult.sourceConversation.id,
        input.actor.agentId,
        REPLIED,
      );
    }

    // Cross-target identity flag — controls both delivery sender-exclusion
    // and idle auto-start policies below. Computed once.
    const targetIsCrossConversation =
      txResult.targetConversation.id !== txResult.sourceConversation.id;

    // Delivery sender-exclusion only fires for same-conversation send.
    // Cross-conversation send is a hand-off between *different*
    // (conversation, agent) processes: when Cindy@channel sends to a
    // thread where a separate Cindy@thread session exists, the thread
    // session is the actual recipient and must receive the message in
    // its inbox. Excluding by agent id would deliver to nobody and the
    // started session would wake without a message to process — exactly
    // the bug @Cindy caught on `f28ed08` review.
    const deliveryExcludeAgentId =
      policy.distributeExcludeSender
      && input.actor.kind === 'agent'
      && !targetIsCrossConversation
        ? input.actor.agentId
        : null;
    void this.deliverBestEffort(
      txResult.targetConversation.id,
      txResult.message.id,
      txResult.recipients,
      deliveryExcludeAgentId,
    );
    if (policy.ccMentions) {
      void this.ccMentionsBestEffort(txResult.sourceConversation, txResult.message);
    }
    // Auto-start policy:
    //  - User send: always (policy.autoStartIdleRecipients = true).
    //  - Agent send to self: never — prevents same-conversation ping-pong
    //    where every reply would wake every other idle member.
    //  - Agent cross-target send (`--target parent` / `<thread_id>`):
    //    always wake the target's idle members. Cross-target send is an
    //    explicit hand-off; if the receiving session is idle, the message
    //    just sits in inbox and "delivery" is a no-op for collaboration
    //    purposes. Cross-conversation traffic does not ping-pong because
    //    target replies stay scoped to the target's own member set.
    //  Wake intentionally does NOT exclude the sender's session in the
    //  target conversation: when Cindy@channel sends to a thread where a
    //  separate Cindy@thread session exists, the thread session must be
    //  woken — they are independent (conversation, agent) processes with
    //  independent context.
    const shouldAutoStartIdle =
      policy.autoStartIdleRecipients
      || (input.actor.kind === 'agent' && targetIsCrossConversation);
    if (shouldAutoStartIdle) {
      void this.startIdleRecipientsBestEffort(
        txResult.targetConversation.id,
        txResult.recipients,
      );
    }

    return {
      message: txResult.message,
      targetConversationId: txResult.targetConversation.id,
    };
  }

  private validateActor(
    actor: SendMessageActor,
    policy: SendMessagePolicy,
    sourceConversationId: string,
  ): void {
    if (actor.kind !== 'agent') return;
    if (!this.agents.get(actor.agentId)) {
      throw new ActorError('agent_not_found', 'agent not found');
    }
    if (
      policy.requireSenderMembership
      && !this.conversations.getAgent(sourceConversationId, actor.agentId)
    ) {
      throw new ActorError(
        'agent_not_member_of_conversation',
        'agent is not a member of this conversation',
      );
    }
  }

  private resolveTarget(
    sourceConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    target: SendMessageTarget,
  ): NonNullable<ReturnType<ConversationRepo['get']>> {
    if (target === 'self') return sourceConversation;
    if (target === 'parent') {
      if (!sourceConversation.parent_conversation_id) {
        throw new TargetError('no_parent', 'no parent channel');
      }
      const parent = this.conversations.get(sourceConversation.parent_conversation_id);
      if (!parent) {
        throw new TargetError('no_parent', 'parent channel not found');
      }
      if (parent.closed_at !== null) {
        throw new TargetError('target_closed', 'target conversation is closed');
      }
      if (parent.archived_at !== null) {
        throw new TargetError('target_archived', 'target conversation is archived');
      }
      return parent;
    }

    const thread = this.conversations.getThread(target.thread_id);
    if (!thread) {
      throw new TargetError('thread_not_found', 'thread not found');
    }
    if (thread.parent_conversation_id !== sourceConversation.id) {
      throw new TargetError(
        'thread_not_child',
        'target is not a direct thread of current channel',
      );
    }
    if (thread.closed_at !== null) {
      throw new TargetError('target_closed', 'target conversation is closed');
    }
    if (thread.archived_at !== null) {
      throw new TargetError('target_archived', 'target conversation is archived');
    }
    return thread;
  }

  private resolveAttachmentSnapshots(
    targetConversation: NonNullable<ReturnType<ConversationRepo['get']>>,
    attachmentIds: string[],
  ): NonNullable<Parameters<MessageRepo['insertForConversation']>[0]['attachments']> {
    if (attachmentIds.length === 0) return [];
    const ownerChannelId = resolveOwnerChannelId(targetConversation);
    if (!ownerChannelId) {
      throw new AttachmentError(
        'attachment_owner_unresolved',
        'attachment owner channel could not be resolved',
      );
    }
    const resolved = this.attachmentService.resolveSnapshotsForChannel(
      attachmentIds,
      ownerChannelId,
    );
    if (!resolved.ok) {
      throw new AttachmentError(
        'attachment_outside_channel',
        'attachment does not belong to this channel',
        resolved.offendingId,
      );
    }
    return resolved.snapshots;
  }

  /**
   * Resolves the current viewer id from `app_settings.viewer_user_id`
   * and publishes an `unread_updated` frame to that viewer's private
   * scope. Used after every persisted user/agent message so the
   * renderer's notification & unread hooks invalidate without polling.
   * Pre-PR1 this hardcoded `'local'`; the registered random-id
   * viewer needs the resolved id or the renderer never sees the event.
   */
  private publishUnreadUpdated(conversationId: string): void {
    const viewerUserId = new SettingsRepo(this.db).getViewerUserId();
    if (!viewerUserId) return;
    this.events.publishToScope(`viewer:${viewerUserId}`, 'unread_updated', {
      conversation_id: conversationId,
    });
  }

  private async deliverBestEffort(
    conversationId: string,
    messageId: string,
    recipients: ReturnType<ConversationRepo['listAgents']>,
    excludeAgentId: string | null,
  ): Promise<void> {
    const selected = recipients.filter(ca => ca.agent_id !== excludeAgentId);
    try {
      await Promise.all(
        selected.map(ca =>
          this.conversationManager.deliverMessage(
            conversationId,
            ca.agent_id,
            messageId,
          ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        { conversationId, messageId, excludeAgentId, err },
        'conversation-message-service: delivery failed',
      );
    }
  }

  private async ccMentionsBestEffort(
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
        conversationManager: this.conversationManager,
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

  private async startIdleRecipientsBestEffort(
    conversationId: string,
    recipients: ReturnType<ConversationRepo['listAgents']>,
  ): Promise<void> {
    await Promise.all(
      recipients
        .filter(ca => ca.status !== 'active' && ca.status !== 'starting')
        .map(ca =>
          this.conversationManager.start(conversationId, ca.agent_id).catch(err => {
            this.logger.warn(
              { conversationId, agentId: ca.agent_id, err },
              'conversation-message-service: auto-start on message send failed',
            );
          }),
        ),
    );
  }
}

function resolveOwnerChannelId(conversation: {
  id: string;
  kind: string;
  parent_conversation_id: string | null;
}): string | null {
  if (conversation.kind === 'channel' || conversation.kind === 'dm_channel') {
    return conversation.id;
  }
  if (conversation.kind === 'thread') {
    return conversation.parent_conversation_id ?? null;
  }
  return null;
}
