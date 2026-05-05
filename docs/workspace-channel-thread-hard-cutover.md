# Workspace / Channel / Thread Hard Cutover Plan

> Status: follow-up plan after the v11 shadow migration. This document tracks
> what is still required before the repository is fully aligned from DB schema
> through backend runtime, shared types, frontend files, and variable names.

## 1. Why This Exists

The workspace/channel/thread rename has been partially shipped in a safe form:

- product language, MCP tool names, docs, and much of the renderer copy now use
  `workspace -> channel -> thread`;
- v11 added shadow tables and columns for `workspaces` and `conversations`;
- the release app can run with existing data preserved.

However, the runtime is not fully cut over yet. The current code still uses the
legacy `channels -> sessions -> child sessions` data path in several canonical
places. The new tables are currently an additive semantic layer, not the single
source of truth.

The user's target is stricter:

```text
DB schema -> backend repos/routes -> shared DTOs/paths -> frontend hooks/files/vars
must all line up with the same model.
```

This document is the checklist for that hard cutover.

## 2. Target End State

### Naming Contract

| Product concept | Public/API/UI name | Internal storage/core name |
|---|---|---|
| Project/server boundary | `workspace` | `workspace` |
| Top-level message stream | `channel` | `conversation(kind='channel')` |
| DM message stream | `dm_channel` / DM | `conversation(kind='dm_channel')` |
| Child discussion | `thread` | `conversation(kind='thread')` |
| Shared runtime container | not user-visible | `conversation` |

Allowed exceptions:

- `cli_session_id` remains because it is the underlying CLI runtime resume id,
  not a Silverhand product concept.
- Driver protocol event names such as `session_init` may remain if they are
  emitted by the external runtime or driver contract.
- Historical incident/progress docs may keep old terms when describing old
  bugs. Current architecture docs and source code should not.

### Canonical DB

The canonical runtime tables should be:

- `workspaces`
- `workspace_members`
- `conversations`
- `conversation_agents`
- `conversation_reads`
- `conversation_inboxes`
- `conversation_events`
- `messages.conversation_id`
- `messages.task_workspace_id`

The legacy tables/columns/triggers should be gone from the current runtime
schema:

- `channels`
- `channel_members`
- `sessions`
- `session_agents`
- `session_reads`
- `agent_inboxes.session_id`
- `session_events`
- `messages.session_id`
- `messages.task_channel_id`
- v11 legacy-to-shadow triggers

### Canonical APIs

Public routes should be only:

- `/api/workspaces`
- `/api/workspaces/:workspaceId/channels`
- `/api/workspaces/system/dm-channels`
- `/api/channels/:channelId/...`
- `/api/threads/:threadId/...`

Legacy `/api/sessions/*` and old workspace-as-channel routes must be removed
or left only as explicit, short-lived developer diagnostics. The user has said
old runtime compatibility is not required.

Internal MCP routes should be conversation-scoped, not session-scoped:

```text
/internal/conversations/:conversationId/agents/:agentId/...
```

The external MCP tool surface is already renamed; this cutover should remove
the remaining internal `session` naming.

## 3. Current State Audit

As of 2026-05-05, the app is functional, but the source tree still has these
legacy anchors.

### DB / Shared Schema

`packages/shared/src/db/schema.ts` still exports both old and new row shapes:

- old: `ChannelRow`, `ChannelMemberRow`, `SessionRow`,
  `SessionAgentRow`, `SessionReadRow`;
- new: `WorkspaceRow`, `WorkspaceMemberRow`, `ConversationRow`,
  `ConversationAgentRow`, `ConversationReadRow`;
- mixed message/task fields:
  - old `MessageRow.session_id`;
  - new `MessageRow.conversation_id`;
  - old `task_channel_id`;
  - new `task_workspace_id`.

v11 created the new tables and shadow columns, then mirrored legacy writes into
them. This was correct for a low-risk release, but it means the old tables still
drive runtime behavior.

### Shared API / DTOs

`packages/shared/src/api/paths.ts` still exposes both new and old route keys:

- new `workspace*`, `conversationChannel*`, and `thread*` paths;
- old `channels`, `channelSessions`, `session*`, and internal
  `/internal/sessions/:sid/...` paths.

`packages/shared/src/api/dto.ts` still contains legacy product DTOs:

- `ChannelDto` still means old workspace/channel in some call sites;
- `SessionDto`, `SessionAgentDto`, `SessionMessagesDto`;
- `CreateSessionInput`, `CloseSessionInput`;
- `MessageDto.session_id`;
- task/search/notification DTOs with `channel_id`/`session_id` semantics.

The final model should make `ChannelDto` mean a channel conversation, and
`WorkspaceDto` mean the project/server boundary. There should be no old
workspace-as-channel DTO left.

### Backend Runtime

