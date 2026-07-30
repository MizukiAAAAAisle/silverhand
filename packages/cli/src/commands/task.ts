/**
 * `silverhand task` — list, create, claim, unclaim, status, edit, detail.
 */
import type { MessageSendTarget, TaskStatus } from '@silverhand/shared';
import { CliError } from '../errors.js';
import {
  flagBool,
  flagNumber,
  flagNumberArray,
  flagString,
  flagStringArray,
  type ParsedArgs,
} from '../parse.js';
import type { Command } from './index.js';

const VALID_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'closed'];
const VALID_UPDATE_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'closed',
];

/**
 * List-only filter macros for `task list --status`. Each macro expands
 * to one or more canonical `TaskStatus` values that the agent passes to
 * the backend filter. Macros are NOT new task states: a task in the DB
 * is always one of `todo|in_progress|in_review|done|closed`. They exist purely
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
filtering. Pass --workspace-id <id> to read a sister workspace's board
(you must be a member); the default is the actor's current workspace.

Without filters this returns the entire board, which can be large — pass
--task-number / --status / --mine / --limit to narrow.

Flags:
  --task-number N      Repeatable. Filter to specific task numbers.
                       Last-wins is NOT used; values OR together.
  --status STATUS      Repeatable. Filter by status. Canonical values:
                       todo | in_progress | in_review | done | closed.
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
  summary: 'Create one task (optionally self-claim).',
  help: `silverhand task create --title <title> [--body <body>]
                         [--source-message-id <id>]
                         [--claim]
                         [--target channel|thread:<message_id>]
                         [--conversation-id <id>]

Create ONE task in the current conversation. --title is required; --body is
optional (an omitted body stores an empty description — the title is NOT
duplicated into the body). To create several tasks, call this once per task.

--conversation-id <id> (optional) files the task in ANOTHER conversation
instead of the current one — the cross-conversation case: you finish a
discussion in conversation A and conclude the work belongs in conversation B, so
you create the task in B and carry the context in --title / --body (no messages
are copied, and A gets no activity). Omit it and the task lands in the current
conversation (the default). You must be a member of the destination; a
destination you cannot access — unknown OR not-a-member — fails the same way
(code=forbidden), without revealing whether it exists. Cross-workspace
destinations are judged by the DESTINATION workspace's capabilities. When
--source-message-id is also given, the source MUST live in the destination too
(see below). A cross-conversation create is a DISPATCH: it files the task
UNCLAIMED so a member of the destination conversation picks it up, so it CANNOT
be combined with --claim (that would
self-assign it to you); the combination fails with \`cross_conversation_claim\`
(exit 1) and writes nothing.

--source-message-id <id> links the task to the message that prompted it
(permanent 1:1 provenance). The source message MUST live in the same
conversation as the task — i.e. the destination (--conversation-id when
supplied, otherwise this conversation). A message can back at most ONE task
ever — for its whole lifetime, regardless of that task's status. A second
create from the same source fails with \`source_conflict\`
(exit 1); the error's \`details.existing_task\` points at the task that already
owns it, so hand off to it (or reopen it) rather than re-creating.

--claim (optional) atomically self-claims the created task (lands in_progress
+ assigned to you) instead of leaving it unassigned todo. Requires the
write_tasks capability in addition to create_tasks. \`task claim\` only claims
tasks that already exist; this is the one-step create-and-claim. It applies to
the current conversation only — it cannot be combined with a cross-conversation
--conversation-id (see above).

--target thread:<message_id> (optional) attributes the created task to that
message's thread (reply cluster) instead of the main line. Omit --target, or
pass --target channel, and the task lands on the main line. The id may be a
thread root or any reply in it; the task is anchored to the cluster's root.

Pre-flight failures (exit 1):
  --title not supplied  → missing_required_flag (use the minimal call
                          shown above)
  --message was supplied → flag_removed (use --title / --body)

Create failures (exit 1, structured stderr — NOT printed as success):
  source_conflict              → code=conflict, details.existing_task
  cross_conversation_claim     → code=conflict (--claim with a cross-conversation
                                 --conversation-id; omit --claim)
  source_message_not_found     → code=not_found
  source_not_accessible        → code=forbidden
  source_conversation_mismatch → code=validation_error (source is in a
                                 different conversation than the task)

stdout (success only): CreateTasksResult JSON.`,
  flags: ['title', 'body', 'source-message-id', 'target', 'reply-to', 'conversation-id'] as const,
  booleanFlags: ['claim'] as const,
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
        'silverhand task create takes --title (required) and --body (optional), ' +
        'one task per call: `silverhand task create --title "..." --body "..."`.',
    },
  },
  async run({ client, args }) {
    const title = flagString(args, 'title');
    if (title === undefined) {
      // Daily reports group failures by `error_subkind + details.command +
      // details.flag` rather than by message text. Without a structured
      // subkind here this bucket would be keyed by the literal English
      // sentence — any future copy edit would split the historical bucket.
      throw new CliError({
        code: 'validation_error',
        subkind: 'missing_required_flag',
        message:
          'silverhand task create requires --title. ' +
          'Minimal call: `silverhand task create --title "..." --body "..."`. ' +
          'To create a task from an existing message and start it in one ' +
          'call, use `silverhand task create --title "..." ' +
          '--source-message-id <id> --claim`.',
        retriable: false,
        details: { command: 'task create', flag: 'title' },
      });
    }
    const body = flagString(args, 'body');
    const sourceMessageId = flagString(args, 'source-message-id');
    const target = parseTaskCreateTarget(
      flagString(args, 'target'),
      flagString(args, 'reply-to'),
    );
    const claim = flagBool(args, 'claim');
    const conversationId = flagString(args, 'conversation-id');
    const result = await client.createTasks({
      tasks: [
        {
          title,
          ...(body !== undefined ? { body } : {}),
          ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        },
      ],
      ...(claim ? { claim: true } : {}),
      ...(target ? { target } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });
    // The route returns 200 with a typed envelope even for business failures
    // (so `source_conflict` keeps its `existing_task`). `create` is all-or-
    // nothing: an `error` in the body is a FAILURE and must exit non-zero with
    // structured stderr — never be printed to stdout as success.
    if ('error' in result) {
      throw createFailureToCliError(result);
    }
    return result;
  },
};

/** Translate a create-op failure envelope into a non-zero CliError. The
 *  stable `code` drives the exit code + retriability; `source_conflict` keeps
 *  its `existing_task` in `details` so the agent can hand off to the winner. */
