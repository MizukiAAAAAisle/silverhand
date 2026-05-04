# Workspace / Channel / Thread Rename Plan

> Status: planning contract. Do not start the implementation until this map is
> agreed, because the rename crosses DB schema, backend services, MCP wording,
> and renderer route/query keys.

## 1. Goal

Current Silverhand naming is misleading:

- current `channel` behaves like a workspace/server: it owns members, agent
  configuration, workspace path, and multiple conversation streams.
- current top-level `session` behaves like a channel: it is the long-lived
  message stream where humans and agents collaborate.
- current child `session` behaves like a thread: it is a scoped sub-discussion.

The target product model is:

```text
workspace -> channel -> thread
```

The rename must align user-visible API/DTO/frontend names with this model. The
only accepted internal abstraction is `conversation`, used for storage and
backend core logic where channels and threads share the same behavior.

## 2. Naming Contract

| Concept | Meaning | Public name | Internal DB/core name |
|---|---|---|---|
| Workspace | Project/server boundary: members, workspace path, settings, task number namespace | `workspace` | `workspace` |
| Channel | Top-level message stream inside a workspace | `channel` | `conversation(kind='channel')` |
| Thread | Child message stream anchored under one channel; no nesting | `thread` | `conversation(kind='thread')` |
| Message stream container | Shared mechanics for channel/thread: messages, members, run state, SSE | never exposed to users | `conversation` |

Rules:

1. Public API paths, DTOs, renderer routes, visible copy, MCP tool descriptions,
   and platform prompts must use `workspace/channel/thread`.
2. DB-adjacent code may use `ConversationRow`, `ConversationRepo`, and
   `conversation_id` for common channel/thread mechanics.
3. Do not expose `session` as a Silverhand domain term after the rename.
   `runtime_session_id` is allowed only when referring to the underlying CLI
   runtime's own resume id.
4. Do not model threads as channels with `parent_channel_id`. That recreates
   the current `session contains session` ambiguity under a new name.

## 3. Target Entities

### Workspace

Replaces the current `channels` table for regular project/server boundaries.

Owns:

- `name`, `description`, `workspace_path`, `workspace_host_id`, archive state
- workspace members, formerly `channel_members`
- channel list
- task number namespace across all channels/threads in the workspace

`workspace_path` is immutable after creation. It may be user-specified or
system-defaulted during workspace creation, but the normal product flow must not
allow editing it later. If the user needs a different root directory, create a
new workspace. Any future repair/migration tool that rewrites workspace or
conversation paths must be explicit admin/developer tooling, not a side effect
of a workspace update.

### Agent Workspace Path

Agents also have an immutable `workspacePath` concept: their L1 directory. This
is a derived getter, not a normal DB column. The current Agent panel already
shows it through `GET /api/agents/:id/workspace`, which is built from
`<silverhandDir>/agents/<agentId>`.

Target rule:

- model it as an immutable `Agent.workspacePath` property.
- derive it from `<silverhandDir>/agents/<agentId>`; do not add an
  `agents.workspace_path` persistence column for this rename.
- because the derivation depends only on the agent id and Silverhand state root,
  it is stable for the lifetime of the agent. Do not let users edit it through
  normal product UI.
- use it as the source for DM channel cwd snapshots.
- keep it distinct from `workspaces.workspace_path`: one belongs to an agent's
  own L1 state, the other belongs to a project/server workspace.

DM placement decision:

Current DM data also uses the old two-layer shape:

```text
channels(kind='dm') -> sessions -> messages
```

The message-bearing rows are the DM sessions, not the outer DM channel row. In
the new model, DMs are conversations, not workspaces. Do not migrate old DM
channel rows into visible workspaces; that would make the workspace list fill
with one-off agent DMs and break the workspace/server mental model.

Target:

- regular workspaces contain `conversation(kind='channel')` rows.
- DM entries are `conversation(kind='dm_channel')` rows created from old DM
  root sessions.
- old DM rows move under one reserved hidden workspace, not one visible
  workspace per DM. This preserves current global-DM behavior while keeping a
  non-null `workspace_id` FK.
- the reserved DM workspace must be excluded from the normal workspace list.
- old DM channel rows become migration evidence for the agent's DM workspace:
  current code already sets old `channels(kind='dm').workspace_path` to the
  derived agent L1 directory (`<silverhandDir>/agents/<agentId>`). Use that
  value as a consistency check, then seed the new DM conversation from
  `Agent.workspacePath`.
- every conversation stores its own working directory snapshot in
  `conversations.workspace_path`.
