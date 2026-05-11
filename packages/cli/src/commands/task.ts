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
  --status STATUS      Repeatable. Filter by status. Valid:
                       todo | in_progress | in_review | done.
                       Multiple values OR together.
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
    if (statusValues) {
      for (const s of statusValues) {
        if (!VALID_STATUSES.includes(s as TaskStatus)) {
          throw new CliError({
            code: 'validation_error',
            message: `--status must be one of ${VALID_STATUSES.join('|')}; got ${s}`,
            retriable: false,
          });
        }
      }
    }
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
      ...(statusValues ? { status: statusValues as TaskStatus[] } : {}),
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

stdout: CreateTasksResult JSON.`,
  flags: ['title', 'body'] as const,
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
    if (!['in_progress', 'in_review', 'done'].includes(status)) {
      throw new CliError({
        code: 'validation_error',
        message: `--status must be one of in_progress|in_review|done; got ${status}`,
        retriable: false,
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
