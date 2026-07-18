// Post-commit task announcement side-effects: the system narrative message, the
// `task_changed` conversation + per-viewer board events, best-effort per-recipient
// delivery, and the cross-conversation audit line. Every task mutation, after it
// commits, hands its result snapshot here. Nothing in this file decides task
// policy — it only broadcasts an already-committed change.
//
// Split for the create flow (H4): `emitSystemMessage` inserts the task system
// event INSIDE the caller's transaction so `task create` can backfill the
// task's `created_event_message_id` in the same write; `publish` fans out the
// events + delivery AFTER commit. `broadcast` bundles both for the mutation
// paths (claim/unclaim/status), whose system event has no in-txn dependency.
import type { Database as Db } from 'better-sqlite3';
import {
  type ConversationDto,
  type MessageDto,
  type TaskAssigneeDto,
  type TaskChangedEvent,
  type TaskMutationKind,
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
import type { AgentActor, TaskActor } from './contracts.js';

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

/** The viewer-invariant snapshot of a task after a mutation — everything the
 *  system event, the `task_changed` payload, and delivery need. */
export interface TaskEventArgs {
  conversation: ConversationDto;
  kind: TaskChangedEvent['kind'];
  /** The task identity (`tasks.id`) — the key consumers converge on. */
  taskId: string;
  taskNumber: number;
  title: string;
  /** Status snapshot AFTER this mutation. */
  status: TaskStatus;
  assignee: TaskAssigneeDto | null;
  closedAt: number | null;
  /** The task's immutable source message id (null when sourceless), so a
   *  consumer can live-patch that source row's `linked_task` chip. */
  sourceMessageId: string | null;
  /** The task's thread placement within its conversation (null = main-line). */
  threadRootId: string | null;
}

/** Workflow transitions — the events that broadcast to EVERY conversation agent
 *  (`broadcast` → `publish`). `edit` is deliberately excluded: a definition
 *  change is not a coordination fact and must not wake idle agents. */
export type TaskWorkflowKind = Extract<TaskMutationKind, 'claim' | 'unclaim' | 'status'>;
/** Kinds the all-member `publish` fan-out accepts: workflow + `create`, i.e.
 *  everything EXCEPT `edit`. `edit` has its own targeted path (`publishEdit`),
 *  so the type forbids it from ever reaching the all-member deliver loop — a
 *  future refactor that tried would fail to compile, not silently wake everyone. */
export type TaskPublishKind = Exclude<TaskMutationKind, 'edit'>;

export class TaskBroadcaster {
  private readonly db: Db;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly conversations: ConversationRepo;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(deps: TaskBroadcasterDeps) {
    this.db = deps.db;
    this.messages = deps.messages;
    this.agents = deps.agents;
    this.conversations = deps.conversations;
    this.runtimeHost = deps.runtimeHost;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /** Render a `TaskActor` into the structured `TaskSystemActor` embedded in task
   *  system metadata (renderers draw an actor pill without parsing content). */
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
   *  conversation/workspace boundary. Lightweight audit trail (no visible
   *  system message hook). */
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
    // warn-level (not info) per Cindy `JLdi59K-TD11CAWy`: backend default log
    // level is `warn`, so info lines never reach disk. Framed as an audit line,
    // not an exception.
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

  /** Insert the task system-event message. Runs inside the CALLER's transaction
   *  (no own wrapper), so `task create` can capture the returned id and backfill
   *  `tasks.created_event_message_id` atomically, and `task edit` can commit the
   *  UPDATE and this INSERT together (a committed edit always has its anchor). */
  emitSystemMessage(args: TaskEventArgs & {
    kind: TaskMutationKind;
    actor: TaskActor;
    sysMessage: string;
  }): MessageDto {
    const systemActor: TaskSystemActor = this.taskSystemActor(args.actor);
    return this.messages.insertForConversation({
      conversationId: args.conversation.id,
      fromKind: 'system',
      content: args.sysMessage,
      threadRootId: args.threadRootId,
      metadata: {
        subtype: taskSystemSubtype(args.kind),
        task_number: args.taskNumber,
        task_status: args.status,
        task_id: args.taskId,
        task_title: args.title,
        task_assignee: args.assignee,
        actor: systemActor,
      },
    });
  }

  /** Fan out an already-inserted system event: publish the `message` event, the
   *  `task_changed` events, and best-effort per-recipient delivery to EVERY
   *  conversation agent. Called AFTER the mutation (and, for create, the event
   *  insert) commits. Rejects `edit` at the type level — a definition change
   *  wakes only its assignee (`publishEdit`), never every member. */
  publish(args: TaskEventArgs & { kind: TaskPublishKind }, sysMsg: MessageDto): void {
    const conversationId = args.conversation.id;
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    this.publishTaskChanged(args);

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

  /** Fan out an already-inserted `task_edit` event. Splits the two axes a
   *  definition change lives on:
   *   - CONVERSATION-visible (READ axis): the `message` event + `task_changed`
   *     go to everyone with read access, exactly like the workflow events — the
   *     edit is durable conversation history and live-patches the board/chip.
   *   - RUNTIME WAKE (attention axis): `deliverMessage` goes to the CURRENT
   *     assignee agent ONLY, and only while the task is still executable
   *     (non-terminal) and the editor is not that same assignee. No assignee /
   *     a human assignee / a done|closed task / a self-edit → durable event +
   *     board only, no wake. This targets "whoever is building to this spec"
   *     without spending idle agents' attention or looping a self-wake. */
  publishEdit(args: TaskEventArgs & { kind: 'edit' }, sysMsg: MessageDto, editor: TaskActor): void {
    const conversationId = args.conversation.id;
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    this.publishTaskChanged(args);

    const assignee = args.assignee;
    const terminal = args.status === 'done' || args.status === 'closed';
    const editorIsAssignee =
      editor.kind === 'agent' && assignee?.type === 'agent' && editor.agentId === assignee.id;
    if (assignee?.type === 'agent' && !terminal && !editorIsAssignee) {
      void this.runtimeHost
        .deliverMessage(conversationId, assignee.id, sysMsg.id)
        .catch(err => {
          this.logger.warn(
            { err, conversationId, agentId: assignee.id, messageId: sysMsg.id },
            'task-service: edit deliverMessage failed',
          );
        });
    }
  }

  /** Convenience for the workflow paths (claim/unclaim/status): insert the
   *  system event in its own transaction, then publish + deliver to all members.
   *  Typed to workflow kinds only — `create` publishes directly and `edit` uses
   *  `publishEdit`, so neither routes here. */
  async broadcast(args: TaskEventArgs & {
    kind: TaskWorkflowKind;
    actor: TaskActor;
    sysMessage: string;
  }): Promise<void> {
    const sysMsg = this.db.transaction(() => this.emitSystemMessage(args))();
    this.publish(args, sysMsg);
  }

  publishTaskChanged(args: TaskEventArgs): void {
    const conversationId = args.conversation.id;
    const workspaceId = args.conversation.workspace_id;
    // A task-bearing conversation is always a channel-like top-level
    // conversation (#task:1303), so channel_id is its own id.
    const event: TaskChangedEvent = {
      kind: args.kind,
      workspace_id: workspaceId,
      channel_id: conversationId,
      thread_root_id: args.threadRootId,
      conversation_id: conversationId,
      task_number: args.taskNumber,
      task_id: args.taskId,
      source_message_id: args.sourceMessageId,
      status: args.status,
      assignee: args.assignee,
      title: args.title,
      closed_at: args.closedAt,
    };
    this.events.publish(conversationId, { kind: 'task_changed', payload: event });
    // Cross-conversation board fanout (the workspace task drawer) is the MUTATION
    // /control axis, so it is member-gated — NOT workspace-wide. Publishing to
    // `workspace:<id>` would leak a PRIVATE channel's task snapshot (title/status
    // /assignee + source_message_id) to every workspace member, contradicting the
    // `task list` conversation-membership gate. Fan out per-viewer to the task
    // conversation's HUMAN members instead. The public-read axis is served
    // separately by `conversation:<id>` above + the HTTP `linked_task` projection
    // — both channel-read-scoped.
    for (const member of this.conversations.listUsers(conversationId)) {
      this.events.publishToScope(`viewer:${member.user_id}`, 'task_changed', event);
    }
  }
}
