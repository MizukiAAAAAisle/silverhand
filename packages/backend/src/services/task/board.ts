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
  TaskBoardContainer,
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
  /** The board's TOP-LEVEL container axis (#task:2041) —
   *  `workspace | agent_space | direct_messages`. A task's owning conversation
   *  sits in exactly ONE human container; this selects the bare state (ALL of
   *  that container at once), which is why it cannot be expressed by
   *  `workspaceId` (that names ONE workspace) or `channelId` (ONE conversation).
   *  Workspace vs Agent Space is an ownership split (`owner_agent_id`) of the SAME
   *  `placement_kind='workspace'`; Direct Messages is `placement_kind='direct_pair'`.
   *  Absent = no container narrowing (the `All` board spans every
   *  container the viewer can see). Stacks with `workspaceId` / `channelId` as
   *  an intersection, never a contradiction the caller must pre-resolve. */
  container?: TaskBoardContainer | undefined;
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
  if (!Number.isSafeInteger(cursor.taskNumber) || cursor.taskNumber <= 0) {
    throw new RangeError('task board cursor number must be a positive JS-safe integer');
  }
  if (cursor.taskId.length === 0) {
    throw new RangeError('task board cursor id must be non-empty');
  }
  return Buffer.from(
    JSON.stringify([cursor.taskNumber, cursor.taskId]),
    'utf8',
  ).toString('base64url');
}

/** Returns null for anything that is not a well-formed cursor — the route turns
 *  that into a 400 rather than silently serving page 1 (a silent reset would
 *  loop a scrolling client forever on the first window). */
export function decodeTaskBoardCursor(raw: string): TaskBoardCursor | null {
  // Node's decoder is intentionally permissive (padding and non-canonical
  // spellings); the protocol is not. Accept exactly one unpadded base64url
  // representation and verify it by round-tripping through the encoder.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) return null;
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [taskNumber, taskId] = parsed as [unknown, unknown];
  if (
    typeof taskNumber !== 'number' ||
    !Number.isSafeInteger(taskNumber) ||
    taskNumber <= 0
  ) return null;
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