- regular channel creation copies from `workspaces.workspace_path`.
- Agent exposes a derived `Agent.workspacePath` getter. Current UI already
  presents this concept in the Agent panel by reading the agent L1 directory.
  The value is system-owned, not a global hardcoded constant and not a
  user-facing choice.
- DM channel creation copies `Agent.workspacePath` into
  `conversations.workspace_path`.
- thread creation copies from the parent conversation's `workspace_path`.

Recommended workspace marker:

```sql
workspace_kind TEXT NOT NULL DEFAULT 'regular'
  CHECK (workspace_kind IN ('regular', 'system_dm'))
```

`GET /api/workspaces` should return only `workspace_kind='regular'` unless a
debug/internal endpoint explicitly asks for system workspaces.

```sql
kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel', 'thread'))
```

Threads parent to channel-like conversations: `kind='channel'` or
`kind='dm_channel'`. This preserves the current product behavior where a DM
conversation can also have a Thread, while still rejecting nested threads.

### Conversation

Internal storage table for both channels and threads.

Recommended shape:

```sql
CREATE TABLE conversations (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_path          TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('channel', 'dm_channel', 'thread')),
  parent_conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  status                  TEXT NOT NULL,
  spawned_by_agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  closed_at               INTEGER,
  close_summary           TEXT,
  pinned_at               INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK (
    (kind = 'channel' AND parent_conversation_id IS NULL)
    OR
    (kind = 'dm_channel' AND parent_conversation_id IS NULL)
    OR
    (kind = 'thread' AND parent_conversation_id IS NOT NULL)
  )
);
```

Additional trigger required:

- `kind='thread'` rows may only point to `parent_conversation_id` whose parent
  row has `kind='channel'` or `kind='dm_channel'`.
- nested threads are rejected.
- a thread's `workspace_id` must match its parent channel's `workspace_id`.

Working-directory snapshot:

1. `kind='channel'`: copy `workspaces.workspace_path` into
   `conversations.workspace_path` when the channel is created. The workspace
   path may be user-specified or system-defaulted.
2. `kind='dm_channel'`: copy `Agent.workspacePath` into
   `conversations.workspace_path`. `Agent.workspacePath` is derived from the
   agent id and Silverhand state root; the UI may display it in the Agent panel
   but does not expose it as a DM-channel choice.
3. `kind='thread'`: copy the parent conversation's `workspace_path`.
4. Runtime cwd lookup reads only `conversations.workspace_path`.

This is intentionally a denormalized snapshot. Since `workspaces.workspace_path`
is immutable after creation, existing conversations do not face implicit path
drift. Updating existing conversation working directories should be an explicit
future repair/migration operation, not a side effect of editing workspace
metadata.

Indexes:

```sql
CREATE INDEX idx_conversations_workspace
  ON conversations(workspace_id, kind, updated_at DESC);
CREATE INDEX idx_conversations_parent
  ON conversations(parent_conversation_id, created_at ASC);
CREATE INDEX idx_conversations_status
  ON conversations(status);
```

### Channel DTO

`ChannelDto` wraps `conversations.kind = 'channel'`.

Fields should use channel language:

- `id`
- `workspace_id`
- `workspace_path` (the stored conversation cwd snapshot)
- `title` or `name` (choose one; current session uses `title`)
- `status`
- `pinned_at`
- `closed_at`
- `created_at`
- `updated_at`

Renderer and API should not receive `kind='channel'` unless a generic search or
debug endpoint intentionally returns mixed conversation results.

`DmChannelDto` wraps `conversations.kind = 'dm_channel'`. Keep the public DTO
distinct enough that regular-channel member and provision flows cannot
accidentally run against a DM. It should include `workspace_path` as the
stored cwd snapshot; for DMs this value is copied from the target agent's fixed
`Agent.workspacePath`.

### Thread DTO

`ThreadDto` wraps `conversations.kind = 'thread'`.

Fields:

- `id`
- `workspace_id`
- `channel_id` (mapped from `parent_conversation_id`)
- `workspace_path` (the stored conversation cwd snapshot copied from parent)
- `anchor_message_id` when human-created from a message
- `spawned_by_agent_id` when agent-created
- `closed_at`, `close_summary`
- `created_at`, `updated_at`

The current thread anchor is stored in system-message metadata. The migration
can keep that metadata as the source of truth initially; a later cleanup may
denormalize `anchor_message_id` onto `conversations` if thread listing remains
join-heavy.

## 4. Shared Tables

