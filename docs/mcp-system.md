# MCP System

> Current contract for Silverhand's `mcp__chat__*` tool surface.
> Keep this document in sync with `packages/chat-bridge/src/server.ts`,
> `packages/chat-bridge/src/client.ts`,
> `packages/shared/src/api/dto.ts`, and the agent-facing internal routes in
> `packages/backend/src/routes.ts`.

## 1. Purpose

Every spawned agent CLI talks to Silverhand through a per-agent
`chat-bridge` MCP stdio server. Agent prose written to normal stdout is not a
chat reply; visible conversation output must go through
`mcp__chat__send_message`.

The MCP namespace stays `mcp__chat__`. Tool names and field names expose the
public product model:

```
workspace -> channel -> thread
```

The bridge and backend internal routes use `conversation_id` for the shared
runtime container. Public tool names still expose only workspace/channel/thread.

## 2. Process Boundary

`ConversationManager` starts one agent CLI process for each
`(channel, agent)` pair and launches `chat-bridge` as that agent's MCP server.
The bridge receives:

| Argument | Meaning |
|----------|---------|
| `--conversation-id` | Current channel/thread conversation id |
| `--agent-id` | Current agent id |
| `--server-url` | Backend base URL |
| `--runtime` | Runtime name, default `claude` |
| `SILVERHAND_AUTH_TOKEN` / `--auth-token` | Bearer token for internal routes |

The bridge never talks to SQLite directly. Every MCP tool calls backend HTTP
under `/internal/conversations/:conversationId/agents/:agentId/...`; the backend
enforces membership, scope, task ownership, lifecycle side effects, and event
publishing.

## 3. Tool Surface

### `send_message`

Send a visible chat message.

```ts
send_message({
  content: string,
  target?: 'self' | 'parent' | { thread_id: string },
}) -> { message_id: string }
```

Rules:
- `target` defaults to `self`, meaning the current channel or thread.
- `parent` is valid only from inside a thread.
- `{ thread_id }` targets a direct child thread opened from the current channel.
- The backend inserts the message, fans it out to other agents in the target,
  publishes message events, and resolves the sender's current run as `replied`.

### `create_thread`

Open an isolated thread off the current channel.

```ts
create_thread({
  title: string,
  members?: string[],
  context_summary: string,
  initial_prompt: string,
}) -> { thread_id: string }
```

Rules:
- Use for a side discussion large enough to separate from the current channel,
  or for bounded parallel delegation.
- Do not use inside a thread; threads do not nest.
- `members` is optional. When omitted, the backend copies all current channel
  members into the thread.
- If `members` is provided, it must be a subset of current channel members; the
  caller is always added even if omitted from the list.
- The backend creates the child conversation, adds the resolved members, then
  seeds two messages:
  - a system `child_context` message containing `context_summary`
  - an agent message from the creator containing `initial_prompt`

### `close_thread`

Close the current thread.

```ts
close_thread({
  summary: string,
  posted_to_parent?: boolean,
}) -> "ok"
```

Rules:
- Use only from inside a thread.
- If `posted_to_parent` is false or omitted, the backend posts a system summary
  to the parent channel.
- If the agent already sent the conclusion with
  `send_message({ target: 'parent', ... })`, pass `posted_to_parent: true` to
  avoid duplicate summaries.
- Closing a thread resolves active runs, updates parent thread badges, and
  stops running agents in the closed thread.

### `create_channel`

Create a new top-level channel in the current workspace.

```ts
create_channel({
  title: string,            // 1..128 chars
  context_summary: string,
  initial_prompt: string,
}) -> { channel_id: string }
```

Rules:
- Use only when the user explicitly asks for a separate channel or a separate
  conversation.
- Do not use to avoid context clutter or to parallelize work; use
  `create_thread` for those cases.
- The new channel is created in the current workspace with all current channel
  members. There is no `members` parameter.
- The backend seeds a system context message and an agent `initial_prompt`,
  distributes the prompt to other members, and auto-starts agents that are not
  already running.