function createFailureToCliError(result: { error: string; existing_task?: unknown }): CliError {
  switch (result.error) {
    case 'source_conflict':
      return new CliError({
        code: 'conflict',
        subkind: 'source_conflict',
        message:
          'a task already exists for that --source-message-id (permanent 1:1 ' +
          'provenance). Hand off to the existing task (see details.existing_task) ' +
          'or reopen it instead of re-creating.',
        retriable: false,
        details: {
          error: result.error,
          ...(result.existing_task ? { existing_task: result.existing_task } : {}),
        },
      });
    case 'source_not_accessible':
    case 'not_conversation_member':
      return new CliError({
        code: 'forbidden',
        message: `task create failed: ${result.error}`,
        retriable: false,
        details: { error: result.error },
      });
    case 'source_message_not_found':
    case 'reply_target_not_found':
    case 'conversation_not_found':
    case 'agent_not_found':
      return new CliError({
        code: 'not_found',
        message: `task create failed: ${result.error}`,
        retriable: false,
        details: { error: result.error },
      });
    case 'conversation_closed':
      return new CliError({
        code: 'conflict',
        message: 'task create failed: the conversation is closed',
        retriable: false,
        details: { error: result.error },
      });
    case 'conversation_archived':
      return new CliError({
        code: 'conflict',
        message: 'task create failed: the conversation is archived',
        retriable: false,
        details: { error: result.error },
      });
    case 'cross_conversation_claim':
      // Cross-conversation create is a DISPATCH — the task is filed unclaimed so
      // a member of the destination conversation picks it up. This mapper is the
      // SINGLE source of the human-readable reason; the route/service carry only
      // the typed code.
      return new CliError({
        code: 'conflict',
        subkind: 'cross_conversation_claim',
        message:
          'cannot --claim a task created in another conversation: a cross-conversation ' +
          'create files the task UNCLAIMED so a member of the destination conversation ' +
          'can claim and execute it. Omit --claim.',
        retriable: false,
        details: { error: result.error },
      });
    default:
      // source_conversation_mismatch and any future op error: an input problem.
      return new CliError({
        code: 'validation_error',
        message: `task create failed: ${result.error}`,
        retriable: false,
        details: { error: result.error },
      });
  }
}

