// Post-commit message distribution + notification side-effects. Everything the
// send aggregate fires AFTER the send transaction commits: runtime delivery to
// recipients (main-line fan-out and follower-gated thread-reply delivery),
// idle auto-start, mention CC, viewer @mention notifications, unread republish,
// and agent-start-failure notifications. All best-effort — a failure here never
// unwinds the committed message. The facade constructs one of these and hands
// off to it after commit.
//
// Persistence discipline (#task:1981): no raw DB and no concrete repo. This
// coordinator runs entirely outside the send transaction, so it takes the
// callback-free read / write ports plus the named effect port
// (`ConversationUnreadPublishPort`), which is NOT reachable from
// `MessageTxScope` — that is what makes "a transaction callback structurally
// cannot publish" true.
//
// The mention CC used to be a third persistence-holding effect port here
// (`MentionCcPort`). In v71 its writes moved INTO the send transaction (§5), so
// what is left on this side — the wake, the WS frames, the skip log — carries no
// persistence capability at all and needs no port: this coordinator just drives
// the in-transaction report through `dispatchMentionCcEffects`.
import type {
  ConversationDto,
  MessageDto,
  Reference,
} from '@silverhand/shared';
import { isWorkspacePlaced } from '@silverhand/shared';
import { publishDirectPairsChangedToViewers } from '../../application/direct-pairs-changed.js';
import { dispatchMentionCcEffects } from '../../application/mention-cc.js';
import type { MentionCcReport } from '../../application/mention-cc.js';
import type { BackendLogger } from '../../context.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import type { ConversationUnreadPublishPort } from '../conversation/unread-publish-port.js';
import type {
  DeliveryReadPort,
  DeliveryWritePort,
} from './ports.js';
import {
  excerpt,
  nonEmptyName,
  describeStartFailure,
  type MessageRecipient,
  type ThreadDeliveryPlan,
} from './contracts.js';

export interface MessageDeliveryCoordinatorDeps {
  read: DeliveryReadPort;
  write: DeliveryWritePort;
  unreadPublish: ConversationUnreadPublishPort;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}