Because the final DB model uses a single `conversations` table, shared
conversation-scoped tables should use `conversation_id` internally.

Recommended:

```sql
messages(conversation_id REFERENCES conversations(id), seq, ...)
conversation_agents(conversation_id REFERENCES conversations(id), agent_id, ...)
agent_inboxes(conversation_id REFERENCES conversations(id), ...)
conversation_events(conversation_id REFERENCES conversations(id), ...)
conversation_reads(user_id, conversation_id, ...)
saved_messages(conversation_id REFERENCES conversations(id), workspace_id, ...)
```

Why not `channel_id` + `thread_id` here:

- With two physical tables (`channels` and `threads`), two nullable FKs preserve
  SQLite referential integrity.
- With one physical table (`conversations`), both FKs would still point to
  `conversations(id)`, so kind correctness would need triggers anyway.
- `conversation_id` keeps the hot paths simple: messages, SSE, agent runtime
  state, inbox delivery, and read cursors all query one key.

Public DTO mapping still exposes business fields:

- message in a channel: `{ channel_id: id, thread_id: null }`
- message in a thread: `{ channel_id: parent_channel_id, thread_id: id }`

Optional variant if DB readability is prioritized over query simplicity:

```sql
messages(
  channel_id TEXT REFERENCES conversations(id),
  thread_id  TEXT REFERENCES conversations(id),
  CHECK ((channel_id IS NULL) <> (thread_id IS NULL))
)
```

This variant must add triggers to assert `channel_id` points at
`kind='channel'` and `thread_id` points at `kind='thread'`. Without triggers,
the column names are only documentation and can drift.

## 5. Task Model

Current task numbering is per current `channel`, which becomes per workspace.

Target:

- a task is still a message with task metadata.
- numbering namespace becomes `task_workspace_id`, not `task_channel_id`.
- task ownership scope is the source conversation:
  - agent in a channel can operate on tasks in that channel.
  - agent in a thread can operate on tasks in that thread.
  - task board can aggregate all tasks in the workspace.

DTO rename:

| Current | Target |
|---|---|
| `task_channel_id` | `task_workspace_id` |
| `TaskSessionRef` | `TaskChannelRef` or `TaskThreadRef` depending on source |
| `TaskSummaryDto.session` | `TaskSummaryDto.source` with `{ type: 'channel' | 'thread', id, title }` |
| `channel_id` filter | `workspace_id` filter plus optional `channel_id` / `thread_id` filters |

MCP prompt language:

- "The workspace has a task board that aggregates tasks across every channel
  and thread."
- "You can only claim/update tasks in your current channel/thread."

## 6. API Rename Map

| Current API | Target API |
|---|---|
| `GET /api/channels` | `GET /api/workspaces` |
| `POST /api/channels` | `POST /api/workspaces` |
| `GET /api/channels/:id` | `GET /api/workspaces/:id` |
| `PATCH /api/channels/:id` | `PATCH /api/workspaces/:id` for mutable metadata only; must not accept `workspace_path` |
| `DELETE /api/channels/:id` | `DELETE /api/workspaces/:id` |
| `GET /api/channels/:id/members` | `GET /api/workspaces/:id/members` |
| `POST /api/channels/:id/members` | `POST /api/workspaces/:id/members` |
| `GET /api/channels/:id/sessions` | `GET /api/workspaces/:id/channels` |
| `POST /api/channels/:id/sessions` | `POST /api/workspaces/:id/channels` |
| `GET /api/sessions/:id/messages` | `GET /api/channels/:id/messages` or `GET /api/threads/:id/messages` |
| `POST /api/sessions/:id/messages` | `POST /api/channels/:id/messages` or `POST /api/threads/:id/messages` |
| `GET /api/sessions/:id/agents` | `GET /api/channels/:id/agents` or `GET /api/threads/:id/agents` |
| `GET /api/sessions/:id/agent-run-states` | `GET /api/channels/:id/agent-run-states` or `GET /api/threads/:id/agent-run-states` |
| `GET /api/sessions/:id/events` | `GET /api/channels/:id/events` or `GET /api/threads/:id/events` |
| `GET /api/sessions/:id/stream` | `GET /api/channels/:id/stream` or `GET /api/threads/:id/stream` |
| `POST /api/sessions/:id/close` | `POST /api/threads/:id/close` for threads; channel close/archive is a separate policy |
| `POST /api/sessions/:id/pin` | `POST /api/channels/:id/pin` |
| `GET /api/sessions/:id/threads` | `GET /api/channels/:id/threads` |
| `POST /api/messages/:id/thread` | keep path, return `{ thread }`; message id determines parent channel |

