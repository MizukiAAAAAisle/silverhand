// Task-aggregate persistence gateway: every SQL read and write over the
// first-class `tasks` table (v60), plus the row → DTO projection hookup and
// the per-viewer navigation resolution (#task:1980 — moved from
// `services/task/store.ts` into the repository zone so task application code
// holds no raw DB capability).
//
// Implements `TaskRepoReadPort` (the only tasks capability the service holds
// outside a transaction) and `TaskRepoWritePort` (exists ONLY inside the task
// UnitOfWork scope). Number allocation is an INTERNAL implementation detail of
// `createTaskRow` — no allocator primitive is exposed to the application, so
// "allocate number then insert row" can never be split into a TOCTOU.
// No task-lifecycle policy lives here — only row access, the read-side
// membership gate, and nav resolution.
import { randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type {
  TaskAssigneeDto,
  TaskDetailDto,
  TaskNavDto,
  TaskNavRef,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import { requireWorkspacePlacement } from '@silverhand/shared';
import {
  assigneeFrom,
  taskJoinedToSummary,
  resolveEditor,
  type TaskJoinedRow,
} from '../services/task/dto.js';
import { agentParticipates } from './conversation-placement-sql.js';
import type {
  ListTasksFilters,
  MessageRef,
  ResolvedTaskRow,
  TaskActor,
  UserActor,
} from '../services/task/contracts.js';
import type {
  TaskConversationAccessPort,
  TaskRepoReadPort,
  TaskRepoWritePort,
} from '../services/task/ports.js';
import { TaskSourceConflictError } from '../services/task/ports.js';
import { userVisibleTaskPredicate } from './task-board-population.js';
import { SELECT_TASK_JOINED } from './task-sql.js';
import { prepareObserved } from '../observability/observed-statement.js';

/** Fresh opaque task identity (same scheme as message ids). */
function newTaskId(): string {
  return randomBytes(12).toString('base64url');
}

/** The shared column set the mutation paths read as a `ResolvedTaskRow`. */
const SELECT_RESOLVED_TASK = `
  SELECT
    t.id, t.conversation_id AS conversation_id, t.task_number, t.workspace_id,
    t.board_key,
    t.status, t.closed_at, t.assignee_agent_id, t.assignee_user_id,
    t.title, t.content, t.thread_root_id, t.source_message_id,
    t.created_event_message_id, t.creator_kind, t.creator_agent_id,
    c.title AS owner_conversation_title
  FROM tasks t
  JOIN conversations c ON c.id = t.conversation_id
`;

export interface SqliteTaskRepoDeps {
  db: Db;
  conversations: TaskConversationAccessPort;
}

export class SqliteTaskRepo implements TaskRepoReadPort, TaskRepoWritePort {
  private readonly db: Db;
  private readonly conversations: TaskConversationAccessPort;

  constructor(deps: SqliteTaskRepoDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
  }

  list(filters: ListTasksFilters): TaskSummaryDto[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];

    if (filters.actor.kind === 'agent') {
      // The agent arm reads BOARDS (P0-f): the service computes the board-key
      // set — one validated key (explicit selector or frame-derived) or the
      // agent-slot union. An empty set reads as zero rows — never a fallback
      // to some ambient board.
      if (filters.boardKeys === undefined) {
        throw new Error('task list (agent arm): boardKeys must be resolved by the service');
      }
      if (filters.boardKeys.length === 0) return [];
      const placeholders = filters.boardKeys.map(() => '?').join(',');
      clauses.push(`t.board_key IN (${placeholders})`);
      args.push(...filters.boardKeys);
      // Per-task ACL (agent-scoped-session-v1 §4.4, #task:2018): the board
      // clause above is a COORDINATE, not an ACL — a WorkspaceBoard aggregates
      // conversations with different member sets, so the row set must also be
      // narrowed to conversations this agent PARTICIPATES in. Same authority
      // as the point reads (`agentParticipates` is the SQL twin of
      // `isAgentParticipant`); public discovery grants no task read, mirroring
      // USER_VISIBLE_TASK_PREDICATE on the human arm below.
      const participation = agentParticipates('conv', filters.actor.agentId);
      clauses.push(participation.sql);
      args.push(...participation.params);
    } else {
      // The human visibility gate is the SHARED builder (also interpolated by
      // every board read face) — "which tasks may this viewer see" has one
      // definition, so the CLI/list face and the paginated board can never
      // disagree about it. It carries its own bind args (placement
      // participation is four viewer-id binds), so the count is never
      // hand-tracked here.
      const visible = userVisibleTaskPredicate(filters.actor.userId);
      clauses.push(visible.sql);
      args.push(...visible.args);
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
    // Ordering is PER ARM (#task:2018 B4). Single-board reads keep
    // `task_number DESC` — within one board the number IS creation order, and
    // that is the human board's pinned keyset shape. The cross-board UNION
    // cannot use it ("newest" is a per-board notion: board A's stale #100
    // would forever shadow board B's fresh #1 under a LIMIT), so it orders by
    // the globally comparable creation instant. `id DESC` is a deterministic
    // tiebreak in both arms, never a time axis.
    const orderBy =
      filters.actor.kind === 'agent' &&
      filters.boardKeys !== undefined &&
      filters.boardKeys.length > 1
        ? 'ORDER BY t.created_at DESC, t.id DESC'
        : 'ORDER BY t.task_number DESC, t.id DESC';
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `${SELECT_TASK_JOINED} ${where} ${orderBy}`;
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
    authorizedBoardKey?: string,
  ): TaskSummaryDto | null {
    const queryArgs = [...args];
    let gatedWhere = where;
    if (actor.kind === 'agent') {
      // BOARD COORDINATE check (P0-f) is a SQL predicate, not a projected
      // display field. Keeping it here lets the shared DTO row stay minimal:
      // board_key never crosses into TaskJoinedRow just to be compared once.
      const gateKey =
        authorizedBoardKey
        ?? (actor.conversationId === null
          ? undefined
          : this.boardOfConversation(actor.conversationId)?.boardKey);
      if (gateKey === undefined) return null;
      gatedWhere += ' AND t.board_key = ?';
      queryArgs.push(gateKey);
    }
    const row = prepareObserved<typeof queryArgs, TaskJoinedRow>(
        this.db,
        queryName,
        `${SELECT_TASK_JOINED} ${gatedWhere}`,
      )
      .get(...queryArgs);
    if (!row) return null;
    if (actor.kind === 'agent') {
      // Per-task ACL (agent-scoped-session-v1 §4.4, #task:2018): the workspace
      // board predicate above is a COORDINATE check, not an ACL — the agent
      // must also participate in the task's own conversation (placement-aware;
      // public discovery grants no task read, mirroring the human arm below).
      if (!this.conversations.isAgentParticipant(row.conversation_id, actor.agentId)) {
        return null;
      }
    } else if (!this.conversations.userCanAccessConversation(actor.userId, row.conversation_id)) {
      return null;
    }
    return taskJoinedToSummary(row);
  }

  /**
   * Read a task summary by its identity (`tasks.id`).
   *
   * `authorizedBoardKey` is the board the caller has already resolved and
   * authorized the actor against. When present, the coordinate gate is exact
   * `tasks.board_key` equality (workspace or pair); per-task participation is
   * still checked independently below, so Board never becomes ACL. The user
   * gate (conversation access) is unchanged.
   */
  getById(
    taskId: string,
    actor: TaskActor,
    authorizedBoardKey?: string,
  ): TaskSummaryDto | null {
    return this.readGatedSummary(
      'tasks.get_joined_by_id',
      'WHERE t.id = ?',
      [taskId],
      actor,
      authorizedBoardKey,
    );
  }

  /**
   * Read a task summary by the board-scoped business key `(board_key,
   * task_number)` — the key an inline `#task:<n>` sigil carries, after the
   * service has derived `board_key` from a conversation on the board. A SINGLE
   * bounded read on `uniq_tasks_board_number`: same projection and same gate as
   * `getById`, so a pill never pays for the mutation-path column set (which
   * reads `t.content`) nor for a second query to reach the summary it renders.
   *
   * User actor only — the sigil face is human-facing, so the gate is always the
   * viewer's access to the task's OWN conversation and `boardKey` is a lookup
   * key, never an authorization claim.
   */
  getByNumber(
    boardKey: string,
    taskNumber: number,
    actor: UserActor,
  ): TaskSummaryDto | null {
    return this.readGatedSummary(
      'tasks.get_joined_by_number',
      'WHERE t.board_key = ? AND t.task_number = ?',
      [boardKey, taskNumber],
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
    authorizedBoardKey?: string,
  ): TaskDetailDto | null {
    const summary = this.getById(taskId, actor, authorizedBoardKey);
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
   *  message is gone or the viewer cannot read its conversation.
   *  `conversation_id` is the message's own conversation — channel or pair,
   *  whichever holds it (threads are reply clusters, not standalone
   *  conversations). */
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
      conversation_id: msg.conversation_id,
      thread_root_id: msg.thread_root_id,
      message_id: messageId,
    };
  }

  /** Whether the acting viewer can currently read a conversation (agent =
   *  member of that conversation; user = member row). */
  private viewerCanAccessConversation(actor: TaskActor, conversationId: string): boolean {
    if (actor.kind === 'agent') {
      // Placement-aware participation (review B3): a roster-row lookup
      // has no row for a DirectPair endpoint, which would degrade every
      // source/created-event nav on a pair task to 'unavailable'.
      return this.conversations.isAgentParticipant(conversationId, actor.agentId);
    }
    return this.conversations.userCanAccessConversation(actor.userId, conversationId);
  }

  /** Next per-board monotonic task number (1-based). PRIVATE allocator —
   *  never exposed on the port surface: `createTaskRow` is the single atomic
   *  create capability, so application code cannot split allocate/insert into
   *  a TOCTOU (#task:1980). The `uniq_tasks_board_number` unique index is
   *  the backstop; SQLite's single-writer transaction makes the MAX+1 read +
   *  INSERT atomic in this adapter. */
  private allocateTaskNumber(boardKey: string): number {
    const row = prepareObserved<[string], { next: number }>(
        this.db,
        'tasks.allocate_task_number',
        `SELECT COALESCE(MAX(task_number), 0) + 1 AS next
         FROM tasks WHERE board_key = ?`,
      )
      .get(boardKey);
    return row?.next ?? 1;
  }

  /** Every DirectPair board this agent is an endpoint of (P0-f §7.2.2):
   *  participation IS the read authority on a pair board, so endpoint-ness is
   *  the whole membership question. */
  listAgentDirectPairBoardKeys(agentId: string): string[] {
    return prepareObserved<[string, string], { board_key: string }>(
        this.db,
        'tasks.list_agent_pair_board_keys',
        `SELECT 'pair:' || pair_key AS board_key
           FROM conversations
          WHERE placement_kind = 'direct_pair'
            AND ((endpoint_a_kind = 'agent' AND endpoint_a_id = ?)
              OR (endpoint_b_kind = 'agent' AND endpoint_b_id = ?))`,
      )
      .all(agentId, agentId)
      .map(r => r.board_key);
  }

  /**
   * The board a conversation's placement yields, or null when it has none
   * (unknown placement, missing row). READ-side twin of the v76
   * derivation trigger's CASE — the trigger is the authority; a drift between
   * the two is caught by it on every INSERT (and by the agreement falsifier
   * in the migration suite).
   */
  boardOfConversation(
    conversationId: string,
  ): { boardKey: string; workspaceId: string | null } | null {
    const row = prepareObserved<[string], { board_key: string | null; workspace_id: string | null }>(
        this.db,
        'tasks.board_of_conversation',
        `SELECT CASE placement_kind
                  WHEN 'workspace'   THEN 'ws:'   || workspace_id
                  WHEN 'direct_pair' THEN 'pair:' || pair_key
                END AS board_key,
                workspace_id
           FROM conversations WHERE id = ?`,
      )
      .get(conversationId);
    if (!row || row.board_key === null) return null;
    return { boardKey: row.board_key, workspaceId: row.workspace_id };
  }

  /**
   * The single task-aggregate creator: allocate the next board-scoped task
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
    // The BOARD is derived from the destination conversation's placement
    // (P0-f §4.4) — never a caller coordinate. This read and the v76 INSERT
    // trigger state the same rule; the trigger is the authority and would
    // abort any drift here. A placement with no board (an unknown one) derives
    // null and fails loud before any number is allocated.
    const board = this.boardOfConversation(args.conversationId);
    if (!board) {
      throw new Error(
        `tasks.createTaskRow: conversation ${args.conversationId} has no task board`,
      );
    }
    const id = newTaskId();
    const taskNumber = this.allocateTaskNumber(board.boardKey);
    const status: TaskStatus = args.claimByAgentId ? 'in_progress' : 'todo';
    try {
      prepareObserved(
          this.db,
          'tasks.insert_row',
          `INSERT INTO tasks (
             id, workspace_id, board_key, task_number, conversation_id, thread_root_id,
             title, content, status, assignee_agent_id, assignee_user_id,
             creator_kind, creator_agent_id, creator_user_id,
             source_message_id, created_event_message_id,
             last_editor_kind, last_editor_id, last_edited_at,
             created_at, closed_at
           ) VALUES (
             @id, @workspace_id, @board_key, @task_number, @conversation_id, @thread_root_id,
             @title, @content, @status, @assignee_agent_id, NULL,
             @creator_kind, @creator_agent_id, @creator_user_id,
             @source_message_id, NULL,
             NULL, NULL, NULL,
             @created_at, NULL
           )`,
        )
        .run({
          id,
          workspace_id: board.workspaceId,
          board_key: board.boardKey,
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
    } catch (e) {
      // Translate the driver-specific UNIQUE(source_message_id) collision into
      // a DRIVER-FREE sentinel. This is the ONLY place that reads SQLite error
      // codes/constraint text for this domain; application code consumes
      // `TaskSourceConflictError` and never parses driver dialects (#task:1980
      // P1-1).
      if (this.isSourceUniqueCollision(e)) {
        throw new TaskSourceConflictError(args.sourceMessageId ?? '');
      }
      throw e;
    }
    return { id, taskNumber };
  }

  /** Adapter-internal driver-dialect check: the permanent 1:1 provenance key
   *  (UNIQUE source_message_id) collided. Any other constraint/error passes
   *  through unchanged. */
  private isSourceUniqueCollision(e: unknown): boolean {
    const code = (e as { code?: string })?.code;
    const message = e instanceof Error ? e.message : '';
    return code === 'SQLITE_CONSTRAINT_UNIQUE' && message.includes('source_message_id');
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

  fetchTaskByNumber(boardKey: string, taskNumber: number): ResolvedTaskRow | null {
    const row = prepareObserved<[string, number], ResolvedTaskRow>(
        this.db,
        'tasks.fetch_by_number',
        `${SELECT_RESOLVED_TASK} WHERE t.board_key = ? AND t.task_number = ?`,
      )
      .get(boardKey, taskNumber);
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