export class MessageDeliveryCoordinator {
  private readonly read: DeliveryReadPort;
  private readonly write: DeliveryWritePort;
  private readonly unreadPublish: ConversationUnreadPublishPort;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(deps: MessageDeliveryCoordinatorDeps) {
    this.read = deps.read;
    this.write = deps.write;
    this.unreadPublish = deps.unreadPublish;
    this.runtimeHost = deps.runtimeHost;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /** Publish `unread_updated` to every human member of this conversation.
   *  The adapter behind this port co-emits the tiered attention badge
   *  (#task:1870) — that pairing stays enforced inside `viewer-scope.ts`.
   *
   *  TWO ARMS, and the split is HERE rather than in the publisher (#task:2021
   *  P4-4). That read model's unit is (human viewer, WORKSPACE): a workspace-less
   *  placement has no coordinate in it, so
   *  `publishUnreadUpdatedToConversationViewers` throws on one — deliberately,
   *  because for a channel a missing workspace means a corrupt row, and it will
   *  not turn a routing bug into a silent no-op. Reaching it with a `direct_pair`
   *  would mean the send commits and then this post-commit call throws, i.e. the
   *  caller is told its message failed while the row is durable.
   *
   *  So the CALLER side answers it, as an honest branch on the placement instead
   *  of a widened publisher:
   *    - `workspace` → the unread + badge pair, unchanged.
   *    - `direct_pair` → `direct_pairs_changed` (#task:2035), the viewer-scoped
   *      DM-list invalidation. It is NOT an unread frame in disguise: the row may
   *      not exist in the client's cache at all (a stranger's first DM), so the
   *      authority is the re-read of `GET /api/direct-pairs`, which carries the
   *      pair's unread. See `application/direct-pairs-changed.ts`.
   *  Those two arms are the whole placement alphabet, so nothing falls through
   *  to a third outcome.
   *
   *  Every caller of this method is post-commit, and all three describe a change
   *  the DM list would show: a send, and the two thread follow-state writes
   *  (`followHumanThread` / `unfollowHumanThread`) that move the viewer's unread
   *  roll-up by adding or dropping a followed cluster. */
  publishUnreadUpdated(conversationId: string): void {
    const conversation = this.read.getConversation(conversationId);
    if (!conversation) return;
    if (isWorkspacePlaced(conversation)) {
      this.unreadPublish.publishUnreadUpdatedToConversationViewers(conversationId);
      return;
    }
    if (conversation.placement_kind === 'direct_pair') {
      publishDirectPairsChangedToViewers(
        this.events,
        this.read.viewerUserIds(conversationId),
        conversationId,
      );
    }
  }

  /**
   * Insert a `mention_self` notification for every human member this message
   * addresses. `mention_self` is the canonical directed "@me" source the
   * Attention / Activity read surfaces count, so what counts as "addressed"
   * here is the reference contract and nothing looser: a canonical reference
   * destination naming a HUMAN, in prose position (#task:2000).
   *
   * `kind` is checked, not merely carried: a handle is globally unique across
   * users and agents, so `silverhand://agent/shiki` could be resolved to the
   * human `shiki` by ignoring the kind. It isn't — a typed pointer that names
   * the wrong kind is a wrong address, and answering it anyway would make the
   * kind decorative.
   *
   * `references` is the send boundary's single derivation for THIS message
   * (Cindy round-2 MUST FIX 1). It is a required argument rather than a
   * re-parse so that "one parse per send" is a signature, not a convention:
   * every in-send consumer of the addressing contract is handed the same set.
   *
   * WORKSPACE PLACEMENTS ONLY, and not as a deferral (#task:2035). In a
   * `direct_pair` THE STREAM IS THE MENTION: the placement has two endpoints, the
   * human is a party to every message in it by construction, and a `mention_self`
   * row would tell them something they were already told — while the surface it
   * feeds (`notifications` → Activity) is coordinated by (workspace,
   * conversation), which a DM has no first half of. Inserting one anyway shipped an
   * Activity item with `workspace_id: ''` and `title: ''` (@Cindy's probe): not a
   * navigable coordinate, and a fabricated workspace is worse than the silent
   * mis-delivery it replaced. The DM's unread surface is `GET /api/direct-pairs`,
   * invalidated for these same viewers by `publishUnreadUpdated` above.
   *
   * This is about the NOTIFICATION face only: the reference resolved, and nothing
   * here reports it as unresolved.
   */
  notifyViewerMentionBestEffort(
    conversation: ConversationDto,
    message: MessageDto,
    references: readonly Reference[],
  ): void {
    try {
      if (!isWorkspacePlaced(conversation)) return;
      const workspaceId = conversation.workspace_id;
      const mentionedHandles = new Set(
        references
          .filter(ref => ref.kind === 'human')
          .map(ref => ref.handle),
      );
      if (mentionedHandles.size === 0) return;

      for (const viewerUserId of this.read.viewerUserIds(conversation.id)) {
        if (message.from_kind === 'user' && message.from_user_id === viewerUserId) {
          continue;
        }
        const viewer = this.read.getUser(viewerUserId);
        if (!viewer || !mentionedHandles.has(viewer.name)) continue;

        this.write.insertNotification({
          kind: 'mention_self',
          userId: viewerUserId,
          workspaceId,
          conversationId: conversation.id,
          messageId: message.id,
          sourceWorkspaceId: workspaceId,
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
      const agent = this.read.getAgent(message.from_agent_id);
      return (
        nonEmptyName(agent?.display_name)
        ?? nonEmptyName(agent?.name)
        ?? message.from_agent_id
      );
    }
    if (message.from_kind === 'user' && message.from_user_id) {
      const user = this.read.getUser(message.from_user_id);
      return (
        nonEmptyName(user?.display_name)
        ?? nonEmptyName(user?.name)
        ?? message.from_user_id
      );
    }
    return null;
  }

  /** Main-line fan-out. `recipients` is the send transaction's enumeration of the
   *  target's LIVE AGENT PARTICIPANTS — principal ids only (`MessageRecipient`),
   *  never membership rows, because two of the three placements have none. Sender
   *  exclusion happens HERE rather than in the enumeration, so the plan the log
   *  records is the full set and the one omission is visible as a parameter. */
  async deliverBestEffort(
    conversationId: string,
    messageId: string,
    recipients: readonly MessageRecipient[],
    excludeAgentId: string | null,
  ): Promise<void> {
    const selected = recipients.filter(r => r.agentId !== excludeAgentId);
    const failures: Array<{ agentId: string; err: unknown }> = [];
    await Promise.all(
      selected.map(async r => {
        try {
          await this.runtimeHost.deliverMessage(
            conversationId,
            r.agentId,
            messageId,
          );
        } catch (err) {
          failures.push({ agentId: r.agentId, err });
        }
      }),
    );
    if (failures.length === 0) return;
    // Only touch the DB on the failure path — the success path stays read-free.
    const conversation = this.read.getConversation(conversationId);
    const message = this.read.getMessageById(messageId);
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

  /**
   * Tell the HUMAN AUTHOR that a recipient's runtime could not be reached. Every
   * post-commit delivery path funnels its per-recipient failures here.
   *
   * A workspace-less placement is NOT one of those failures and needs no
   * exemption: `buildRuntimeStartOptions` already emits `workspace: null` with an
   * agent-scoped `runtime_scope`, so a `direct_pair` spawn takes
   * the ordinary path (#task:2019 landed). Every error that arrives here is a real
   * start/deliver failure and is reported as one.
   */
  notifyAgentStartFailureBestEffort(
    conversation: ConversationDto,
    message: MessageDto,
    agentId: string,
    err: unknown,
  ): void {
    if (message.from_kind !== 'user' || !message.from_user_id) return;
    const agent = this.read.getAgent(agentId);
    const error = describeStartFailure(err);
    try {
      const notification = this.write.insertNotification({
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
    conversation: ConversationDto,
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
            this.write.ensureDelivery(
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

  /**
   * Drive the post-commit half of the mention CC (v71, §5). The copies, their
   * durable inbox rows and the author's `mention_external` notifications are
   * ALREADY COMMITTED by the send transaction; what happens here is the wake,
   * the WS frames and the skip log — none of which can be committed, and none of
   * which can lose a mention if it fails.
   *
   * The `try/catch` therefore guards effects only. It does NOT mean "the CC is
   * best-effort": the decision to copy was transactional, and a `throw` from the
   * write half already rolled the human's send back rather than silently
   * dropping the copy.
   */
  async dispatchMentionCcBestEffort(report: MentionCcReport): Promise<void> {
    try {
      await dispatchMentionCcEffects(report, {
        runtimeStart: this.runtimeHost,
        runtimeDeliver: this.runtimeHost,
        events: this.events,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.warn(
        {
          conversationId: report.source.conversationId,
          messageId: report.source.messageId,
          err,
        },
        'conversation-message-service: mention cc effects failed (copies are committed)',
      );
    }
  }

  /**
   * Wake the recipients that are not already running (§ auto-start).
   *
   * The "already running" fact comes from the agent's RUNTIME SEAT
   * (`runtimeSeatStatus`), not from a membership row's projected `status` column:
   * the recipient unit is a principal id now, and a `direct_pair` participant
   * has a seat but no membership row at all, so the old pre-filter
   * could not have answered for one (#task:2021 P4-5). The RULE — which statuses
   * count as running — stays here, where a test of the use case can see it; the
   * port only reports the status.
   *
   * It remains a PRE-FILTER, not the authority: `AgentRuntimeHost.start` re-checks
   * the live phase before spawning. What this avoids is asking the host to
   * re-examine every already-busy recipient on every send.
   */
  async startIdleRecipientsBestEffort(
    conversation: ConversationDto,
    message: MessageDto,
    recipients: readonly MessageRecipient[],
  ): Promise<void> {
    await Promise.all(
      recipients
        .filter(r => {
          const status = this.read.runtimeSeatStatus(conversation.id, r.agentId);
          return status !== 'active' && status !== 'starting';
        })
        .map(async r => {
          try {
            await this.runtimeHost.start(conversation.id, r.agentId);
          } catch (err) {
            this.notifyAgentStartFailureBestEffort(
              conversation,
              message,
              r.agentId,
              err,
            );
            this.logger.warn(
              { conversationId: conversation.id, agentId: r.agentId, err },
              'conversation-message-service: auto-start on message send failed',
            );
          }
        }),
    );
  }
}
