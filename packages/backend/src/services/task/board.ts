// Human task-board PURE wire contract (#task:1884, #task:1980). The keyset
// cursor encoding/decoding, the column request shape, and the population
// filter contract are driver-free application code; the SQL window/population
// assembly lives in the persistence read-model
// (`repos/task-board-read-model.ts` / `repos/task-board-population.ts`).
//
// The ENCODING is opaque — base64url JSON of the positional pair — so its shape
// is free to change. That is all opacity buys: the delivered ORDER is a wire
// contract (see `TaskBoardColumnDtoSchema`), so changing the sort key stays a
// visible break, and a cursor is a position in the CURRENT server order — a
// client must not persist one across a deployment that changed that order.
//
// Not signed, because it carries no authority: the viewer gate is re-applied
// server-side on every page, so a forged cursor can only reposition a caller
// inside their OWN population.
import type {
  TaskBoardAssigneeFilterType,
  TaskBoardCreatorFilterType,
  TaskStatus,
} from '@silverhand/shared';

/** The board's filter axes, already validated/normalized by the route. Lives
 *  HERE (application contract), NOT in the persistence module, so the
 *  application ports never depend on the repository direction (#task:1980
 *  P2-1). The persistence adapter imports this contract and builds SQL from
 *  it. */
export interface TaskBoardPopulationFilters {
  /** The human viewer — always present; the board has no unscoped read. */
  viewerUserId: string;
  /** Optional narrowing. Absent = the default All-workspaces board. */
  workspaceId?: string | undefined;
  /** A channel conversation id: matches that channel AND its threads, because
   *  a task's conversation IS its channel (the reply cluster is
   *  `thread_root_id`, a separate column). */
  channelId?: string | undefined;
  /** `unassigned` names BOTH assignee columns being NULL — the aggregate
   *  splits one concept across `assignee_agent_id` / `assignee_user_id`, so a
   *  predicate that mentions only one of them is half a rule. */
  assignee?:
    | { type: Extract<TaskBoardAssigneeFilterType, 'agent' | 'user'>; id: string }
    | { type: 'unassigned' }
    | undefined;
  /** `creator_kind` pairs exactly with its id column (table CHECK), so both are
   *  asserted — a creator id alone would also match a row whose kind differs. */
  creator?: { type: TaskBoardCreatorFilterType; id: string } | undefined;
}

/** The keyset position of the last row of a delivered window. */
export interface TaskBoardCursor {
  taskNumber: number;
  taskId: string;
}

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
