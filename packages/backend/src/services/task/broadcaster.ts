// Post-commit task announcement side-effects: the `task_changed` conversation
// + per-viewer board events, best-effort per-recipient delivery, and the
// cross-conversation audit line. Every task mutation, after its transaction
// COMMITS, hands its result snapshot here. Nothing in this file decides task
// policy and — since #task:1980 — NOTHING here opens or owns a transaction:
// the system-event message row is inserted INSIDE the mutation's UnitOfWork
// scope (via `TaskSystemEventPort`), and this file only publishes / delivers /
// audits the already-durable row.
import {
  requireWorkspacePlacement,
  type ConversationDto,
  type MessageDto,
  type TaskAssigneeDto,
  type TaskChangedEvent,
  type TaskMutationKind,
  type TaskStatus,
} from '@silverhand/shared';
import type { BackendLogger } from '../../context.js';
import type { AgentRuntimeHost } from '../../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../../ws/scope-event-bus.js';
import type { AgentActor, TaskActor } from './contracts.js';
import type { TaskConversationAccessPort } from './ports.js';

export interface TaskBroadcasterDeps {
  conversations: TaskConversationAccessPort;
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
 *  (`publish`), the actor included. `edit` is routed separately
 *  (`publishEdit`) — not because it wakes fewer agents (since #task:1542 it
 *  wakes every member too) but because it alone skips the editor's own
 *  self-wake. */
export type TaskWorkflowKind = Extract<TaskMutationKind, 'claim' | 'unclaim' | 'status'>;
/** Kinds the `publish` fan-out accepts: workflow + `create`, i.e. everything
 *  EXCEPT `edit`. `edit` fans out to the same all-member set but through
 *  `publishEdit` (which excludes the editor), so the type keeps it off the
 *  editor-blind `publish` path — a refactor that routed edit here would fail to
 *  compile, not silently self-wake the editor. */
export type TaskPublishKind = Exclude<TaskMutationKind, 'edit'>;

export class TaskBroadcaster {
  private readonly conversations: TaskConversationAccessPort;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;

  constructor(deps: TaskBroadcasterDeps) {
    this.conversations = deps.conversations;
    this.runtimeHost = deps.runtimeHost;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  /** Log a single line per agent task op whenever the call crossed a
   *  conversation/workspace boundary. Lightweight audit trail (no visible
   *  system message hook). */
  auditCrossOp(args: {
    op: 'claim' | 'unclaim' | 'status' | 'create';
    actor: AgentActor;
    sourceConv: ConversationDto;
    ownerConv: ConversationDto;
    taskNumber: number;
    /** The task's board coordinate ('ws:…' | 'pair:…'), placement-derived
     *  post-commit — total over pair boards where a workspace id would not
     *  exist. */
    taskBoardKey: string;
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
        task_board_key: args.taskBoardKey,
        task_number: args.taskNumber,
        cross_workspace: crossWorkspace,
        ...(args.status ? { status: args.status } : {}),
      },
      'task-service: audit cross-conversation task op',
    );
  }

  /** Fan out an already-inserted system event: publish the `message` event, the
   *  `task_changed` events, and best-effort per-recipient delivery to EVERY
   *  conversation agent (the actor included). Called AFTER the mutation (and
   *  the event insert) COMMITS. Rejects `edit` at the type level — edit fans
   *  out to the same all-member set but skips the editor, so it routes through
   *  `publishEdit`. */
  publish(args: TaskEventArgs & { kind: TaskPublishKind }, sysMsg: MessageDto): void {
    const conversationId = args.conversation.id;
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    this.publishTaskChanged(args);
    this.deliverToConversationAgents(conversationId, sysMsg.id);
  }

  /** Best-effort runtime wake: deliver an already-inserted system message to
   *  every agent PARTICIPANT of the conversation, optionally skipping one agent
   *  (the editor, to avoid a self-wake). Participant enumeration is placement-
   *  aware (§4.2): a DirectPair's agent endpoint is a participant with no roster
   *  row, so a roster read (`listAgents`) would wake NOBODY on a pair board.
   *  `listParticipantAgentIds` yields each live participant once, so every
   *  recipient is delivered at most once; a failure is logged, never thrown
   *  (fan-out is best-effort side-effect, not part of the mutation). */
  private deliverToConversationAgents(
    conversationId: string,
    sysMsgId: string,
    excludeAgentId: string | null = null,
  ): void {
    for (const agentId of this.conversations.listParticipantAgentIds(conversationId)) {
      if (agentId === excludeAgentId) continue;
      void this.runtimeHost
        .deliverMessage(conversationId, agentId, sysMsgId)
        .catch(err => {
          this.logger.warn(
            { err, conversationId, agentId, messageId: sysMsgId },
            'task-service: deliverMessage failed',
          );
        });
    }
  }

  /** Fan out an already-inserted `task_edit` event across its two axes:
   *   - CONVERSATION-visible (READ axis): the `message` event + `task_changed`
   *     go to everyone with read access, exactly like the workflow events — the
   *     edit is durable conversation history and live-patches the board/chip.
   *   - RUNTIME WAKE (attention axis): `deliverMessage` wakes EVERY channel
   *     agent member EXCEPT the editor (#task:1542). A definition change is a
   *     channel-coordination fact — dependents build to the spec, reviewers vet
   *     it — so wake is no longer gated on assignee / has-assignee / terminal
   *     status; an unassigned or done/closed task's spec change still wakes the
   *     members who may act on it. The editor is skipped to avoid a self-wake
   *     loop; a human editor is not an agent, so every agent is woken. Each
   *     woken agent re-reads `task detail` to judge whether the moved spec
   *     affects its own execution or review. */
  publishEdit(args: TaskEventArgs & { kind: 'edit' }, sysMsg: MessageDto, editor: TaskActor): void {
    const conversationId = args.conversation.id;
    this.events.publish(conversationId, {
      kind: 'message',
      payload: { message: sysMsg },
    });
    this.publishTaskChanged(args);
    this.deliverToConversationAgents(
      conversationId,
      sysMsg.id,
      editor.kind === 'agent' ? editor.agentId : null,
    );
  }

  publishTaskChanged(args: TaskEventArgs): void {
    const conversationId = args.conversation.id;
    // P0-f: a task board is workspace-placed OR a DirectPair. The event's
    // routing keys are the conversation scopes below; `workspace_id` is a
    // workspace-board-only fact and is null for pair boards (wire schema
    // nullable since #task:2022) — clients place pair frames by
    // conversation/channel id.
    const workspaceId = args.conversation.workspace_id;
    const event: TaskChangedEvent = {
      kind: args.kind,
      workspace_id: workspaceId,
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
    // Cross-conversation board fanout (a viewer's cross-conversation task
    // board / read-model) is the MUTATION
    // /control axis, so it is member-gated — NOT workspace-wide. Publishing to
    // `workspace:<id>` would leak a PRIVATE channel's task snapshot (title/status
    // /assignee + source_message_id) to every workspace member, contradicting the
    // `task list` conversation-membership gate. Fan out per-viewer to the task
    // conversation's HUMAN PARTICIPANTS instead — placement-aware (§4.2), so a
    // DirectPair's human endpoint (rosterless, invisible to `listUsers`) receives
    // its own pair board's frame. The public-read axis is served separately by
    // `conversation:<id>` above + the HTTP `linked_task` projection — both
    // channel-read-scoped.
    for (const userId of this.conversations.listParticipantUserIds(conversationId)) {
      this.events.publishToScope(`viewer:${userId}`, 'task_changed', event);
    }
  }
}
