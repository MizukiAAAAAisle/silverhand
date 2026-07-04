// Post-commit task announcement side-effects: the system narrative message, the
// `task_changed` conversation + workspace-scope events, best-effort per-recipient
// delivery, and the cross-conversation audit line. Every task mutation, after it
// commits, hands its result snapshot here. Nothing in this file decides task
// policy — it only broadcasts an already-committed change.
import type { Database as Db } from 'better-sqlite3';
import {
  type ConversationDto,
  type TaskAssigneeDto,
  type TaskChangedEvent,
  type TaskStatus,
  type TaskSystemActor,
  taskSystemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../../context.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import type { MessageRepo } from '../../repos/message-repo.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import type { TaskStore } from './store.js';
import type { AgentActor, TaskActor, TaskNarrativeKind } from './contracts.js';

export interface TaskBroadcasterDeps {
  db: Db;
  store: TaskStore;
  messages: MessageRepo;
  agents: AgentRepo;
  conversations: ConversationRepo;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
}

export class TaskBroadcaster {
  private readonly db: Db;
  private readonly store: TaskStore;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly conversations: ConversationRepo;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(deps: TaskBroadcasterDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.messages = deps.messages;
    this.agents = deps.agents;
    this.conversations = deps.conversations;
    this.runtimeHost = deps.runtimeHost;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /** Render a `TaskActor` (UserPrincipal | AgentPrincipal) into the
   *  structured `TaskSystemActor` we embed in task system metadata.
   *  Renderers read this to draw an actor pill without parsing
   *  `message.content`. */
  private taskSystemActor(actor: TaskActor): TaskSystemActor {
    if (actor.kind === 'user') {
      return { kind: 'user', id: actor.userId, name: 'user' };
    }
    const agent = this.agents.get(actor.agentId);
    return {
      kind: 'agent',
      id: actor.agentId,
      name: agent?.display_name ?? agent?.name ?? actor.agentId,
    };
  }

  /** Log a single line per agent task op whenever the call crossed a
   *  conversation/workspace boundary (the actor's running conversation
   *  ≠ the task's owner conversation). Lightweight audit trail per
   *  shiki / Cindy decision — no visible system message hook. */
  auditCrossOp(args: {
    op: 'claim' | 'unclaim' | 'status';
    actor: AgentActor;
    sourceConv: ConversationDto;
    ownerConv: ConversationDto;
    taskNumber: number;
    taskWorkspaceId: string;
    status?: TaskStatus;
  }): void {
    if (args.sourceConv.id === args.ownerConv.id) return;
    const crossWorkspace = args.sourceConv.workspace_id !== args.ownerConv.workspace_id;
    // warn-level (not info) per Cindy `JLdi59K-TD11CAWy`: backend
    // default log level since #523 is `warn`, so info lines never make
    // it to disk. The message text is intentionally framed as an
    // audit log line, not an exception, so on-call reading
    // `backend-<utc>.log` recognizes it as routine cross-conv activity
    // rather than a fault.
    this.logger.warn(
      {
        op: 'task_cross_op',
        action: args.op,
        agent_id: args.actor.agentId,
        source_conversation_id: args.sourceConv.id,
        source_workspace_id: args.sourceConv.workspace_id,
        owner_conversation_id: args.ownerConv.id,
        owner_workspace_id: args.ownerConv.workspace_id,
        task_workspace_id: args.taskWorkspaceId,
        task_number: args.taskNumber,
        cross_workspace: crossWorkspace,
        ...(args.status ? { status: args.status } : {}),
      },
      'task-service: audit cross-conversation task op',
    );
  }

  async broadcast(args: {
    conversation: ConversationDto;
    kind: TaskNarrativeKind;
    /** Canonical task body message id — same value for every mutation
     *  on a given task (the row created by `task_create`). Used to
     *  anchor cross-thread / cross-workspace task lookups without
     *  relying on the workspace-scoped `task_number`. */
    messageId: string;
    taskNumber: number;
    title: string;
    /** Status snapshot AFTER this mutation. */
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    closedAt: number | null;
    /** Who triggered the mutation. Rendered as an actor pill on the
     *  task event row instead of being parsed back out of `sysMessage`. */
    actor: TaskActor;
    sysMessage: string;
  }): Promise<void> {
    const conversationId = args.conversation.id;
    const taskMessage = this.store.fetchMessage(args.messageId);
    const threadRootId = taskMessage?.conversation_id === conversationId
      ? taskMessage.thread_root_id
      : null;

    const systemActor: TaskSystemActor = this.taskSystemActor(args.actor);
    const sysMsg = this.db.transaction(() =>
      this.messages.insertForConversation({
        conversationId,
        fromKind: 'system',
        content: args.sysMessage,
        threadRootId,
        metadata: {
          subtype: taskSystemSubtype(args.kind),
          task_number: args.taskNumber,
          task_status: args.status,
          task_message_id: args.messageId,
          task_title: args.title,
          task_assignee: args.assignee,
          actor: systemActor,
        },
      }),
    )();

    // Publish FIRST (matches PR-1/PR-2/PR-3 invariant; today's tasks.ts
    // awaits deliver before publish, this inverts that drift).
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    this.publishTaskChanged({
      conversation: args.conversation,
      kind: args.kind,
      messageId: args.messageId,
      taskNumber: args.taskNumber,
      title: args.title,
      status: args.status,
      assignee: args.assignee,
      closedAt: args.closedAt,
    });

    // Best-effort, fire-and-forget delivery to recipients.
    const recipients = this.conversations.listAgents(conversationId);
    for (const ca of recipients) {
      void this.runtimeHost
        .deliverMessage(conversationId, ca.agent_id, sysMsg.id)
        .catch(err => {
          this.logger.warn(
            { err, conversationId, agentId: ca.agent_id, messageId: sysMsg.id },
            'task-service: deliverMessage failed',
          );
        });
    }
  }

  publishTaskChanged(args: {
    conversation: ConversationDto;
    kind: TaskChangedEvent['kind'];
    messageId: string;
    taskNumber: number;
    title: string;
    status: TaskStatus;
    assignee: TaskAssigneeDto | null;
    closedAt: number | null;
  }): void {
    const conversationId = args.conversation.id;
    const workspaceId = args.conversation.workspace_id;
    // Isolated-thread conversations were retired (#task:1303): a task-bearing
    // conversation is always a channel-like top-level conversation, so
    // channel_id is its own id and the vestigial thread fields are null.
    const channelId = args.conversation.id;
    const taskMessage = this.store.fetchMessage(args.messageId);
    const threadRootId = taskMessage?.conversation_id === conversationId
      ? taskMessage.thread_root_id
      : null;
    const event: TaskChangedEvent = {
      kind: args.kind,
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_root_id: threadRootId,
      legacy_thread_conversation_id: null,
      thread_id: null,
      conversation_id: conversationId,
      task_number: args.taskNumber,
      message_id: args.messageId,
      status: args.status,
      assignee: args.assignee,
      title: args.title,
      closed_at: args.closedAt,
    };
    this.events.publish(conversationId, { kind: 'task_changed', payload: event });
    this.events.publishToScope(`workspace:${workspaceId}`, 'task_changed', event);
  }
}