function parseTaskCreateTarget(
  rawTarget: string | undefined,
  rawReplyTo: string | undefined,
): MessageSendTarget | undefined {
  if (rawTarget !== undefined && rawReplyTo !== undefined) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'mutually_exclusive',
      message:
        '--reply-to and --target are mutually exclusive: use ' +
        '`--target thread:<message_id>` for threaded task creation.',
      retriable: false,
      details: { flags: ['reply-to', 'target'] },
    });
  }
  if (rawReplyTo !== undefined) {
    return { kind: 'thread', message_id: rawReplyTo };
  }
  if (rawTarget === undefined || rawTarget === 'channel' || rawTarget === 'self') {
    return rawTarget === undefined ? undefined : { kind: 'channel' };
  }
  if (rawTarget.startsWith('thread:')) {
    const messageId = rawTarget.slice('thread:'.length);
    if (!messageId) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'enum_invalid',
        message: '--target thread:<message_id> requires a message id after thread:',
        retriable: false,
        details: { flag: 'target', value: rawTarget },
      });
    }
    return { kind: 'thread', message_id: messageId };
  }
  throw new CliError({
    code: 'validation_error',
    subkind: 'enum_invalid',
    message: '--target must be channel or thread:<message_id>',
    retriable: false,
    details: { flag: 'target', value: rawTarget },
  });
}

/** Resolve the optional `--workspace-id` / `--workspace <name>` pair
 *  into the wire-shape fields. They are mutually exclusive: passing
 *  both is rejected pre-flight with a clear message so the agent does
 *  not have to round-trip to the backend to learn the same. Omitting
 *  both means "use the current workspace" (the legacy default). */
function resolveWorkspaceSelector(
  args: ParsedArgs,
): { workspace_id?: string; workspace_name?: string } {
  const workspaceId = flagString(args, 'workspace-id');
  const workspaceName = flagString(args, 'workspace');
  if (workspaceId && workspaceName) {
    throw new CliError({
      code: 'validation_error',
      subkind: 'mutually_exclusive',
      message: '--workspace-id and --workspace are mutually exclusive',
      retriable: false,
      details: { flags: ['workspace-id', 'workspace'] },
    });
  }
  return {
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(workspaceName ? { workspace_name: workspaceName } : {}),
  };
}

const claimCommand: Command = {
  verb: 'claim',
  summary: 'Claim existing tasks by task number.',
  help: `silverhand task claim --task-number N [--task-number N ...]
                         [--workspace-id <id> | --workspace <name>]

Atomic claim of tasks that ALREADY exist. If a task is already claimed by
someone else, the result entry has success=false with a reason. Always
move on when a claim fails — do not retry.

Claiming a "todo" task auto-advances it to "in_progress".

To create a task from a message and start it in one call, use
\`silverhand task create --title "..." --source-message-id <id> --claim\`.

Workspace selector (cross-workspace claims):
  --workspace-id <id>   Target a specific workspace by id.
  --workspace <name>    Target by workspace name. Fails if 0 or >1
                        workspaces share the name (the result includes
                        \`workspace_candidates\` on ambiguity).
  (default)             The actor's current workspace.

You must be a member of the resolved workspace; otherwise the claim
fails with \`workspace_membership_required\`.

stdout: ClaimTasksResult JSON.`,
  flags: ['task-number', 'workspace-id', 'workspace'] as const,
  async run({ client, args }) {
    const taskNumbers = flagNumberArray(args, 'task-number');
    if (!taskNumbers) {
      throw new CliError({
        code: 'validation_error',
        message: 'task claim requires --task-number',
        retriable: false,
      });
    }
    const selector = resolveWorkspaceSelector(args);
    return client.claimTasks({
      task_numbers: taskNumbers,
      ...selector,
    });
  },
};

const unclaimCommand: Command = {
  verb: 'unclaim',
  summary: 'Release your claim on a task.',
  help: `silverhand task unclaim --task-number N
                           [--workspace-id <id> | --workspace <name>]

Use only when you can no longer work on the task. To signal completion,
use \`silverhand task status --task-number N --status in_review\` (or
done if explicitly approved) instead.

Workspace selector — see \`silverhand task claim --help\`. You must be
the task's assignee.

stdout: TaskMutationResult JSON.`,
  flags: ['task-number', 'workspace-id', 'workspace'] as const,
  async run({ client, args }) {
    const n = flagNumber(args, 'task-number');
    if (n === undefined) {
      throw new CliError({
        code: 'validation_error',
        message: '--task-number is required',
        retriable: false,
      });
    }
    const selector = resolveWorkspaceSelector(args);
    return client.unclaimTask({ task_number: n, ...selector });
  },
};

