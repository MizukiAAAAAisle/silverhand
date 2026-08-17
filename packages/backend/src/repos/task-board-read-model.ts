// Human task-board READ-MODEL adapter (#task:1884, parent #task:1883;
// #task:1980 — moved from `services/task/board.ts` into the repository zone so
// task application code holds no raw DB capability).
//
// Three bounded reads replace the board's fetch-all:
//
//   column(...) — one status column's keyset WINDOW  (items + next_cursor)
//   counts(...) — the authoritative per-status TOTALS (one GROUP BY)
//   facets(...) — the filter menus' person option sets
//
// All three interpolate ONE population predicate
// (`repos/task-board-population.ts`), viewer visibility included, so filtering
// and visibility always happen BEFORE the LIMIT. Order is
// `task_number DESC, id DESC` and is part of the WIRE contract
// (`TaskBoardColumnDtoSchema`): consumers concatenate pages in request order
// and do not re-sort. `id DESC` is the unique tiebreak that makes the order
// total between equal per-workspace numbers.
import type { Database as Db } from 'better-sqlite3';
import {
  TaskStatusSchema,
  type TaskBoardColumnDto,
  type TaskBoardContainer,
  type TaskBoardCountsDto,
  type TaskBoardFacetsDto,
  type TaskBoardPersonOption,
  type TaskStatus,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import {
  taskBoardPopulation,
  type SqlFragment,
} from './task-board-population.js';
import type { TaskBoardPopulationFilters } from '../services/task/board.js';
import { SELECT_TASK_JOINED } from './task-sql.js';
import { taskJoinedToSummary, type TaskJoinedRow } from '../services/task/dto.js';
import type { TaskBoardReadModelPort } from '../services/task/ports.js';
import type { TaskBoardColumnRequest } from '../services/task/board.js';
import { encodeTaskBoardCursor } from '../services/task/board.js';

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

export class SqliteTaskBoardReadModel implements TaskBoardReadModelPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
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
   * The filter menus' option sets over the viewer's visible population WITHIN
   * the selected container. `container` is the board SELECTOR (which of
   * `Workspace | Agent Space | Direct Messages` — omitted = the `All` board), so
   * the menus describe the board you are on; a DM board's creator menu lists DM
   * creators, not workspace-channel people who select nothing there. It is the
   * ONLY axis honored here: the WITHIN-board filters (`workspaceId` /
   * `channelId` / assignee / creator) are intentionally NOT applied — an option
   * set that shrinks when you select from it cannot be switched away from, and
   * the shipped behavior aggregates from the unfiltered cross-workspace
   * directory within the board.
   */
  facets(
    viewerUserId: string,
    container?: TaskBoardContainer | undefined,
  ): TaskBoardFacetsDto {
    const visible = taskBoardPopulation({
      viewerUserId,
      ...(container !== undefined ? { container } : {}),
    });
    const assignees = prepareObserved<typeof visible.args, PersonRow>(
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
    ).all(...visible.args, ...visible.args);

    // `system` creators are excluded: they have no id and are not a selectable
    // person (a task always HAS a creator, but 'system' is a property of the
    // data, not a menu entry).
    const creators = prepareObserved<typeof visible.args, PersonRow>(
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
    ).all(...visible.args, ...visible.args);

    const unassigned = prepareObserved<typeof visible.args, { present: number }>(
      this.db,
      'tasks.board_facet_unassigned',
      `SELECT EXISTS (
                SELECT 1
                  FROM tasks t
                 WHERE ${visible.sql}
                   AND t.assignee_agent_id IS NULL
                   AND t.assignee_user_id IS NULL
              ) AS present`,
    ).get(...visible.args);

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
