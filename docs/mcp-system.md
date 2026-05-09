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
  attachment_ids?: string[],   // up to 20; see §5
}) -> { message_id: string }
```

Rules:
- `target` defaults to `self`, meaning the current channel or thread.
- `parent` is valid only from inside a thread.
- `{ thread_id }` targets a direct child thread opened from the current channel.
- `attachment_ids` (optional) reference attachments uploaded via `upload_file`.
  Every id must belong to the destination channel; threads inherit their
  parent channel. The backend embeds an immutable snapshot per id into the
  message metadata and renders an `[N attachments — use view_file ...]` suffix
  into every delivery path.
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

## 4. Read & Search History

### `read_history`

Read anchored chat history from the current channel/thread, the parent (if
called from inside a thread), a direct child thread, or any conversation the
caller is currently a member of (cross-workspace navigation, see §4.4).

```ts
read_history({
  target?: 'self' | 'parent'
         | { thread_id: string }
         | { conversation_id: string },
  before_seq?: number,
  after_seq?: number,
  around_message_id?: string,
  include_content?: boolean,    // default false
  include_system?: boolean,     // default true
  limit?: number,               // default 50, max 100
}) -> {
  target: ReadHistoryTargetRef,
  anchor:
    | { type: 'before_seq', seq: number }
    | { type: 'after_seq', seq: number }
    | { type: 'around_message_id', message_id: string },
  limit: number,
  include_content: boolean,
  include_system: boolean,
  messages: Array<{
    message_ref: MessageRef,    // { id, workspace_id, conversation_id,
                                //   conversation_kind, channel_id,
                                //   thread_id|null, seq, created_at }
    sender: { kind, agent_id|null, user_id|null, display_name|null },
    snippet: string,            // ≤ 160 chars, whitespace-collapsed
    metadata: object|null,
    attachments: AttachmentSnapshot[]|null,
    content?: string,           // present only when include_content=true
  }>,
  has_more_before: boolean,
  has_more_after: boolean,
}
```

Rules:
- Exactly one of `before_seq` / `after_seq` / `around_message_id` is required.
  None or more than one returns 400 with `anchor required`.
- `target` is intentionally a separate union from `send_message.target` — adding
  the `{conversation_id}` form here does **not** widen what the agent may post
  to. The backend rechecks current `conversation_agents` membership of the
  resolved target — even if the caller is in the source conversation, they must
  currently be a member of the target. `parent` from a top-level channel
  returns 400 (`no_parent`); a `{thread_id}` that is not a direct child of the
  current channel returns 400 (`thread_not_child`); a `{conversation_id}` that
  doesn't exist returns 404 (`conversation_not_found`) — note that a workspace
  id passed where a conversation id is expected hits this branch, since
  workspace ids do not appear in `conversations`; an existing conversation row
  whose kind is not readable (i.e. not `channel` / `dm_channel` / `thread`)
  returns 400 (`unsupported_conversation_kind`); a target the caller is not a
  member of returns 403 (`not_target_conversation_member`).
- `around_message_id` is conversation-scoped: the backend looks up the message
  by `(id, conversation_id=target)` so cross-conversation id guesses return
  404 (`message_not_found`) instead of leaking.
- Read-only by contract. **`read_history` never updates
  `conversation_inboxes.delivered_at`** — it does not consume the agent's
  push queue.
- Default response shape is snippet+metadata. Set `include_content=true` only
  when the agent actually needs full bodies; this avoids burning context on
  long messages.
- `seq` is per-conversation monotonic; `id` is the global random message id
  surfaced in stdin pushes (`message_id=...`) and in `MessageRef`. Pagination:
  use `before_seq` / `after_seq` from a previous `MessageRef.seq`. Single
  message lookup: `before_seq = ref.seq + 1, limit: 1, include_content: true`.

Anchor seed for `around_message_id`: every dispatched message (live, gated
batch, inbox drain, kickoff) carries a `message_id=<id>` line in its stdin
prose. Agents pass any `id` they have seen — from a push, a search hit, or a
prior `read_history` page — as `around_message_id` to fetch its window. Search
hits returned by `search_messages` carry `hit.message_ref.conversation_id`,
which the agent should pass as `target: { conversation_id: ... }` together
with `around_message_id: hit.message_ref.id` to materialize a remote hit.

### `list_workspaces`

List every workspace the caller agent currently has member access to —
regular workspaces it has been added to (`workspace_members` join) plus its
own personal `agent_home` workspace (resolved via `owner_agent_id`; the v17
trigger keeps `workspace_members` agent_home-free, so ownership is the only
way an agent reaches its own home). Use this before
`list_channels({workspace_id})` and `search_messages({workspace_id})` so
that workspace ids come from the tool surface.

```ts
list_workspaces({}) -> {
  workspaces: Array<{
    id: string,
    name: string,
    kind: 'regular' | 'agent_home',  // DB truth — there is no synthetic
                                     //   'dm' workspace kind; "DM" is a
                                     //   conversation kind that lives
                                     //   inside an agent_home workspace.
    archived: boolean,
    updated_at: number,
    agent_dir: string,               // absolute path; see below.
  }>,
}
```

Rules:
- `agent_dir` is kind-branched and mirrors `activeAgentProfileDir`:
  - `agent_home` → the workspace root itself (the agent's L1 directory). The
    agent's `MEMORY.md`, `notes/`, and `system_prompt.md` live directly here.
  - `regular` → `${workspace_path}/.silverhand/agents/${agent_id}` (the
    nested L2 working copy of the agent's profile). Use it to read your
    own per-workspace MEMORY/notes/logs for self-correction or cleanup.
- Other agents' `agent_home` workspaces are excluded — only the caller's own
  home is returned.
- Sort: regular workspaces first (alphabetical), then the agent's own home
  (alphabetical fallback by name; in practice there is one home per agent).
- No pagination in v1.

### `list_channels`

List top-level channels of a workspace where this caller agent is currently
a member. Defaults to the current workspace; pass `workspace_id` (from
`list_workspaces`) to list channels of another workspace the caller has
access to. Use this before `search_messages(scope='channel', ...)` so that
channel ids come from the tool surface — agents never invent or guess
channel ids.

```ts
list_channels({ workspace_id?: string }) -> {
  workspace_id: string,
  channels: Array<{
    id: string,
    title: string,
    kind: 'channel' | 'dm_channel',
    archived: boolean,
    updated_at: number,
  }>,
}
```

Rules:
- When `workspace_id` is omitted, defaults to the source conversation's
  workspace.
- When `workspace_id` is supplied and differs from the source workspace, the
  route gates the call via the `canAgentAccessWorkspace` helper
  (workspace-level access = `workspace_members` ∪ owned `agent_home`). A
  workspace the agent is not a member of returns 403; another agent's
  `agent_home` returns 403 for the same reason.
- Returns only `channel` and `dm_channel` rows from the target workspace
  where the caller's agent id is in `conversation_agents`. Threads are
  deliberately excluded; threads are reached via
  `read_history({ target: { thread_id }, ... })`, via
  `read_history({ target: { conversation_id }, ... })` for any thread the
  agent is a member of in any workspace, or via `search_messages`
  child-thread fan-out below.
- Archived channels are returned but sorted to the bottom; the `archived`
  flag lets the agent decide whether to include them in search.
- No pagination in v1 (workspaces are small enough that returning all member
  channels is cheaper than paging).

### `search_messages`

Search message text the caller agent can currently see, with a 3-axis scope.
Returns excerpt-only hits — agents call `read_history({ target: { conversation_id },
around_message_id })` on a hit when they need the full body.

```ts
search_messages({
  q: string,                                    // 1..200 chars
  scope?: 'current' | 'workspace' | 'channel',  // default 'current'
  workspace_id?: string,                        // valid only with
                                                //   scope='workspace';
                                                //   defaults to source ws
  channel_id?: string,                          // required iff scope='channel'
  include_system?: boolean,                     // default true
  limit?: number,                               // default 50, max 100
}) -> {
  query: string,
  scope: 'current' | 'workspace' | 'channel',
  workspace_id: string | null,
  channel_id: string | null,
  include_system: boolean,
  limit: number,
  hits: Array<{
    message_ref: MessageRef,           // same shape as read_history
    sender: { kind, agent_id|null, user_id|null, display_name|null },
    excerpt: string,                   // ±80 chars around match,
                                       //   whitespace-collapsed,
                                       //   "..." ellipsis on truncation
    match_offset: number,              // 0-based offset of the match
                                       //   inside `excerpt`
  }>,
}
```

Rules:
- Backend uses LIKE (case-insensitive for ASCII via SQLite default) — no FTS5
  in v1. The agent route is independent from the human UI `/api/search`; it
  always injects the caller's principal scope server-side.
- Membership is a hard SQL filter on **current** `conversation_agents` state
  (not historical at-time-of-message). Leaving a workspace removes search
  visibility of its history. This conversation-level filter is the bottom
  guard regardless of which scope the caller picks.
- `scope='current'`: search the source conversation only. The caller is a
  member of the source by definition.
- `scope='workspace'`: search every conversation in the target workspace
  where the caller is currently a member. By default the target is the
  source conversation's workspace; pass `workspace_id` (from
  `list_workspaces`) to search a different workspace. Cross-workspace
  access is gated up-front via `canAgentAccessWorkspace`; the
  `conversation_agents` JOIN below stays as the bottom guard so unjoined
  channels in the target workspace remain invisible.
- `scope='channel'`: requires `channel_id` (must come from `list_channels`).
  `channel_id` is global — it can be a channel from any workspace the
  caller has access to. Searches the channel and its child threads, but
  child threads still go through the `conversation_agents` membership
  filter, so threads the caller is not a member of are not leaked.
  Channels the caller is not a member of return 403 (`not_channel_member`)
  regardless of workspace; thread ids passed as `channel_id` → 404
  (`channel_not_found`).
- Mixing rules → 400: `scope='channel'` without `channel_id` (or any other
  scope with `channel_id`); `workspace_id` together with any scope other
  than `'workspace'`.
- Hits never include full `content`. To materialize a hit body, call
  `read_history({ target: { conversation_id: hit.message_ref.conversation_id },
  around_message_id: hit.message_ref.id, include_content: true })`. Using the
  default `target: 'self'` for a remote hit will 404 — the message lives in a
  different conversation.

### 4.4 Cross-workspace navigation

When the caller needs to dig into history in a workspace other than the
source (e.g. an agent woken in its `agent_home` DM by a `schedule_fire`
needs to revisit a project channel it belongs to), the chain is:

1. `list_workspaces({})` — discovery; pick the target workspace and grab
   its `id` and `agent_dir`.
2. `list_channels({ workspace_id })` — discovery; pick the target channel
   and grab its `id`. Optional but required if the next step is
   `scope='channel'`.
3. Either:
   - `search_messages({ scope: 'workspace', workspace_id })` for a wide
     keyword sweep of the workspace, or
   - `search_messages({ scope: 'channel', channel_id })` for a single
     channel + visible child threads, or
   - `read_history({ target: { conversation_id }, around_message_id })`
     to read a specific window directly.
4. To materialize the body of a search hit:
   `read_history({ target: { conversation_id: hit.message_ref.conversation_id },
   around_message_id: hit.message_ref.id, include_content: true })`.

Workspace-level access (`canAgentAccessWorkspace`) is the top gate;
conversation-level membership (`conversation_agents`) is always the bottom
guard. Cross-workspace **read** does not imply cross-workspace **post** —
`send_message.target` remains `'self' | 'parent' | { thread_id }` only.

## 5. Task Tools

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

## 6. Schedules

Agent-owned cron-like scheduler. A schedule is a self-driven reminder for
ONE agent — it has zero coupling to channels, tasks, or other agents.
The agent picks a time policy (`spec`) and the backend wakes the agent
at the next due time by inserting a `from_kind='system'` message into
the agent's agent_home primary `dm_channel`. The wake message carries
`metadata.subtype = 'schedule_fire'`; see
`docs/agent-run-state.md` §13 for run-state interaction.

Routes hang off the calling conversation only so the existing internal
principal middleware (`cid`+`aid` → `AgentPrincipal`) authenticates the
request — the schedule itself is owned by `principal.agentId` and the
conversation context is irrelevant to its lifecycle.

### `schedule`

Create a self-wake schedule.

```ts
schedule({
  message: string,                      // 1..500 chars; echoed in wake body
  spec:
    | { kind: 'once', fire_at?: number, delay_seconds?: number }   // exactly one of fire_at/delay_seconds
    | { kind: 'interval', every_seconds: number, start_at?: number } // every_seconds >= 60
    | { kind: 'cron', expression: string, timezone: string },        // 5-field UNIX cron, IANA tz
  until_at?: number,                    // epoch-ms UTC end time (repeat only; rejected on `once`)
  max_occurrences?: number,             // fire-count cap (repeat only; rejected on `once`)
  allow_unbounded?: boolean,            // required `true` for repeats with neither cap; rejected on `once`
}) -> { schedule: ScheduleDto }
```

`ScheduleDto` shape (see `packages/shared/src/api/dto.ts`):

```ts
{
  id: string,
  owner_agent_id: string,
  message: string,
  spec: ScheduleSpec,                   // canonicalized — `delay_seconds` is converted to `fire_at`
  next_fire_at: number,                 // epoch-ms UTC of the next planned fire
  status: 'pending' | 'firing' | 'done' | 'cancelled' | 'failed',
  fired_count: number,
  last_fired_at: number | null,
  max_occurrences: number | null,
  until_at: number | null,
  failure_reason: string | null,
  cancelled_at: number | null,
  created_at: number,
  updated_at: number,
}
```

Rules:
- Quotas (server-enforced): per-agent ≤50 active (`pending`+`firing`);
  one-shot delay ∈ [30s, 90d]; interval `every_seconds` ≥ 60.
- Cron expression must be exactly 5 whitespace-separated fields. Aliases
  like `@daily` and 6-field (seconds-precision) expressions are rejected
  with `invalid_cron_expression`.
- Cron `timezone` must be a valid IANA name (validated via
  `Intl.DateTimeFormat`); invalid → `invalid_timezone`.
- Repeat schedules must terminate explicitly: set `max_occurrences`
  and/or `until_at`, or pass `allow_unbounded: true`. Otherwise →
  `unbounded_repeat_requires_explicit_limit`.
- One-shots reject `until_at`, `max_occurrences`, and `allow_unbounded`
  (→ `invalid_input`). One-shot semantics ("fires exactly once at a
  specific time") leave no room for those knobs, and silent-ignoring
  them would surface a non-canonical row in the response (e.g. a
  one-shot DTO showing `max_occurrences: 3`).
- The post-fire `next_fire_at` is always computed from the actual fire
  time, NOT from the previous `next_fire_at`. A missed multi-occurrence
  window fires once and the schedule advances forward — there is no
  backfill of skipped occurrences.
- Wake delivery target is the owner agent's agent_home primary
  `dm_channel`. If that channel is missing at create time, the request
  fails fast with `agent_home_not_found` rather than queueing a
  guaranteed-`failed` schedule.

### `list_schedules`

```ts
list_schedules({
  status?: 'pending' | 'firing' | 'active' | 'done' | 'cancelled' | 'failed' | 'all',
  limit?: number,                       // default 100, max 200
}) -> { schedules: ScheduleDto[] }
```

Rules:
- Returns only schedules owned by the calling agent.
- `status='active'` is sugar for `pending|firing` — the DB never persists
  the literal `active`.
- Ordered by `next_fire_at ASC, created_at ASC` so the most-imminent
  rows come first.

### `cancel_schedule`

```ts
cancel_schedule({ schedule_id: string }) -> { schedule: ScheduleDto }
```

Rules:
- Only `pending` and `firing` rows are cancellable; terminal states
  (`done`, `cancelled`, `failed`) → `not_cancellable` (HTTP 409).
- Cross-agent cancel is rejected with `not_owner` (HTTP 403); unknown id
  → `schedule_not_found` (HTTP 404).
- Cancel races with an in-flight fire are accepted: if cancel arrives
  after the scheduler's CAS-claim, the wake may still be delivered, but
  no further fires will occur (the post-fire write is predicated on
  `status='firing'` so cancel always wins terminal status).

### Error code → HTTP status

| `code` | HTTP | Meaning |
|--------|------|---------|
| `invalid_input` | 400 | Zod validation failed (message empty, missing required field, etc.) |
| `invalid_cron_expression` | 400 | Cron alias, 6-field, or unparseable |
| `invalid_timezone` | 400 | Not a valid IANA tz |
| `fire_at_too_soon` | 400 | One-shot delay < 30s OR interval `start_at` too far in the past |
| `fire_at_too_far` | 400 | One-shot delay > 90d |
| `unbounded_repeat_requires_explicit_limit` | 400 | Repeat without `max_occurrences`/`until_at`/`allow_unbounded` |
| `too_many_active_schedules` | 429 | Per-agent active cap (50) reached |
| `agent_not_found` | 404 | Owner agent does not exist |
| `agent_home_not_found` | 404 | Owner agent has no agent_home `dm_channel` |
| `schedule_not_found` | 404 | Cancel target id does not exist |
| `not_owner` | 403 | Cancel attempted on another agent's schedule |
| `not_cancellable` | 409 | Cancel attempted on terminal-state row |

## 7. Attachment Tools

Files travel with chat messages. The blob/file storage layer is generic infra;
the attachment system on top of it owns channel boundaries and message
snapshots. Threads inherit their parent channel's attachment scope.

### `upload_file`

```ts
upload_file({
  path: string,            // absolute path on disk
  filename?: string,       // optional display name; defaults to basename(path)
  content_type?: string,   // optional MIME hint; backend sniffs magic bytes
}) -> AttachmentDto
```

Rules:
- `path` must be absolute. The agent should be explicit about which file it is
  uploading; relative paths are rejected.
- The backend resolves the access boundary from the calling conversation —
  agents never specify `channel_id`. Threads upload through the parent channel.
- Returned `id` is single-use input for `send_message.attachment_ids`. The
  attachment is bound to the current channel and cannot be referenced from
  other channels.
- Default size limit is 10 MiB. Filenames are sanitized (path separators and
  control characters stripped, capped at 255 bytes). Content type is detected
  via explicit hint → magic bytes → extension fallback.

### `view_file`

```ts
view_file({ attachment_id: string }) -> AttachmentLocateDto
```

Returns either a local path (zero-copy for `local` storage) or a download URL
(remote storages). Cross-channel ids are rejected with the same shape as
"not found" so existence does not leak across channels.

### Snapshots in messages

Every message references its attachments through immutable snapshots embedded
in `message.metadata.attachments` and surfaced as the typed `attachments`
field on `MessageDto`:

```ts
{ id: string, filename: string, size: number, content_type: string }
```

`send_message` accepts up to 20 `attachment_ids` per call. The backend
validates that every id belongs to the destination channel before inserting
the message; it then formats an `[N attachments — use view_file with each
id below to read them]` suffix into every delivery path (live, inbox,
gated) so receiving agents can react with `view_file` without parsing
metadata.

## 8. Deliberately Absent Tools

The current MCP surface intentionally does not expose:

| Absent tool | Reason |
|-------------|--------|
| `create_session` / `close_session` | Renamed out of the public model; use `create_channel` / `close_thread` |
| `check_messages` | Deferred. Requires a unified delivery ledger so `markDelivered` can dedupe against in-memory `pendingDeliveries`. Until then, agents receive new messages via stdin push and pull historical context with `read_history`. |
| Memory / consensus tools | Agents use their native file tools against `MEMORY.md`, `notes/`, and `.silverhand/CONSENSUS.md` |

## 9. Prompt Contract

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
- Use `upload_file` for binary artifacts the agent generated; pass the returned
  id via `send_message.attachment_ids`. Use `view_file` to read attachments
  from messages received from others.
- Cross-workspace navigation chain (history/search only — never widens posting):
  `list_workspaces` → `list_channels({workspace_id})` → `search_messages`
  (`scope='workspace' workspace_id` or `scope='channel' channel_id`) or
  `read_history({target:{conversation_id}})`. Materialize a remote search hit
  with `read_history({ target: { conversation_id: hit.message_ref.conversation_id },
  around_message_id: hit.message_ref.id, include_content: true })` — using the
  default `target: 'self'` for a remote hit returns 404.

## 10. Maintenance Checklist

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