Avoid ambiguous routes such as `/api/conversations/:id/messages` in public API.
They are acceptable only for internal backend helpers or debug endpoints.

Implementation rule: every public channel route must verify the target
conversation has `kind='channel'`; every thread route must verify
`kind='thread'`; every DM route must verify the chosen DM representation. Passing
a thread id to `/api/channels/:id/...` or a channel id to `/api/threads/:id/...`
must return 404 or 400, not silently operate on the wrong conversation.

## 7. DTO / Type Rename Map

| Current | Target |
|---|---|
| `ChannelKind` | `WorkspaceKind` if kept; DM likely moves to `ChannelKind` |
| `ChannelDto` | `WorkspaceDto` |
| `CreateChannelInput` | `CreateWorkspaceInput` |
| `UpdateChannelInput` | `UpdateWorkspaceInput` |
| `ChannelMemberDto` | `WorkspaceMemberDto` |
| `SessionDto` | `ChannelDto` |
| `CreateSessionInput` | `CreateChannelInput` |
| `CloseSessionInput` | `CloseThreadInput` or `CloseChannelInput` if channel close remains |
| `SessionAgentDto` | `ConversationAgentDto` internally; `ChannelAgentDto` / `ThreadAgentDto` in public DTOs |
| `SessionMessagesDto` | `ChannelMessagesDto` / `ThreadMessagesDto` |
| `SessionEventKind` | `ConversationEventKind` |
| `AgentRunState.sessionId` | `conversationId` internally; public payload uses `channelId` or `threadId` |
| `MessageDto.session_id` | `conversation_id` internally; public DTO uses `channel_id` and nullable `thread_id` |
| `SessionReadRow` | `ConversationReadRow` |
| `MessageUnreadBySessionDto` | `MessageUnreadByChannelDto` plus thread counts if shown |
| old DM `ChannelDto` + root `SessionDto` | `DmChannelDto` backed by `conversation(kind='dm_channel')` |

## 8. Backend File Rename Map

| Current file/module | Target |
|---|---|
| `repos/channel-repo.ts` | `repos/workspace-repo.ts` |
| `repos/session-repo.ts` | `repos/conversation-repo.ts` |
| `repos/session-read-repo.ts` | `repos/conversation-read-repo.ts` |
| `session-manager.ts` | `conversation-manager.ts` |
| `event-bus.ts` (`SessionEventBus`) | `ConversationEventBus` |
| `tasks.ts` channel/session wording | workspace/conversation wording; public summaries map to channel/thread |
| `provision.ts` channel provisioning | workspace provisioning plus default channel creation |
| `mention-cc.ts` DM channel creation | revisit after DM placement decision |

Backend route handlers may still share generic helpers:

```ts
type ConversationScope =
  | { type: 'channel'; channelId: string }
  | { type: 'thread'; threadId: string; channelId: string };
```

Do not let this helper type leak into public DTO names unless an endpoint
explicitly returns mixed channel/thread results.

## 9. Renderer Rename Map

| Current | Target |
|---|---|
| `features/channels` | `features/workspaces` |
| `features/sessions` | `features/channels` |
| `features/thread` | `features/threads` |
| `useSessionStream` | `useConversationStream` internally, wrapped by `useChannelStream` / `useThreadStream` |
| `SessionsSidebar` | `ChannelsSidebar` |
| current channel sidebar | `WorkspacesSidebar` |
| route `/c/:channelId/s/:sessionId` | `/w/:workspaceId/c/:channelId` |
| route `/c/:channelId/s/:sessionId/t/:childId` | `/w/:workspaceId/c/:channelId/t/:threadId` |
| React Query key `['channels']` | `['workspaces']` |
| React Query key `['channels', id, 'sessions']` | `['workspaces', id, 'channels']` |
| React Query key `['sessions', id, ...]` | `['channels', id, ...]` or `['threads', id, ...]` |
| DM rows currently loaded from channels/sessions | DM conversations loaded separately and rendered in the DM group |

The visible layout should become:

```text
Workspaces sidebar -> Channels sidebar -> Channel message view -> Thread split
```

## 10. MCP / Platform Prompt Rename Map

| Current tool / wording | Target |
|---|---|
| current session | current channel/thread |
| current channel | current workspace |
| `create_thread` returning `child_session_id` | `create_thread` returning `thread_id` |
| `create_session` | `create_channel` (only when user explicitly asks for a separate channel) |
| `close_session` | `close_thread`; closing user-opened thread still requires explicit user confirmation |
| `list_tasks` channel board | workspace task board |
| task belongs to another session | task belongs to another channel/thread |

