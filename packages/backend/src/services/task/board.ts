// Human task-board READ FACES (#task:1884, parent #task:1883).
//
// The board used to be one unpaginated fetch-all (`GET /api/tasks` with no
// filters) that every surface sliced client-side. That made the authority read,
// transfer and project the entire visible task population to render a 20-row
// column. These faces replace it with three bounded reads:
//
//   column(...) — one status column's keyset WINDOW  (items + next_cursor)
//   counts(...) — the authoritative per-status TOTALS (one GROUP BY)
//   facets(...) — the filter menus' person option sets
//
// Three facts, three carriers: a window returns no total, counts return no
// items. So a paginated board can never hold two disagreeing copies of one
// number, and no consumer can mistake "the pages I loaded" for the population.
//
// All three interpolate ONE population predicate
// (`repos/task-board-population.ts`), viewer visibility included, so filtering
// and visibility always happen BEFORE the LIMIT: no page can hide eligible rows
// behind it (the client keys on `next_cursor` alone, never on page length), and
// a total never counts a task the viewer cannot see.
//
// Order is `task_number DESC, id DESC` and is part of the WIRE contract
// (`TaskBoardColumnDtoSchema`): consumers concatenate pages in request order and
// do not re-sort. `task_number` alone already ordered the old board, but it is
// only monotonic PER WORKSPACE (`uniq_tasks_workspace_number`), so on the
// default cross-workspace board two tasks can share a number. `id DESC` is the
// unique tiebreak that makes the order total — it fixes what was previously
// unspecified between equal numbers and changes nothing a user could observe as
// a reordering.
import type { Database as Db } from 'better-sqlite3';
import {
  TaskStatusSchema,
  type TaskBoardColumnDto,
  type TaskBoardCountsDto,
  type TaskBoardFacetsDto,
  type TaskBoardPersonOption,
  type TaskStatus,
} from '@silverhand/shared';
import { prepareObserved } from '../../observability/observed-statement.js';
import {
  taskBoardPopulation,
  type SqlFragment,
  type TaskBoardPopulationFilters,
} from '../../repos/task-board-population.js';
import {
  SELECT_TASK_JOINED,
  taskJoinedToSummary,
  type TaskJoinedRow,
} from './store.js';

/** The keyset position of the last row of a delivered window. */
interface TaskBoardCursor {
  taskNumber: number;
  taskId: string;
}

/**
 * The ENCODING is opaque — base64url JSON of the positional pair — so its shape
 * is free to change. That is all opacity buys: the delivered ORDER is a wire
 * contract (see `TaskBoardColumnDtoSchema`), so changing the sort key stays a
 * visible break, and a cursor is a position in the CURRENT server order — a
 * client must not persist one across a deployment that changed that order.
 *
 * Not signed, because it carries no authority: the viewer gate is re-applied
 * server-side on every page, so a forged cursor can only reposition a caller
 * inside their OWN population.
 */
export function encodeTaskBoardCursor(cursor: TaskBoardCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.taskNumber, cursor.taskId]),
    'utf8',
  ).toString('base64url');
}

/** Returns null for anything that is not a well-formed cursor — the route turns
 *  that into a 400 rather than silently serving page 1 (a silent reset would
 *  loop a scrolling client forever on the first window). */
export function decodeTaskBoardCursor(raw: string): TaskBoardCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [taskNumber, taskId] = parsed as [unknown, unknown];
  if (typeof taskNumber !== 'number' || !Number.isInteger(taskNumber)) return null;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  return { taskNumber, taskId };
}

export interface TaskBoardColumnRequest extends TaskBoardPopulationFilters {
  status: TaskStatus;
  /** Already-decoded cursor; omitted = first window. */
  cursor?: TaskBoardCursor | undefined;
  /** Window size; the route applies the default/bound. */
  limit: number;
}

interface CountRow {
  status: TaskStatus;
  n: number;
}

interface PersonRow {
  type: 'agent' | 'user';
  id: string;
  name: string;
}

/**
 * The column window's SQL, assembled in ONE place so the query-plan test can
 * EXPLAIN exactly what `column()` executes (an index-access-path assertion over
 * a hand-rewritten copy of the query would prove nothing).
 *
 * Every axis — the viewer gate included — is a WHERE clause of this statement,
 * so all of them are applied BEFORE `LIMIT`. The `limit + 1` probe is therefore
 * taken over the complete filtered population: the extra row is what makes
 * `next_cursor === null` exact, and no row is ever dropped after the window is
 * cut (which would silently shorten a page that still had rows behind it).
 */
export function taskBoardColumnQuery(req: TaskBoardColumnRequest): SqlFragment {
  const population = taskBoardPopulation(req);
  const clauses = [population.sql, 't.status = ?'];
  const args: (string | number)[] = [...population.args, req.status];

  if (req.cursor) {
    // Strictly AFTER the cursor position in (task_number DESC, id DESC).
    //
    // Written as a redundant bound PLUS the exact tiebreak, not as the single
    // `(number < ? OR (number = ? AND id < ?))` disjunction: SQLite cannot turn
    // a top-level OR into a range constraint on the ordered index, so that form
    // walks the column from its head on every page (O(cursor position) index
    // steps). `task_number <= ?` is implied by the disjunction, so adding it
    // changes no row — it only gives the planner the seek it needs.
    clauses.push('t.task_number <= ?');
    clauses.push('(t.task_number < ? OR t.id < ?)');
    args.push(req.cursor.taskNumber, req.cursor.taskNumber, req.cursor.taskId);
  }

  args.push(req.limit + 1);

  return {
    sql: `${SELECT_TASK_JOINED}
        WHERE ${clauses.join('\n    AND ')}
        ORDER BY t.task_number DESC, t.id DESC
        LIMIT ?`,
    args,
  };
}