The backend has additive `WorkspaceRepo` and `ConversationRepo`, but the main
runtime still depends on legacy repos and classes:

- `ChannelRepo`
- `MembershipRepo`
- `SessionRepo`
- `SessionReadRepo`
- `SessionEventBus`
- `SessionManager`
- `MessageRepo` writes by `session_id`
- `InboxRepo` writes by `session_id`
- task/search/saved/notification code joins through `sessions` and `channels`

`packages/backend/src/routes.ts` contains additive workspace/conversation
routes, but the active message, SSE, agent-run-state, task, and internal MCP
routes are still largely `/api/sessions/*` or `/internal/sessions/*`.

### Frontend

The renderer has renamed top-level files in places, but runtime hooks are still
legacy-backed:

- `features/workspaces/hooks.ts` calls old `/api/channels` and returns
  `ChannelDto[]`;
- `features/channels/hooks.ts` calls `/api/sessions/:id/...` and uses
  `SessionDto`, `SessionAgentDto`, `SessionMessagesDto`;
- `features/sessions/hooks.ts` still exists as a duplicate legacy module;
- `features/thread/hooks.ts` and `features/threads/hooks.ts` both exist;
- `EventsApp.tsx` still fetches `/api/channels` and `/api/sessions`;
- task/search/saved/notification components still use `session_id` and old
  channel/session filters.

The final renderer should not need a mental translation layer where
`workspace` variables call old `channel` endpoints.

## 4. Work Breakdown

### A. DB v12 Hard Cutover Migration

Create a new migration that promotes the v11 shadow schema to canonical.

Required steps:

1. Stop accepting writes during migration by requiring the app/backend to be
   stopped before the release DB is opened by the new build.
2. Run consistency checks before destructive changes.
3. Rebuild affected SQLite tables so canonical columns become non-null and
   legacy columns disappear. Use table-copy migrations rather than depending on
   broad `ALTER TABLE DROP COLUMN` behavior.
4. Drop legacy triggers from v11.
5. Drop legacy tables after all downstream code has been switched.
6. Run `PRAGMA foreign_key_check`.

Minimum consistency checks:

```sql
-- Every legacy session must have one conversation row with the same id.
SELECT COUNT(*) FROM sessions
WHERE id NOT IN (SELECT id FROM conversations);

-- Every message must have a canonical conversation id before session_id drops.
SELECT COUNT(*) FROM messages
WHERE conversation_id IS NULL OR conversation_id != session_id;

-- Every old task namespace must map to a workspace namespace.
SELECT COUNT(*) FROM messages
WHERE task_number IS NOT NULL AND task_workspace_id IS NULL;

-- No nested threads.
SELECT COUNT(*)
FROM conversations child
JOIN conversations parent ON parent.id = child.parent_conversation_id
WHERE child.kind = 'thread' AND parent.kind = 'thread';

-- Thread and parent must stay in the same workspace.
SELECT COUNT(*)
FROM conversations child
JOIN conversations parent ON parent.id = child.parent_conversation_id
WHERE child.kind = 'thread'
  AND child.workspace_id != parent.workspace_id;
```

Rows requiring attention should fail the migration with a clear error instead
of being silently repaired.

### B. Shared Types and API Paths

Replace legacy shared exports with canonical names.

Required changes:

- remove old `ChannelRow`/`SessionRow` exports, or keep them only in migration
  test helpers that are clearly marked legacy;
- make `MessageRow.conversation_id` non-null and remove `session_id`;
- remove `task_channel_id` in favor of `task_workspace_id`;
- rename status types:
  - `SessionStatus` -> `ConversationStatus`;
  - `SessionAgentStatus` -> `ConversationAgentStatus`;
  - `SessionEventKind` -> `ConversationEventKind`;
- remove `SessionDto`, `SessionAgentDto`, `SessionMessagesDto`;
- define public wrappers:
  - `WorkspaceDto`;
  - `ChannelDto` for `conversation(kind='channel')`;
  - `DmChannelDto` for `conversation(kind='dm_channel')`;
  - `ThreadDto` for `conversation(kind='thread')`;
  - `ConversationAgentDto` for shared channel/thread agent state;
- update `MessageDto` away from `session_id`.
  Recommended shape:

```ts
type MessageDto = {
  id: string;
  conversation_id: string;
  channel_id: string | null;
  thread_id: string | null;
  // existing message fields...
};
```

This keeps common code able to use `conversation_id` while UI navigation can
choose channel or thread routes without reverse lookups.

Path cleanup:

- remove `apiPaths.session*`;
- remove legacy `apiPaths.channels` meanings;
- add canonical `apiPaths.channel*` and `apiPaths.thread*` for message, stream,
  agents, run states, read cursor, pin/close/start/stop as applicable;
- move internal MCP paths to `/internal/conversations/:conversationId/...`.

### C. Backend Repos and Runtime

