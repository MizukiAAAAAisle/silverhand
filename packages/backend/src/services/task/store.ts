// Task-aggregate persistence gateway: every SQL read and write over the
// first-class `tasks` table (v60), plus the row → DTO projection and the
// per-viewer navigation resolution. The facade delegates its public reads
// (`list` / `getById`) here and calls the low-level fetch / allocate / stamp
// helpers inside its own transactions (same `db` handle ⇒ same transaction).
// No task-lifecycle policy lives here — only row access, the read-side
// membership gate, and nav resolution.
import { randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type {
  TaskAssigneeDto,
  TaskCreatorDto,
  TaskDetailDto,
  TaskEditorDto,
  TaskNavDto,
  TaskNavRef,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import { USER_VISIBLE_TASK_PREDICATE } from '../../repos/task-board-population.js';
import { prepareObserved } from '../../observability/observed-statement.js';
import {
  userCanAccessConversation,
  type ListTasksFilters,
  type MessageRef,
  type ResolvedTaskRow,
  type TaskActor,
  type UserActor,
} from './contracts.js';

/** Fresh opaque task identity (same scheme as message ids). */
function newTaskId(): string {
  return randomBytes(12).toString('base64url');
}

/** The joined row shape both this store and the board read face project from
 *  (one projection, one DTO — see `taskJoinedToSummary`). */
export interface TaskJoinedRow {
  id: string;
  conversation_id: string;
  task_number: number;
  status: TaskStatus;
  title: string;
  closed_at: number | null;
  workspace_id: string;
  workspace_name: string;
  channel_name: string;
  thread_root_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  creator_user_id: string | null;
  created_at: number;
  conversation_title: string;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
}

/** The task-summary SELECT list + joins. Exported because the human board read
 *  face (`services/task/board.ts`) must project tasks THROUGH THE SAME columns
 *  and joins — a second hand-written SELECT would be a second projection that
 *  drifts (e.g. a deleted creator rendering differently in the board than in
 *  the CLI/list). The `tasks`→`conversations`/`workspaces` joins are INNER and
 *  cannot drop rows: both columns are NOT NULL with ON DELETE CASCADE, so the
 *  count face (which needs no joins) describes the same set. */
export const SELECT_TASK_JOINED = `
  SELECT
    t.id                       AS id,
    t.conversation_id          AS conversation_id,
    t.task_number              AS task_number,
    t.status                   AS status,
    t.title                    AS title,
    t.closed_at                AS closed_at,
    t.workspace_id             AS workspace_id,
    conv.title                 AS channel_name,
    t.thread_root_id           AS thread_root_id,
    t.assignee_agent_id        AS assignee_agent_id,
    t.assignee_user_id         AS assignee_user_id,
    t.creator_kind             AS creator_kind,
    t.creator_agent_id         AS creator_agent_id,
    t.creator_user_id          AS creator_user_id,
    t.created_at               AS created_at,
    conv.title                 AS conversation_title,
    w.name                     AS workspace_name,
    aa.display_name            AS assignee_agent_name,
    au.display_name            AS assignee_user_name,
    ca.display_name            AS creator_agent_name,
    cu.display_name            AS creator_user_name
  FROM tasks t
  JOIN conversations conv ON conv.id = t.conversation_id
  JOIN workspaces w ON w.id = t.workspace_id
  LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
  LEFT JOIN users au ON au.id = t.assignee_user_id
  LEFT JOIN agents ca ON ca.id = t.creator_agent_id
  LEFT JOIN users cu ON cu.id = t.creator_user_id
`;

/** The shared column set the mutation paths read as a `ResolvedTaskRow`. */
const SELECT_RESOLVED_TASK = `
  SELECT
    t.id, t.conversation_id AS conversation_id, t.task_number, t.workspace_id,
    t.status, t.closed_at, t.assignee_agent_id, t.assignee_user_id,
    t.title, t.content, t.thread_root_id, t.source_message_id,
    t.created_event_message_id, t.creator_kind, t.creator_agent_id,
    c.title AS owner_conversation_title
  FROM tasks t
  JOIN conversations c ON c.id = t.conversation_id
`;

export interface TaskStoreDeps {
  db: Db;
  conversations: ConversationRepo;
}

export class TaskStore {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
  }

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];

    if (filters.actor.kind === 'agent') {
      // The agent path defaults to the actor's current workspace. The route
      // layer validates any explicit `filters.workspaceId` (from the agent's
      // `--workspace-id` flag) exists AND that the agent is a member. Once
      // validated, honor the explicit value so the agent can read a sister
      // workspace's board.
      const conv = this.conversations.get(filters.actor.conversationId);
      if (!conv) return [];
      const effectiveWs = filters.workspaceId ?? conv.workspace_id;
      clauses.push('t.workspace_id = ?');
      args.push(effectiveWs);
    } else {
      // The human visibility gate is the SHARED constant (also interpolated by
      // every board read face) — "which tasks may this viewer see" has one
      // definition, so the CLI/list face and the paginated board can never
      // disagree about it.
      clauses.push(USER_VISIBLE_TASK_PREDICATE);
      args.push(filters.actor.userId);
      if (filters.workspaceId) {
        clauses.push('t.workspace_id = ?');
        args.push(filters.workspaceId);
      }
    }

    if (filters.conversationId) {
      clauses.push('t.conversation_id = ?');
      args.push(filters.conversationId);
    }
    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => '?').join(',');
      clauses.push(`t.status IN (${placeholders})`);
      args.push(...filters.status);
    }
    if (filters.taskNumbers && filters.taskNumbers.length > 0) {
      const placeholders = filters.taskNumbers.map(() => '?').join(',');
      clauses.push(`t.task_number IN (${placeholders})`);
      args.push(...filters.taskNumbers);
    }
    if (filters.assigneeAgentId) {
      clauses.push('t.assignee_agent_id = ?');
      args.push(filters.assigneeAgentId);
    }
    // Newest-first: task_number is a monotonic per-workspace sequence, so DESC
    // surfaces the most recently created tasks first — the useful default for
    // both the desktop kanban columns and the CLI `task list`.
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `${SELECT_TASK_JOINED} ${where} ORDER BY t.task_number DESC`;
    if (filters.limit && filters.limit > 0) {
      sql += ' LIMIT ?';
      args.push(filters.limit);
    }
    const rows = prepareObserved<typeof args, TaskJoinedRow>(
      this.db,
      'tasks.list_filtered',
      sql,
    ).all(...args);
    return rows.map(r => taskJoinedToSummary(r));
  }

  /**
   * ONE gated summary read: the summary projection narrowed by `where`, then the
   * read-side membership gate, then the row → DTO projection. Every key form a
   * single-task summary can be looked up by goes through here, so no key gets
   * its own SELECT (a second projection drifts) or its own gate (a second gate
   * is a second answer to "may this viewer see it").
   */
  private readGatedSummary(
    queryName: string,
    where: string,
    args: (string | number)[],
    actor: TaskActor,
    authorizedWorkspaceId?: string,
  ): TaskSummaryDto | null {
    const row = prepareObserved<typeof args, TaskJoinedRow>(
        this.db,
        queryName,
        `${SELECT_TASK_JOINED} ${where}`,
      )
      .get(...args);
    if (!row) return null;
    if (actor.kind === 'agent') {
      if (authorizedWorkspaceId !== undefined) {
        if (row.workspace_id !== authorizedWorkspaceId) return null;
      } else {
        const conv = this.conversations.get(actor.conversationId);
        if (!conv) return null;
        if (row.workspace_id !== conv.workspace_id) return null;
      }
    } else if (!userCanAccessConversation(this.db, actor.userId, row.conversation_id)) {
      return null;
    }
    return taskJoinedToSummary(row);
  }

  /**
   * Read a task summary by its identity (`tasks.id`).
   *
   * `authorizedWorkspaceId` is the workspace the CALLER has already resolved and
   * authorized the actor against (membership verified upstream). When present,
   * the agent gate is `task.workspace_id === authorizedWorkspaceId` (so a
   * cross-workspace read the service authorized succeeds, and a leaked task id
   * still can't escape the authorized scope). When omitted, the legacy gate
   * applies: the task must live in the agent's CURRENT conversation's workspace.
   * The user gate (conversation access) is unchanged.
   */
  getById(
    taskId: string,
    actor: TaskActor,
    authorizedWorkspaceId?: string,
  ): TaskSummaryDto | null {
    return this.readGatedSummary(
      'tasks.get_joined_by_id',
      'WHERE t.id = ?',
      [taskId],
      actor,
      authorizedWorkspaceId,
    );
  }

  /**
   * Read a task summary by the workspace-scoped business key `(workspace_id,
   * task_number)` — the key an inline `#task:<n>` sigil carries. A SINGLE
   * bounded read on `uniq_tasks_workspace_number`: same projection and same gate
   * as `getById`, so a pill never pays for the mutation-path column set (which
   * reads `t.content`) nor for a second query to reach the summary it renders.
   *
   * User actor only — the sigil face is human-facing, so the gate is always the
   * viewer's access to the task's OWN conversation and `workspaceId` is a lookup
   * key, never an authorization claim.
   */
  getByNumber(
    workspaceId: string,
    taskNumber: number,
    actor: UserActor,
  ): TaskSummaryDto | null {
    return this.readGatedSummary(
      'tasks.get_joined_by_number',
      'WHERE t.workspace_id = ? AND t.task_number = ?',
      [workspaceId, taskNumber],
      actor,
    );
  }

  /**
   * Full single-task read for the detail modal: the summary fields plus full
   * content, last-editor attribution, the raw provenance `source_message_id`,
   * and the per-viewer-resolved `nav` discriminant. Access to the task reuses
   * `getById` (same membership gate, including the cross-workspace
   * `authorizedWorkspaceId` form).
   */
  fetchTaskDetail(
    taskId: string,
    actor: TaskActor,
    authorizedWorkspaceId?: string,
  ): TaskDetailDto | null {
    const summary = this.getById(taskId, actor, authorizedWorkspaceId);
    if (!summary) return null;
    const extra = prepareObserved<[string], {
        content: string;
        source_message_id: string | null;
        created_event_message_id: string | null;
        last_edited_at: number | null;
        last_editor_kind: 'agent' | 'user' | null;
        last_editor_id: string | null;
        editor_agent_name: string | null;
        editor_user_name: string | null;
      }>(
        this.db,
        'tasks.fetch_detail_extra',
        `SELECT t.content,
                t.source_message_id,
                t.created_event_message_id,
                t.last_edited_at,
                t.last_editor_kind,
                t.last_editor_id,
                ea.display_name AS editor_agent_name,
                eu.display_name AS editor_user_name
           FROM tasks t
           LEFT JOIN agents ea ON ea.id = t.last_editor_id AND t.last_editor_kind = 'agent'
           LEFT JOIN users eu ON eu.id = t.last_editor_id AND t.last_editor_kind = 'user'
          WHERE t.id = ?`,
      )
      .get(taskId);
    if (!extra) return null;

    return {
      ...summary,
      content: extra.content,
      last_editor: resolveEditor(extra),
      last_edited_at: extra.last_edited_at,
      source_message_id: extra.source_message_id,
      nav: this.resolveNav(actor, extra.source_message_id, extra.created_event_message_id),
    };
  }

  /**
   * Resolve the "View in conversation" navigation discriminant per-viewer.
   * BRANCH model (never a silent fallback):
   *   - A DECLARED source that the viewer can read → `source`; a declared
   *     source the viewer cannot read (or that was deleted) → `unavailable`
   *     (NEVER falls back to the event — the nav semantic is "go to source").
   *   - No source: the persisted task-created event, if resolvable/readable →
   *     `created_event`; else `unavailable`.
   */
  private resolveNav(
    actor: TaskActor,
    sourceMessageId: string | null,
    createdEventMessageId: string | null,
  ): TaskNavDto {
    if (sourceMessageId !== null) {
      const ref = this.resolveMessageNavRef(actor, sourceMessageId);
      return ref ? { kind: 'source', ref } : { kind: 'unavailable' };
    }
    if (createdEventMessageId !== null) {
      const ref = this.resolveMessageNavRef(actor, createdEventMessageId);
      return ref ? { kind: 'created_event', ref } : { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }

  /** Resolve a message id to a viewer-readable nav ref, or null when the
   *  message is gone or the viewer cannot read its conversation. `channel_id`
   *  is the message's own conversation id (threads are reply clusters, not
   *  standalone conversations). */
  private resolveMessageNavRef(actor: TaskActor, messageId: string): TaskNavRef | null {
    const msg = prepareObserved<[string], { conversation_id: string; thread_root_id: string | null }>(
        this.db,
        'tasks.resolve_message_nav_ref',
        `SELECT conversation_id, thread_root_id FROM messages WHERE id = ?`,
      )
      .get(messageId);
    if (!msg) return null;
    if (!this.viewerCanAccessConversation(actor, msg.conversation_id)) return null;
    return {
      channel_id: msg.conversation_id,
      thread_root_id: msg.thread_root_id,
      message_id: messageId,
    };
  }

  /** Whether the acting viewer can currently read a conversation (agent =
   *  member of that conversation; user = member row). */
  private viewerCanAccessConversation(actor: TaskActor, conversationId: string): boolean {
    if (actor.kind === 'agent') {
      return this.conversations.getAgent(conversationId, actor.agentId) != null;
    }
    return userCanAccessConversation(this.db, actor.userId, conversationId);
  }

  /** Next per-workspace monotonic task number (1-based). Guarded by
   *  `uniq_tasks_workspace_number`; a concurrent create races on that index. */
  private allocateTaskNumber(workspaceId: string): number {
    const row = prepareObserved<[string], { next: number }>(
        this.db,
        'tasks.allocate_task_number',
        `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
         FROM tasks WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    return row?.next ?? 1;
  }

  /**
   * The single task-aggregate creator: allocate the next workspace-scoped task
   * number and insert the `tasks` row. Transaction-agnostic — runs inside the
   * caller's transaction (the create txn also emits the task_create event and
   * backfills `created_event_message_id`). Returns the new task id + number.
   *
   * `opts.sourceMessageId` sets the immutable RAW provenance link (permanent 1:1
   * — the UNIQUE index enforces it; a duplicate throws a SqliteError the caller
   * maps to `source_conflict`). `opts.claimByAgentId` atomically self-claims:
   * the row lands `in_progress` + assigned instead of unassigned `todo`.
   */
  createTaskRow(args: {
    workspaceId: string;
    conversationId: string;
    threadRootId: string | null;
    title: string;
    content: string;
    creatorKind: 'agent' | 'user';
    creatorAgentId: string | null;
    creatorUserId: string | null;
    sourceMessageId: string | null;
    claimByAgentId: string | null;
    createdAt: number;
  }): { id: string; taskNumber: number } {
    const id = newTaskId();
    const taskNumber = this.allocateTaskNumber(args.workspaceId);
    const status: TaskStatus = args.claimByAgentId ? 'in_progress' : 'todo';
    prepareObserved(
        this.db,
        'tasks.insert_row',
        `INSERT INTO tasks (
           id, workspace_id, task_number, conversation_id, thread_root_id,
           title, content, status, assignee_agent_id, assignee_user_id,
           creator_kind, creator_agent_id, creator_user_id,
           source_message_id, created_event_message_id,
           last_editor_kind, last_editor_id, last_edited_at,
           created_at, closed_at
         ) VALUES (
           @id, @workspace_id, @task_number, @conversation_id, @thread_root_id,
           @title, @content, @status, @assignee_agent_id, NULL,
           @creator_kind, @creator_agent_id, @creator_user_id,
           @source_message_id, NULL,
           NULL, NULL, NULL,
           @created_at, NULL
         )`,
      )
      .run({
        id,
        workspace_id: args.workspaceId,
        task_number: taskNumber,
        conversation_id: args.conversationId,
        thread_root_id: args.threadRootId,
        title: args.title,
        content: args.content,
        status,
        assignee_agent_id: args.claimByAgentId,
        creator_kind: args.creatorKind,
        creator_agent_id: args.creatorAgentId,
        creator_user_id: args.creatorUserId,
        source_message_id: args.sourceMessageId,
        created_at: args.createdAt,
      });
    return { id, taskNumber };
  }

  /** Stamp the persisted task-created system-event message id (the nav ref for
   *  a sourceless task). Called in the same txn as `createTaskRow`. */
  backfillCreatedEvent(taskId: string, messageId: string): void {
    prepareObserved(
        this.db,
        'tasks.backfill_created_event',
        `UPDATE tasks SET created_event_message_id = ? WHERE id = ?`,
      )
      .run(messageId, taskId);
  }

  /** Find the task (if any) already bound to a source message. A source is a
   *  permanent 1:1 identity key, so this returns at most one row regardless of
   *  the task's status. Used to translate a source-uniqueness conflict into a
   *  typed `source_conflict` pointing at the existing task. */
  fetchTaskBySourceMessageId(sourceMessageId: string): {
    task_number: number;
    id: string;
    status: TaskStatus;
  } | null {
    const row = prepareObserved<[string], { task_number: number; id: string; status: TaskStatus }>(
        this.db,
        'tasks.fetch_by_source_message_id',
        `SELECT task_number, id, status FROM tasks WHERE source_message_id = ?`,
      )
      .get(sourceMessageId);
    return row ?? null;
  }

  /**
   * Last-write-wins edit of the task definition (title/content), inside the
   * caller's transaction. A plain UPDATE by task id — no optimistic-concurrency
   * guard (task edits are low-contention, so CAS/`revision` would not pay off).
   * A `null` title/content leaves that field unchanged (partial edit); an
   * empty-string content clears the body. Stamps the last editor; never touches
   * status or assignee. Returns true when the row existed and was updated.
   */
  applyTaskEdit(args: {
    taskId: string;
    title: string | null;
    content: string | null;
    editorKind: 'agent' | 'user';
    editorId: string;
    editedAt: number;
  }): boolean {
    const res = prepareObserved(
        this.db,
        'tasks.apply_edit',
        `UPDATE tasks
         SET title = COALESCE(?, title),
             content = COALESCE(?, content),
             last_editor_kind = ?,
             last_editor_id = ?,
             last_edited_at = ?
         WHERE id = ?`,
      )
      .run(
        args.title,
        args.content,
        args.editorKind,
        args.editorId,
        args.editedAt,
        args.taskId,
      );
    return res.changes > 0;
  }

  fetchTaskByNumber(workspaceId: string, taskNumber: number): ResolvedTaskRow | null {
    const row = prepareObserved<[string, number], ResolvedTaskRow>(
        this.db,
        'tasks.fetch_by_number',
        `${SELECT_RESOLVED_TASK} WHERE t.workspace_id = ? AND t.task_number = ?`,
      )
      .get(workspaceId, taskNumber);
    return row ?? null;
  }

  fetchTaskById(taskId: string): ResolvedTaskRow | null {
    const row = prepareObserved<[string], ResolvedTaskRow>(
        this.db,
        'tasks.fetch_by_id',
        `${SELECT_RESOLVED_TASK} WHERE t.id = ?`,
      )
      .get(taskId);
    return row ?? null;
  }

  /** Locate a message for create's thread-target resolution and source
   *  validation. A message is never a task, so this returns only its location. */
  fetchMessageRef(messageId: string): MessageRef | null {
    const row = prepareObserved<[string], MessageRef>(
        this.db,
        'tasks.fetch_message_ref',
        `SELECT id, conversation_id AS conversation_id, thread_root_id
         FROM messages WHERE id = ?`,
      )
      .get(messageId);
    return row ?? null;
  }

  // ── Mutation writes (run inside the caller's transaction) ──────────

  /** Atomic self-claim: assign the agent + advance a `todo` task to
   *  `in_progress`, but ONLY while unassigned and not terminal. "Unassigned"
   *  means BOTH assignee columns are null — a migrated row can legally hold an
   *  `assignee_user_id`, and writing an agent over it would leave two assignees
   *  on the row (a schema CHECK violation surfacing as a raw SQLite error).
   *  Returns the number of rows changed (0 = lost the race / already assigned to
   *  someone / terminal). */
  assignSelf(taskId: string, agentId: string): number {
    const res = prepareObserved(
        this.db,
        'tasks.assign_self',
        `UPDATE tasks
         SET assignee_agent_id = ?,
             status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END
         WHERE id = ?
           AND assignee_agent_id IS NULL
           AND assignee_user_id IS NULL
           AND status NOT IN ('done', 'closed')`,
      )
      .run(agentId, taskId);
    return res.changes;
  }

  /** Current assignment snapshot — the claim-miss re-read. Reads BOTH assignee
   *  columns because either one makes the task "taken": classifying a
   *  user-assigned row by the agent column alone reports the miss as
   *  `task_done`, a fact that is simply false. */
  readAssignment(taskId: string): {
    assignee_agent_id: string | null;
    assignee_user_id: string | null;
    status: TaskStatus;
  } | null {
    const row = prepareObserved<
      [string],
      { assignee_agent_id: string | null; assignee_user_id: string | null; status: TaskStatus }
    >(
        this.db,
        'tasks.read_assignment',
        `SELECT assignee_agent_id, assignee_user_id, status FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    return row ?? null;
  }

  /** Human dispatch (assign / reassign): set the assignee AND start a `todo`
   *  task. Handing a `todo` task to an agent IS dispatching the work, so the row
   *  must not be left in `todo + assignee` — that state has no exit (`task
   *  status` cannot walk `todo → in_progress`, §3.2, and the agent's own
   *  `assignSelf` refuses an already-assigned row). A task that is already
   *  `in_progress` / `in_review` only changes hands: reassignment is not a
   *  restart, so an `in_review` task keeps its place in the human approval
   *  queue. Both assignee columns are written every time — the row must never
   *  carry two assignees (the schema CHECK), and the DTO exposes a single
   *  `assignee`, so a migrated user-assigned row has to be overridden as well.
   *  Terminal rows never reach here (the caller refuses them, §4.4). */
  dispatchToAgent(taskId: string, agentId: string): void {
    prepareObserved(
        this.db,
        'tasks.dispatch_to_agent',
        `UPDATE tasks
         SET assignee_agent_id = ?,
             assignee_user_id = NULL,
             status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END
         WHERE id = ?`,
      )
      .run(agentId, taskId);
  }

  /** Human unassign — ownership ONLY. `status` / `closed_at` are never touched:
   *  "this is no longer @X's" is not "this work restarted / reopened", so an
   *  `in_review` task keeps its place in the human approval queue and a
   *  dispatched task does not rewind to `todo` (only the agent's own release
   *  does that — `releaseToTodo`). Both columns are cleared: a migrated
   *  user-assigned row has to end up unowned too. */
  clearAssignee(taskId: string): void {
    prepareObserved(
        this.db,
        'tasks.clear_assignee',
        `UPDATE tasks SET assignee_agent_id = NULL, assignee_user_id = NULL WHERE id = ?`,
      )
      .run(taskId);
  }

  /** Agent self-release: drop the assignee AND return the task to the pool
   *  (`todo`, no close timestamp) — the agent is declaring it stopped working,
   *  so the workflow rewinds with the assignment. The human unassign write goes
   *  through `clearAssignee`, which never does this. */
  releaseToTodo(taskId: string): void {
    prepareObserved(
        this.db,
        'tasks.release_to_todo',
        `UPDATE tasks SET assignee_agent_id = NULL, status = 'todo', closed_at = NULL WHERE id = ?`,
      )
      .run(taskId);
  }

  /** Status transition write. `closedAt` is set IFF the new status is 'closed'
   *  (the CHECK enforces the invariant). */
  setStatus(taskId: string, status: TaskStatus, closedAt: number | null): void {
    prepareObserved(
        this.db,
        'tasks.set_status',
        `UPDATE tasks SET status = ?, closed_at = ? WHERE id = ?`,
      )
      .run(status, closedAt, taskId);
  }

  /** Fresh post-mutation snapshot for the broadcast payload. */
  refetchTaskSnapshot(taskId: string): {
    title: string;
    status: TaskStatus;
    closed_at: number | null;
    assignee: TaskAssigneeDto | null;
  } | null {
    const row = prepareObserved<[string], {
        title: string;
        status: TaskStatus;
        closed_at: number | null;
        assignee_agent_id: string | null;
        assignee_user_id: string | null;
        assignee_agent_name: string | null;
        assignee_user_name: string | null;
      }>(
        this.db,
        'tasks.refetch_snapshot',
        `SELECT t.title,
                t.status,
                t.closed_at,
                t.assignee_agent_id,
                t.assignee_user_id,
                aa.display_name AS assignee_agent_name,
                au.display_name AS assignee_user_name
         FROM tasks t
         LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
         LEFT JOIN users au ON au.id = t.assignee_user_id
         WHERE t.id = ?`,
      )
      .get(taskId);
    if (!row) return null;
    return {
      title: row.title,
      status: row.status,
      closed_at: row.closed_at,
      assignee: assigneeFrom(row),
    };
  }

}

/** Row → `TaskSummaryDto`. Module-level and exported so the board read face
 *  reuses THIS projection rather than repeating it (one row shape, one SELECT,
 *  one DTO). */
export function taskJoinedToSummary(row: TaskJoinedRow): TaskSummaryDto {
  return {
    id: row.id,
    task_number: row.task_number,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    channel_id: row.conversation_id,
    channel_name: row.channel_name,
    thread_root_id: row.thread_root_id,
    conversation: { id: row.conversation_id, title: row.conversation_title },
    status: row.status,
    title: row.title,
    assignee: assigneeFrom(row),
    creator: creatorFrom(row),
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}

/** Build the assignee DTO from a row's assignee columns (name degrades to the
 *  id when the join is missing — deleted/unlinked actor). */
function assigneeFrom(row: {
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  assignee_agent_name: string | null;
  assignee_user_name: string | null;
}): TaskAssigneeDto | null {
  if (row.assignee_agent_id) {
    return {
      type: 'agent',
      id: row.assignee_agent_id,
      name: row.assignee_agent_name ?? row.assignee_agent_id,
    };
  }
  if (row.assignee_user_id) {
    return {
      type: 'user',
      id: row.assignee_user_id,
      name: row.assignee_user_name ?? row.assignee_user_id,
    };
  }
  return null;
}

/** Build the creator DTO from a task row's creator columns. 'system' = the
 *  creating agent/user was since deleted. */
function creatorFrom(row: {
  creator_kind: 'agent' | 'user' | 'system';
  creator_agent_id: string | null;
  creator_user_id: string | null;
  creator_agent_name: string | null;
  creator_user_name: string | null;
}): TaskCreatorDto {
  if (row.creator_kind === 'agent' && row.creator_agent_id) {
    return {
      type: 'agent',
      id: row.creator_agent_id,
      name: row.creator_agent_name ?? row.creator_agent_id,
    };
  }
  if (row.creator_kind === 'user' && row.creator_user_id) {
    return {
      type: 'user',
      id: row.creator_user_id,
      name: row.creator_user_name ?? row.creator_user_id,
    };
  }
  return { type: 'system', id: null, name: 'system' };
}

/** Build the last-editor DTO from a row's attribution columns. Null when the
 *  task was never edited; name degrades to the id when the attribution join is
 *  missing (deleted/unlinked actor). */
function resolveEditor(row: {
  last_editor_kind: 'agent' | 'user' | null;
  last_editor_id: string | null;
  editor_agent_name: string | null;
  editor_user_name: string | null;
}): TaskEditorDto | null {
  if (!row.last_editor_kind || !row.last_editor_id) return null;
  const name =
    row.last_editor_kind === 'agent'
      ? (row.editor_agent_name ?? row.last_editor_id)
      : (row.editor_user_name ?? row.last_editor_id);
  return { kind: row.last_editor_kind, id: row.last_editor_id, name };
}
