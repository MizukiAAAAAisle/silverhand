/**
 * `silverhand task` — list, create, claim, unclaim, status.
 */
import type { TaskStatus } from '@silverhand/shared';
import { CliError } from '../errors.js';
import {
  flagNumber,
  flagNumberArray,
  flagString,
  flagStringArray,
} from '../parse.js';
import type { Command } from './index.js';

const listCommand: Command = {
  verb: 'list',
  summary: 'View the workspace task board.',
  help: `silverhand task list [--status all|todo|in_progress|in_review|done]
                       [--workspace-id <id>] [--conversation-id <id>]

Returns aggregated tasks across the current workspace. You can only
mutate tasks that belong to your current channel/thread; others are
returned read-only.

Flags:
  --status              Filter. Default "all".
  --workspace-id        Optional filter to a specific workspace.
  --conversation-id     Optional filter to a specific conversation.

stdout: { "tasks": [TaskSummaryDto, ...] }`,
  async run({ client, args }) {
    const status = flagString(args, 'status') as TaskStatus | 'all' | undefined;
    if (status && !['all', 'todo', 'in_progress', 'in_review', 'done'].includes(status)) {
      throw new CliError({
        code: 'validation_error',
        message: `--status must be one of all|todo|in_progress|in_review|done; got ${status}`,
        retriable: false,
      });
    }
    return client.listTasks({
      ...(status ? { status } : {}),
      ...(flagString(args, 'workspace-id')
        ? { workspace_id: flagString(args, 'workspace-id') }
        : {}),
      ...(flagString(args, 'conversation-id')
        ? { conversation_id: flagString(args, 'conversation-id') }
        : {}),
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