The MCP namespace can remain `mcp__chat__`; only tool schemas, field names, and
descriptions need the domain rename.

Implementation decision: no MCP compatibility aliases are kept. The tool
surface should expose only `create_channel`, `close_thread`, and `thread_id`
once this rename lands.

## 11. Migration Strategy

This app is not launched, so external API compatibility is not required.
However the current development DB must be preserved.

Implementation approach:

1. Add one migration that creates the new schema, copies rows, drops old tables,
   and preserves existing ids where possible.
2. Copy old regular `channels` (`kind != 'dm'`) to `workspaces` with
   `workspace_kind='regular'`.
3. Create one reserved hidden workspace with `workspace_kind='system_dm'`.
4. Copy old `channel_members` for regular channels to `workspace_members`.
5. Copy old root `sessions` (`parent_session_id IS NULL`) to
   `conversations(kind='channel')`, preserving `id`, and copy
   `workspace_path` from the old parent `channels.workspace_path`.
6. Copy old child `sessions` (`parent_session_id IS NOT NULL`) to
   `conversations(kind='thread')`, preserving `id` and mapping
   `parent_conversation_id = old.parent_session_id`. Copy `workspace_path` from
   the parent conversation.
7. Copy old DM root sessions into `conversations(kind='dm_channel')` under the
   reserved hidden DM workspace, preserving session ids where possible because
   messages/inboxes/events currently point at those ids. Use the old outer DM
   channel row as migration evidence (`dm_agent_id`, `workspace_path`, members).
   Verify old `channels.workspace_path` matches derived `Agent.workspacePath`
   for that `dm_agent_id`, then copy derived `Agent.workspacePath` to the new
   `conversations.workspace_path`. Do not create one visible workspace per DM.
8. Copy `session_agents` to the new conversation agent table.
9. Rename message, inbox, event, read, saved-message references from
   `session_id` to `conversation_id`.
10. Rename task number namespace from old `task_channel_id` to
   `task_workspace_id`.
11. Update notifications/source pointers from old channel/session language to
   workspace/conversation language, then DTO-map them back to channel/thread.
12. Run consistency checks before committing the migration transaction.

Suggested consistency checks:

```sql
-- every thread has a channel parent
SELECT t.id
FROM conversations t
LEFT JOIN conversations p ON p.id = t.parent_conversation_id
WHERE t.kind = 'thread' AND (p.id IS NULL OR p.kind != 'channel');

-- every message points at an existing conversation
SELECT m.id
FROM messages m
LEFT JOIN conversations c ON c.id = m.conversation_id
WHERE c.id IS NULL;

-- task numbers are unique inside a workspace
SELECT task_workspace_id, task_number, COUNT(*)
FROM messages
WHERE task_number IS NOT NULL
GROUP BY task_workspace_id, task_number
HAVING COUNT(*) > 1;
```

## 12. Safety For The Active Dev DB

The current app is being used for development conversations. Do not run this
migration casually against the live DB while the old backend/frontend is still
running.

Safe workflow:

1. Implement the migration and code against a copied DB first.
2. Verify copied DB migration with backend tests and a smoke start.
3. Before switching the real app, stop the running backend/app.
4. Copy the real DB file to a timestamped backup.
5. Start the new code once; let migrations run.
6. If startup fails, stop immediately and restore the backup before reopening
   the old code.

Expected user impact at switch time:

- one planned app/backend restart
- active SSE streams disconnect and reconnect
- no intentional message/task/history deletion
- old code will not work after the migration because table and column names
  changed

## 13. Implementation Order

Recommended split:

1. Freeze this document.
2. DB + shared schema:
   - add `workspaces`, `workspace_members`, `conversations`
   - migrate/copy data
   - rename shared row types and DTOs
3. Backend core:
   - repositories
   - routes
   - task board
   - event bus and agent run state
   - platform prompt and MCP wording
4. Renderer:
   - route model
   - query keys
   - sidebar/components
   - thread split
5. Docs:
   - `core-design.md`
   - `app-layout.md`
   - `tasks-design.md`
   - incident docs only if they describe current behavior
6. Verification:
   - migration smoke test on copied DB
   - backend route/repo tests
   - root `pnpm typecheck`
   - focused renderer manual pass after restart

Do not merge partial code that can start the backend with the new schema but an
old renderer or old chat-bridge wording. The transition should be atomic from
the user's perspective.
