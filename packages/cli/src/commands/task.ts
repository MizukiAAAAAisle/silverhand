/**
 * `silverhand task` — list, create, claim, unclaim, status.
 */
import type { TaskStatus } from '@silverhand/shared';
import { CliError } from '../errors.js';
import {
  flagBool,
  flagNumber,
  flagNumberArray,
  flagString,
  flagStringArray,
} from '../parse.js';
import type { Command } from './index.js';

const VALID_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
const VALID_UPDATE_STATUSES: readonly TaskStatus[] = ['in_progress', 'in_review', 'done'];

/**
 * List-only filter macros for `task list --status`. Each macro expands
 * to one or more canonical `TaskStatus` values that the agent passes to
 * the backend filter. Macros are NOT new task states: a task in the DB
 * is always one of `todo|in_progress|in_review|done`. They exist purely
 * to match common natural-language asks ("show me active work", "show
 * everything") with the ergonomic words agents reach for first.
 *
 * `all` is special: its semantic is **"do not filter"**, NOT "include
 * every currently-known status". Treating it as the latter would (a)
 * still emit a `status` query key into `cli-*.log`, and (b) silently
 * exclude any new canonical status added in the future. So `all`
 * short-circuits to `null` and overrides every other token in the same
 * `--status` invocation.
 *
 * `task status --status` (the mutation) MUST NOT accept these — see
 * `LIST_ONLY_STATUS_MACROS` enforcement below.
 */
const STATUS_FILTER_MACROS: Readonly<Record<string, readonly TaskStatus[]>> = {
  active: ['todo', 'in_progress', 'in_review'],
  open: ['todo', 'in_progress', 'in_review'],
  pending: ['todo'],
};
const NO_FILTER_MACRO = 'all';
/** Every token `task status --status` must reject as a list-only macro
 *  (the `STATUS_FILTER_MACROS` keys plus the no-filter sentinel). */
const LIST_ONLY_STATUS_MACROS = new Set([
  ...Object.keys(STATUS_FILTER_MACROS),
  NO_FILTER_MACRO,
]);

/** Expand `--status` values into a list of canonical statuses to filter
 *  by, OR `null` if the agent asked for `all` (no filter). Throws
 *  `enum_invalid` on any unknown token. Used only by `task list`;
 *  `task status` uses the stricter `assertSingleUpdateStatus` path.
 *
 *  Why comma split: agents reach for `--status active,in_review` because
 *  every other CLI in their training data does it. Without explicit
 *  support each token would be passed verbatim (`'active,in_review'`)
 *  and fail validation as a single unknown enum.
 *
 *  Why `all` overrides: mixing the no-filter sentinel with narrower
 *  filters (`--status all,done`) is contradictory; the broadest token
 *  wins. Lets the agent express "I just want everything" without
 *  worrying about other tokens already in the call. */
function expandFilterStatuses(raw: readonly string[]): TaskStatus[] | null {
  const out = new Set<TaskStatus>();
  for (const value of raw) {
    for (const part of value.split(',').map(s => s.trim()).filter(s => s.length > 0)) {
      if (part === NO_FILTER_MACRO) return null;
      const macro = STATUS_FILTER_MACROS[part];
      if (macro) {
        for (const m of macro) out.add(m);
        continue;
      }
      if (!VALID_STATUSES.includes(part as TaskStatus)) {
        throw new CliError({
          code: 'validation_error',
          subkind: 'enum_invalid',
          message:
            `--status must be one of ${VALID_STATUSES.join('|')} ` +
            `or a list-only filter macro (${[...LIST_ONLY_STATUS_MACROS].join('|')}); got "${part}"`,
          retriable: false,
          details: {
            flag: 'status',
            value: part,
            allowed: [...VALID_STATUSES, ...LIST_ONLY_STATUS_MACROS],
          },
        });
      }
      out.add(part as TaskStatus);
    }
  }
  return [...out];
}