Make `conversations` the only runtime source of truth.

Repo cutover:

- expand `ConversationRepo` to cover all `SessionRepo` behavior:
  - `get`, `close`, `delete`, `pin`, `unpin`;
  - `listThreadsForChannel`, `findOpenThreadChild`,
    `listOpenThreadsForParent`;
  - active-child counting and spawn limits;
  - agent lifecycle rows and `cli_session_id`;
  - runtime status updates;
  - live-agent listing.
- replace `SessionReadRepo` with `ConversationReadRepo`;
- replace `InboxRepo`'s `session_id` access with `conversation_id`;
- replace `MessageRepo` sequence/window/task operations with
  `conversation_id`;
- replace `SessionEventBus` with `ConversationEventBus`;
- update saved messages, notifications, search, attachments, and tasks to join
  through `conversations`/`workspaces`.

Manager cutover:

- rename `packages/backend/src/session-manager.ts` to
  `conversation-manager.ts`;
- rename class `SessionManager` to `ConversationManager`;
- rename product-level variables from `sessionId` to `conversationId`,
  `channelId`, or `threadId` according to the route context;
- keep `cliSessionId` only for the runtime resume id.

Provisioning cutover:

- `provisionWorkspace` creates `workspaces` and `conversation(kind='channel')`
  rows directly;
- `provisionDmWorkspace` or its replacement creates
  `conversation(kind='dm_channel')` with `workspace_path` copied from
  `Agent.workspacePath`;
- `joinWorkspace` and `leaveWorkspace` operate on `workspace_members` and
  `conversation_agents`.

### D. Backend Routes

Switch routes to the canonical API surface and delete legacy runtime aliases.

Required route behavior:

- `/api/workspaces/:id/channels` returns only channel conversations for that
  workspace.
- `/api/channels/:id/*` verifies `conversations.kind = 'channel'` or
  `dm_channel` where DM is intentionally supported.
- `/api/threads/:id/*` verifies `conversations.kind = 'thread'`.
- message/thread creation returns `thread_id`, not `child_session_id`.
- read cursor endpoints use conversation semantics:
  - channel message read;
  - thread message read;
  - workspace unread summary.
- agent start/stop/run-state/SSE routes exist for both channel-like
  conversations and threads.
- task list/mutation routes report `workspace_id`, `conversation_id`,
  `channel_id`, and `thread_id` consistently.

Delete or fail fast on:

- `/api/sessions/*`;
- `/api/channels/:workspaceId/sessions`;
- `/internal/sessions/:sessionId/*`.

### E. MCP / Chat Bridge / Platform Prompt

The external MCP tools are already mostly aligned. The remaining work is
internal plumbing and documentation consistency.

Required changes:

- chat-bridge client uses `conversation_id`/`thread_id` payload names
  internally;
- internal endpoints move to `/internal/conversations/:conversationId/...`;
- task tool implementation resolves task scope through `conversation_id` and
  `workspace_id`;
- platform prompt keeps user-facing `workspace/channel/thread` terms;
- `docs/mcp-system.md` is updated in the same change if any tool schema,
  return value, internal route, or behavior changes.

### F. Frontend Runtime Cutover

Remove the renderer's legacy API/type layer.

Required changes:

- `features/workspaces/hooks.ts` calls `/api/workspaces` and returns
  `WorkspaceDto[]`;
- `features/channels/hooks.ts` calls `/api/channels/:id/*` and uses
  `ChannelDto` / `ConversationAgentDto`;
- `features/threads/hooks.ts` calls `/api/threads/:id/*` and uses `ThreadDto`;
- delete `features/sessions/` and `features/thread/` once duplicates are gone;
- replace all `SessionDto`, `session_id`, `parent_session_id`,
  `child_session_id` variables that refer to product entities;
- keep route variables as:
  - `workspaceId`;
  - `channelId`;
  - `threadId`;
- update query keys so they match canonical scopes:
  - `['workspaces']`;
  - `['workspace', workspaceId, 'channels']`;
  - `['channel', channelId, ...]`;
  - `['thread', threadId, ...]`;
- update Events window, Search panel, Saved list, Notifications, Tasks drawer,
  and mention/channel ref components.

Recommended hook names:

- `useChannelMessages(channelId)`;
- `useThreadMessages(threadId)`;
- `useConversationStream(conversationId)` for shared SSE plumbing, with
  route-specific wrappers if the caller needs kind guarantees.

### G. Tests

Add or update tests at each layer.

DB/migration:

- v11-live fixture migrates to v12 with counts preserved;
- old tables/triggers are absent after migration;
- `PRAGMA foreign_key_check` is clean;
- DM `workspace_path` matches derived `Agent.workspacePath`;
- thread parent kind/workspace constraints reject invalid rows.

Backend:

- route kind guards for channel-vs-thread ids;
- message windowing by `conversation_id`;
- inbox delivery by `conversation_id`;
- agent run-state snapshot/SSE by `conversation_id`;
- tasks numbered by `workspace_id`;
- saved/search/notification links navigate to channel/thread correctly.

Frontend/typecheck:

- root `pnpm typecheck` must pass with no legacy DTO imports;
- events window can cold-open with active channel/thread;
- create channel, create thread, close thread, task claim, saved-message jump,
  search result jump, and notification jump all use canonical route helpers.

Release smoke:

- run the migration against a copied DB first;
- open the new release app;
- verify existing workspaces/channels/threads/messages/tasks/saved items appear;
- send one message in a workspace channel, one in a thread, and one in a DM.

### H. Docs

Update current architecture docs after the hard cutover:

- `docs/core-design.md`;
- `docs/app-layout.md`;
- `docs/tasks-design.md`;
- `docs/testing.md`;
- `docs/mcp-system.md` if MCP internals changed;
- `CLAUDE.md`;
- `docs/progress.md`.

Historical incident docs can keep old names where they describe old behavior.

## 5. Suggested Implementation Sequence

Because the user is actively using the app, do not run the destructive v12
cutover on the live DB until the new build is ready.

Recommended sequence:

1. **Branch/prep audit**
   - keep the current release working;
   - write tests for v12 consistency checks using copied fixtures;
   - do not start `pnpm dev` against the live DB during destructive migration
     development.
2. **Shared + backend cutover**
   - switch repos/routes/manager to `workspaces`/`conversations`;
   - keep tests green against temporary DBs;
   - remove old API exports rather than keeping compatibility aliases.
3. **Frontend cutover**
   - update hooks/components/query keys to canonical APIs;
   - delete duplicate legacy modules.
4. **DB cleanup migration**
   - drop old tables/triggers/columns after runtime reads from new schema;
   - verify with copied DB;
   - package release.
5. **User cutover**
   - quit the running release app;
   - back up the real DB;
   - launch the new release once so v12 runs;
   - verify history and live messaging.

## 6. Safety Checklist

Before running v12 on the real DB:

```bash
cp ~/.silverhand/silverhand.db ~/.silverhand/silverhand.db.pre-v12.bak
```

Also confirm which DB the release build actually uses. Do not assume dev and
release point at the same file.

Validation commands:

```bash
pnpm typecheck
./scripts/test.sh
```

DB verification after migration:

```sql
PRAGMA foreign_key_check;
SELECT COUNT(*) FROM workspaces;
SELECT COUNT(*) FROM conversations;
SELECT COUNT(*) FROM messages;
SELECT COUNT(*) FROM messages WHERE conversation_id IS NULL;
```

Keep the backup until the new release has been used successfully for normal
workspace channel, thread, DM, task, saved-message, notification, and search
flows.

## 7. Definition of Done

Source search should have no product-level hits for legacy names:

```bash
rg "/api/sessions|/internal/sessions|SessionRepo|SessionManager|SessionDto|SessionAgentDto|SessionMessagesDto|session-repo|channel-repo|session_reads|session_agents|channel_members|parent_session_id|child_session_id|task_channel_id|MessageDto\\.session_id" packages apps docs --glob '!docs/incident-*' --glob '!docs/progress.md'
```

Expected allowed hits after the cutover:

- `cli_session_id`;
- driver event names such as `session_init`;
- historical docs that explicitly describe pre-cutover behavior;
- migration files/tests that intentionally mention old tables as input
  fixtures.

DB checks:

- old runtime tables/triggers are absent;
- canonical tables contain all migrated rows;
- `PRAGMA foreign_key_check` returns no rows;
- every `messages.conversation_id` points to `conversations(id)`;
- every task row has `task_workspace_id`.

Runtime checks:

- new messages write only `conversation_id`;
- agent inbox/event/run-state rows write only `conversation_id`;
- task numbers are scoped by workspace;
- frontend never calls `/api/sessions/*`;
- MCP internal routes never call `/internal/sessions/*`;
- root `pnpm typecheck` and full backend tests pass.

## 8. Open Decisions

These should be decided before implementation starts:

1. Should public message DTOs expose both `conversation_id` and navigation
   helpers (`channel_id` / `thread_id`), or only route-specific ids?
   Recommendation: expose `conversation_id` plus nullable navigation ids.
2. Should DM channels use the same `/api/channels/:id/*` route as regular
   channels? Recommendation: yes, but route guards should explicitly accept
   `kind IN ('channel', 'dm_channel')` where intended.
3. Legacy HTTP aliases are decided out of scope. Do not keep `/api/sessions/*`
   or `/internal/sessions/*` compatibility aliases in the hard cutover; the
   user has said old runtime compatibility is not needed.
4. Should old planning docs be fully rewritten? Recommendation: update current
   architecture docs, but leave incident history intact.