const statusCommand: Command = {
  verb: 'status',
  summary: 'Move a task through its status workflow.',
  help: `silverhand task status --task-number N --status todo|in_progress|in_review|done|closed
                          [--workspace-id <id> | --workspace <name>]

Allowed transitions (you must be the assignee, or the creator of an
unassigned task you created yourself):
  in_progress → in_review : your work is ready for human validation
  in_progress → done      : trivial tasks or after explicit human approval
  in_progress → closed    : close work that will not be handled
  in_review   → done      : after human approval (usually the human does this)
  in_review   → closed    : close work that will not be handled
  in_review   → in_progress : if you need to iterate
  todo        → closed    : close work before it starts
  done        → closed    : close completed work out of the board
  closed      → todo / in_progress / in_review / done : reopen into a concrete state

--status takes a single concrete state. The list-only filter macros
(active|open|pending|all) accepted by \`silverhand task list --status\`
are NOT valid here — passing one fails with enum_invalid pointing back
to \`task list\`.

Workspace selector — see \`silverhand task claim --help\`. Cross-workspace
status updates require you to be a member of the resolved workspace.

stdout: TaskMutationResult JSON.`,
  flags: ['task-number', 'status', 'workspace-id', 'workspace'] as const,
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
    const selector = resolveWorkspaceSelector(args);
    return client.updateTaskStatus({ task_number: n, status, ...selector });
  },
};

const editCommand: Command = {
  verb: 'edit',
  summary: "Edit a task's title and/or content (last-write-wins).",
  help: `silverhand task edit --task-number N
                        [--title <title>] [--body <body>]
                        [--workspace-id <id> | --workspace <name>]

Edit the current definition (title and/or content) of an existing task.
Provide at least one of --title / --body. --body sets the full content;
pass --body "" to clear it. Fields you omit are left unchanged.

Last-write-wins: the edit is applied directly and the most recent
successful write wins — there is no concurrency check. It never changes
status or assignee. The result carries the full updated task detail.

Workspace selector — see \`silverhand task claim --help\`.

stdout: TaskEditResult JSON.`,
  flags: [
    'task-number',
    'title',
    'body',
    'workspace-id',
    'workspace',
  ] as const,
  async run({ client, args }) {
    const taskNumber = flagNumber(args, 'task-number');
    if (taskNumber === undefined) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'missing_required_flag',
        message: 'task edit requires --task-number',
        retriable: false,
        details: { command: 'task edit', flag: 'task-number' },
      });
    }
    const title = flagString(args, 'title');
    const body = flagString(args, 'body');
    if (title === undefined && body === undefined) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'missing_required_flag',
        message: 'task edit requires at least one of --title or --body',
        retriable: false,
        details: { command: 'task edit' },
      });
    }
    const selector = resolveWorkspaceSelector(args);
    return client.editTask({
      task_number: taskNumber,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...selector,
    });
  },
};

const detailCommand: Command = {
  verb: 'detail',
  summary: "Read one task's full detail (content + provenance).",
  help: `silverhand task detail --task-number N
                         [--workspace-id <id> | --workspace <name>]

Read a single task's full definition: title, complete content,
last-editor attribution, the provenance \`source_message_id\`,
and a viewer-resolved \`nav\` target for "view in conversation".

--task-number is the task's per-workspace number (the \`task_number\` field
on each row from \`task list\`, and what \`#task:N\` refers to).

Workspace selector — see \`silverhand task claim --help\`. Defaults to the
actor's current workspace.

stdout: { "task": TaskDetailDto }`,
  flags: ['task-number', 'workspace-id', 'workspace'] as const,
  async run({ client, args }) {
    const taskNumber = flagNumber(args, 'task-number');
    if (taskNumber === undefined) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'missing_required_flag',
        message: 'task detail requires --task-number (from `task list` rows)',
        retriable: false,
        details: { command: 'task detail', flag: 'task-number' },
      });
    }
    const selector = resolveWorkspaceSelector(args);
    return client.getTaskDetail({ task_number: taskNumber, ...selector });
  },
};

export const taskCommands: readonly Command[] = [
  listCommand,
  createCommand,
  claimCommand,
  unclaimCommand,
  statusCommand,
  editCommand,
  detailCommand,
];