const listCommand: Command = {
  verb: 'list',
  summary: 'View the workspace task board.',
  help: `silverhand task list [--task-number N [--task-number N ...]]
                       [--status STATUS [--status STATUS ...]]
                       [--assignee <agent_id>] [--mine]
                       [--workspace-id <id>] [--conversation-id <id>]
                       [--limit N]

Returns aggregated tasks across the current workspace, with server-side
filtering. You can only mutate tasks that belong to your current
channel/thread; others are returned read-only.

Without filters this returns the entire board, which can be large — pass
--task-number / --status / --mine / --limit to narrow.

Flags:
  --task-number N      Repeatable. Filter to specific task numbers.
                       Last-wins is NOT used; values OR together.
  --status STATUS      Repeatable. Filter by status. Canonical values:
                       todo | in_progress | in_review | done.
                       List-only filter macros (NOT writable states):
                         active|open  → todo + in_progress + in_review
                         pending      → todo
                         all          → no filter (status field omitted
                                        from the request; overrides any
                                        narrower token in the same call)
                       Comma-joined values are accepted, e.g.
                       "--status active,done". Multiple values OR
                       together. Macros are list-only — passing them to
                       \`silverhand task status --status\` fails with
                       enum_invalid.
  --assignee <id>      Filter by assignee agent id.
  --mine               Shortcut for --assignee=<your agent id>.
                       Resolves locally to this agent.
  --workspace-id <id>  Optional filter to a specific workspace.
  --conversation-id <id>  Optional filter to a specific conversation.
  --limit N            Cap rows returned (max 500). Useful with status
                       filters to peek the board.

stdout: { "tasks": [TaskSummaryDto, ...] }`,
  flags: [
    'task-number',
    'status',
    'assignee',
    'workspace-id',
    'conversation-id',
    'limit',
  ] as const,
  booleanFlags: ['mine'] as const,
  async run({ client, env, args }) {
    const taskNumbers = flagNumberArray(args, 'task-number');
    const statusValues = flagStringArray(args, 'status');
    const expandedStatuses = statusValues
      ? expandFilterStatuses(statusValues)
      : undefined;
    const explicitAssignee = flagString(args, 'assignee');
    const mine = flagBool(args, 'mine');
    if (mine && explicitAssignee) {
      throw new CliError({
        code: 'validation_error',
        message: '--mine and --assignee are mutually exclusive',
        retriable: false,
      });
    }
    const assigneeId = mine ? env.agentId : explicitAssignee;
    const limit = flagNumber(args, 'limit');
    if (limit !== undefined && (limit < 1 || limit > 500)) {
      throw new CliError({
        code: 'validation_error',
        message: '--limit must be between 1 and 500',
        retriable: false,
      });
    }
    return client.listTasks({
      ...(taskNumbers ? { task_number: taskNumbers } : {}),
      ...(expandedStatuses && expandedStatuses.length > 0
        ? { status: expandedStatuses }
        : {}),
      ...(assigneeId ? { assignee_id: assigneeId } : {}),
      ...(flagString(args, 'workspace-id')
        ? { workspace_id: flagString(args, 'workspace-id') }
        : {}),
      ...(flagString(args, 'conversation-id')
        ? { conversation_id: flagString(args, 'conversation-id') }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  },
};

const createCommand: Command = {
  verb: 'create',
  summary: 'Create one or more tasks (no auto-claim).',
  help: `silverhand task create --title <title> [--body <body>]
                         [--title <title> [--body <body>]] ...

Create tasks in the current channel/thread. Repeat --title (and optional
following --body) to create multiple in one call. Each --body is paired
with the most recent --title; if omitted, the title is reused as body.

If you intend to work on these immediately, follow up with
\`silverhand task claim --task-number <n>\`.

Pre-flight failures (exit 1):
  --message was supplied → flag_removed (use --title / --body)

stdout: CreateTasksResult JSON.`,
  flags: ['title', 'body'] as const,
  // Agents reach for --message because half of the CLIs in their
  // training data treat it as the canonical "body" flag (gh, git,
  // hub, ...). 5/14 daily report logged one such hit. Routing it
  // through `flag_removed` turns the failure into an actionable
  // migration line that names the right shape, instead of a bare
  // unknown-flag typo with no useful suggestion (Levenshtein from
  // `message` to `title` / `body` is too large for a hint).
  removedFlags: {
    message: {
      replacement: 'title+body',
      hint:
        'silverhand task create takes --title (required) and --body (optional). ' +
        'For one task use `silverhand task create --title "..." --body "..."`. ' +
        'Repeat --title to create multiple in a single call.',
    },
  },
  async run({ client, args }) {
    const titles = flagStringArray(args, 'title');
    if (!titles || titles.length === 0) {
      throw new CliError({
        code: 'validation_error',
        message: 'task create requires at least one --title',
        retriable: false,
      });
    }
    const bodiesArr = flagStringArray(args, 'body') ?? [];
    const tasks = titles.map((title, idx) => {
      const body = bodiesArr[idx];
      return body ? { title, body } : { title };
    });
    return client.createTasks({ tasks });
  },
};

const claimCommand: Command = {
  verb: 'claim',
  summary: 'Claim tasks by task number, or promote-and-claim by message id.',
  help: `silverhand task claim (--task-number N [--task-number N ...] |
                          --message-id <id> [--message-id <id> ...])

Atomic claim. If a task is already claimed by someone else or belongs to
a different channel/thread, the result entry has success=false with a
reason. Always move on when a claim fails — do not retry.

Claiming a "todo" task auto-advances it to "in_progress".

stdout: ClaimTasksResult JSON.`,
  flags: ['task-number', 'message-id'] as const,
  async run({ client, args }) {
    const taskNumbers = flagNumberArray(args, 'task-number');
    const messageIds = flagStringArray(args, 'message-id');
    if (!taskNumbers && !messageIds) {
      throw new CliError({
        code: 'validation_error',
        message: 'task claim requires --task-number or --message-id (or both)',
        retriable: false,
      });
    }
    return client.claimTasks({
      ...(taskNumbers ? { task_numbers: taskNumbers } : {}),
      ...(messageIds ? { message_ids: messageIds } : {}),
    });
  },
};

const unclaimCommand: Command = {
  verb: 'unclaim',
  summary: 'Release your claim on a task.',
  help: `silverhand task unclaim --task-number N

Use only when you can no longer work on the task. To signal completion,
use \`silverhand task status --task-number N --status in_review\` (or
done if explicitly approved) instead.

stdout: TaskMutationResult JSON.`,
  flags: ['task-number'] as const,
  async run({ client, args }) {
    const n = flagNumber(args, 'task-number');
    if (n === undefined) {
      throw new CliError({
        code: 'validation_error',
        message: '--task-number is required',
        retriable: false,
      });
    }
    return client.unclaimTask(n);
  },
};

const statusCommand: Command = {
  verb: 'status',
  summary: 'Move a task through its status workflow.',
  help: `silverhand task status --task-number N --status in_progress|in_review|done

Allowed transitions (you must be the assignee):
  in_progress → in_review : your work is ready for human validation
  in_progress → done      : trivial tasks or after explicit human approval
  in_review   → done      : after human approval (usually the human does this)
  in_review   → in_progress : if you need to iterate

--status takes a single concrete state. The list-only filter macros
(active|open|pending|all) accepted by \`silverhand task list --status\`
are NOT valid here — passing one fails with enum_invalid pointing back
to \`task list\`.

stdout: TaskMutationResult JSON.`,
  flags: ['task-number', 'status'] as const,
  async run({ client, args }) {
    const n = flagNumber(args, 'task-number');
    const status = flagString(args, 'status') as TaskStatus | undefined;
    if (n === undefined || !status) {
      throw new CliError({
        code: 'validation_error',
        message: 'task status requires --task-number and --status',
        retriable: false,
      });
    }
    if (LIST_ONLY_STATUS_MACROS.has(status)) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'enum_invalid',
        message:
          `--status "${status}" is a list-only filter macro for ` +
          '`silverhand task list`, not a writable task status. ' +
          `task status takes a single concrete state: ${VALID_UPDATE_STATUSES.join('|')}.`,
        retriable: false,
        details: {
          flag: 'status',
          value: status,
          allowed: VALID_UPDATE_STATUSES,
          reason: 'list_only_macro',
        },
      });
    }
    if (!VALID_UPDATE_STATUSES.includes(status)) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'enum_invalid',
        message:
          `--status must be one of ${VALID_UPDATE_STATUSES.join('|')}; got "${status}"`,
        retriable: false,
        details: {
          flag: 'status',
          value: status,
          allowed: VALID_UPDATE_STATUSES,
        },
      });
    }
    return client.updateTaskStatus({ task_number: n, status });
  },
};

export const taskCommands: readonly Command[] = [
  listCommand,
  createCommand,
  claimCommand,
  unclaimCommand,
  statusCommand,
];