## 4. Task Tools

Tasks are message metadata. The task board is visible at workspace scope, but
mutations are scoped to the current channel or thread.

### `list_tasks`

```ts
list_tasks({
  status?: 'all' | 'todo' | 'in_progress' | 'in_review' | 'done',
}) -> { tasks: TaskSummaryDto[] }
```

Lists tasks across the current workspace. Each row carries source information
for the channel/thread it belongs to.

### `create_tasks`

```ts
create_tasks({
  tasks: Array<{
    title: string,   // 1..200 chars
    body?: string,
  }>,
}) -> { tasks: TaskSummaryDto[] }
```

Creates task messages in the current channel/thread. This does not auto-claim.

### `claim_tasks`

```ts
claim_tasks({
  task_numbers?: number[],
  message_ids?: string[],
}) -> { results: ClaimTasksResult[] }
```

Two modes:
- `task_numbers`: claim existing tasks from `list_tasks`
- `message_ids`: promote regular messages in the current channel/thread into
  tasks and claim them

Claiming is atomic per result. If a task is already claimed or belongs to
another channel/thread, the result has `success: false`; the agent must move on
instead of retrying blindly. Claiming a `todo` task advances it to
`in_progress`.

### `unclaim_task`

```ts
unclaim_task({ task_number: number }) -> TaskMutationResult
```

Use only when the assignee can no longer work on a task. Do not use unclaim to
signal completion.

### `update_task_status`

```ts
update_task_status({
  task_number: number,
  status: 'in_progress' | 'in_review' | 'done',
}) -> TaskMutationResult
```

Allowed transitions:

| From | To | Meaning |
|------|----|---------|
| `in_progress` | `in_review` | Work is ready for human validation |
| `in_progress` | `done` | Trivial work or explicit human approval |
| `in_review` | `done` | Human approved |
| `in_review` | `in_progress` | Assignee is iterating again |

Default behavior for non-trivial work is to stop at `in_review` and let the
human approve `done`.

## 5. Deliberately Absent Tools

The current MCP surface intentionally does not expose:

| Absent tool | Reason |
|-------------|--------|
| `create_session` / `close_session` | Renamed out of the public model; use `create_channel` / `close_thread` |
| `read_history` / `check_messages` | Message delivery is pushed through stdin/inbox and visible chat; history access remains UI/backend work |
| Memory / consensus tools | Agents use their native file tools against `MEMORY.md`, `notes/`, and `.silverhand/CONSENSUS.md` |
| Attachment tools | Designed separately, not implemented in the current MCP surface |

## 6. Prompt Contract

`packages/backend/src/drivers/platform-prompt.ts` teaches agents the operating
rules for this tool surface. The important invariants are:

- Visible chat replies must use `send_message`.
- System messages are informational unless they explicitly ask for a reply.
- Agent messages from others do not require acknowledgement unless directly
  addressed, assigned, or blocked by the current agent.
- Use `create_thread` for parallel side work and `create_channel` only when the
  user explicitly asks for a separate channel.
- User-opened threads should be summarized visibly and closed only after user
  confirmation.
- Claim tasks before working; leave non-trivial completed work in `in_review`.

## 7. Maintenance Checklist

Any change to MCP tools, schemas, return shapes, backend side effects, task
workflow, or platform prompt rules must update this document in the same change.

When changing the MCP system, check all of these:

1. `packages/chat-bridge/src/server.ts` tool definitions and descriptions
2. `packages/chat-bridge/src/client.ts` bridge-to-backend calls
3. `packages/shared/src/api/dto.ts` agent-facing input schemas
4. `packages/shared/src/api/paths.ts` internal route paths
5. `packages/backend/src/routes.ts` internal route behavior and side effects
6. `packages/backend/src/drivers/platform-prompt.ts` agent instructions
7. Tests under `packages/backend/tests/routes/` and
   `packages/backend/tests/drivers/`
8. This document