export class TaskBoardReader {
  private readonly db: Db;

  constructor(deps: { db: Db }) {
    this.db = deps.db;
  }

  /** One status column's window, newest-first. */
  column(req: TaskBoardColumnRequest): TaskBoardColumnDto {
    const query = taskBoardColumnQuery(req);
    const rows = prepareObserved<typeof query.args, TaskJoinedRow>(
      this.db,
      'tasks.board_column',
      query.sql,
    ).all(...query.args);

    const hasMore = rows.length > req.limit;
    const page = hasMore ? rows.slice(0, req.limit) : rows;
    const last = page[page.length - 1];
    return {
      status: req.status,
      items: page.map(r => taskJoinedToSummary(r)),
      next_cursor:
        hasMore && last
          ? encodeTaskBoardCursor({ taskNumber: last.task_number, taskId: last.id })
          : null,
    };
  }

  /**
   * Every status's total under the same filters — ONE `GROUP BY status` over the
   * same population, never five separate counting queries kept equal by test.
   * Statuses with no rows are filled with 0, so the DTO is always total and no
   * client has to read "absent" as "zero".
   */
  counts(filters: TaskBoardPopulationFilters): TaskBoardCountsDto {
    const population = taskBoardPopulation(filters);
    const rows = prepareObserved<typeof population.args, CountRow>(
      this.db,
      'tasks.board_counts',
      `SELECT t.status AS status, COUNT(*) AS n
         FROM tasks t
        WHERE ${population.sql}
        GROUP BY t.status`,
    ).all(...population.args);

    const counts = Object.fromEntries(
      TaskStatusSchema.options.map(s => [s, 0]),
    ) as Record<TaskStatus, number>;
    for (const row of rows) counts[row.status] = row.n;
    return { counts };
  }

  /**
   * The filter menus' option sets over the viewer's ENTIRE visible population —
   * intentionally NOT narrowed by the board filters (an option set that shrinks
   * when you select from it cannot be switched away from, and the shipped
   * behavior aggregates from the unfiltered cross-workspace directory).
   *
   * Names degrade to the id exactly as `taskJoinedToSummary` does, so a deleted
   * creator appears in the menu identically to how it appears on a card (the
   * creator id columns carry no FK by design — immutable provenance).
   */
  facets(viewerUserId: string): TaskBoardFacetsDto {
    const visible = taskBoardPopulation({ viewerUserId });
    const assignees = prepareObserved<[string, string], PersonRow>(
      this.db,
      'tasks.board_facet_assignees',
      `SELECT DISTINCT 'agent' AS type,
              t.assignee_agent_id AS id,
              COALESCE(aa.display_name, t.assignee_agent_id) AS name
         FROM tasks t
         LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
        WHERE ${visible.sql}
          AND t.assignee_agent_id IS NOT NULL
        UNION
       SELECT DISTINCT 'user' AS type,
              t.assignee_user_id AS id,
              COALESCE(au.display_name, t.assignee_user_id) AS name
         FROM tasks t
         LEFT JOIN users au ON au.id = t.assignee_user_id
        WHERE ${visible.sql}
          AND t.assignee_user_id IS NOT NULL`,
    ).all(viewerUserId, viewerUserId);

    // `system` creators are excluded: they have no id and are not a selectable
    // person (a task always HAS a creator, but 'system' is a property of the
    // data, not a menu entry).
    const creators = prepareObserved<[string, string], PersonRow>(
      this.db,
      'tasks.board_facet_creators',
      `SELECT DISTINCT 'agent' AS type,
              t.creator_agent_id AS id,
              COALESCE(ca.display_name, t.creator_agent_id) AS name
         FROM tasks t
         LEFT JOIN agents ca ON ca.id = t.creator_agent_id
        WHERE ${visible.sql}
          AND t.creator_kind = 'agent'
          AND t.creator_agent_id IS NOT NULL
        UNION
       SELECT DISTINCT 'user' AS type,
              t.creator_user_id AS id,
              COALESCE(cu2.display_name, t.creator_user_id) AS name
         FROM tasks t
         LEFT JOIN users cu2 ON cu2.id = t.creator_user_id
        WHERE ${visible.sql}
          AND t.creator_kind = 'user'
          AND t.creator_user_id IS NOT NULL`,
    ).all(viewerUserId, viewerUserId);

    const unassigned = prepareObserved<[string], { present: number }>(
      this.db,
      'tasks.board_facet_unassigned',
      `SELECT EXISTS (
                SELECT 1
                  FROM tasks t
                 WHERE ${visible.sql}
                   AND t.assignee_agent_id IS NULL
                   AND t.assignee_user_id IS NULL
              ) AS present`,
    ).get(viewerUserId);

    return {
      assignees: sortByName(assignees),
      creators: sortByName(creators),
      has_unassigned: (unassigned?.present ?? 0) === 1,
    };
  }
}

/** Menu order — by display name, matching what the surfaces render today. */
function sortByName(rows: PersonRow[]): TaskBoardPersonOption[] {
  return [...rows]
    .map(r => ({ type: r.type, id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
