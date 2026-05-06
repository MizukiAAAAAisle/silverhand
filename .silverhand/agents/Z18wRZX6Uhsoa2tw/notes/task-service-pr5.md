# PR-5 TaskService — interface, contract, test matrix (round 2)

Owner: @Alice draft → @Cindy review → @Cindy implements.
Round-2 changes incorporate Cindy's 4 blockers from #119 review:
action-oriented split (`claimTask` / `unclaimTask`), per-actor+op
`by.messageId` resolution, binding `task.conversation_id ===
actor.conversationId` for agent ops, `taskWorkspaceId` rename.

Replaces: `tasks.ts` exports `createTasksByAgent`, `claimTasksByAgent`,
`unclaimTaskByAgent`, `updateTaskStatusByAgent`, `humanClaim`,
`humanUnclaim`, `humanUpdateStatus`. The actor split (`*ByAgent` vs
`human*`) is the last "caller-kind drift" surface in the audit. After
PR-5, every task-mutation goes through one service method per op,
parameterized by `actor`.

## File layout
- New: `packages/backend/src/services/task-service.ts`
- Wired in `BackendContext` AFTER `ctx.conversationManager` is assigned
  (same constraint as ChannelService / ConversationMessageService /
  ThreadService). `buildTestApp` mirrors construction order.
- Constructor opts: `db: Db`, `conversations: ConversationRepo`,
  `messages: MessageRepo`, `agents: AgentRepo`,
  `conversationManager: ConversationManager`,
  `events: ScopeEventBus`, `logger: BackendLogger`.
- The existing `tasks.ts` is fully replaced. `listTasks` and
  `getTaskByMessageId` move into TaskService (single home for task
  surface). `tasks.ts` is deleted.

## Public surface

```ts
export type TaskActor =
  | { kind: 'user'; userId: string | null }
  | { kind: 'agent'; agentId: string; conversationId: string };

// Refs are narrowed per actor — user input cannot reach taskNumber form
// (would require an unexposed workspace param), so the type system
// rejects it instead of the service returning an "unsupported_ref" code.
type UserActor = { kind: 'user'; userId: string | null };
type AgentActor = { kind: 'agent'; agentId: string; conversationId: string };
type AgentTaskRef = { messageId: string } | { taskNumber: number };
type UserTaskRef = { messageId: string };

export interface CreateTasksInput {
  conversationId: string;
  actor: TaskActor;            // v1: agent-only routes; user accepted for forward-compat
  tasks: { title: string; body?: string }[];
}
export interface CreateTasksResultEntry {
  message_id: string;
  task_number: number;
  title: string;
}
export type CreateTasksResult =
  | { tasks: CreateTasksResultEntry[] }
  | { error: TaskOpError; code:
      'conversation_not_found' | 'conversation_closed' | 'not_conversation_member' };

export type ClaimTaskInput =
  | {
      actor: UserActor;
      by: UserTaskRef;
      assignee?: { agentId: string };
    }
  | {
      actor: AgentActor;
      by: AgentTaskRef;
      assignee?: { agentId: string };  // when present, MUST equal actor.agentId
    };

export type UnclaimTaskInput =
  | { actor: UserActor; by: UserTaskRef }
  | { actor: AgentActor; by: AgentTaskRef };

export type UpdateStatusInput =
  | { actor: UserActor; by: UserTaskRef; status: TaskStatus }
  | { actor: AgentActor; by: AgentTaskRef; status: TaskStatus };

export interface ListTasksFilters {
  actor: TaskActor;
  // user actor: workspaceId honored as filter (optional → global).
  // agent actor: workspaceId IGNORED; service derives physical workspace
  //   from `conversations.get(actor.conversationId).workspace_id`.
  workspaceId?: string;
  // Optional further narrowing. user honors directly; agent honors
  // ONLY after the derived-workspace scope check (route never enforces).
  conversationId?: string;
  status?: TaskStatus[];
}

export class TaskService {
  list(filters: ListTasksFilters): TaskSummaryDto[];
  getByMessageId(messageId: string, actor: TaskActor): TaskSummaryDto | null;
  createTasks(input: CreateTasksInput): Promise<CreateTasksResult>;
  /** Returns a richer per-target entry so the agent bulk route can
   *  aggregate ClaimResultEntry[]. Promote-success path includes the
   *  freshly allocated `task_number`. Human route only reads
   *  success / reason / code. */
  claimTask(input: ClaimTaskInput): Promise<ClaimResultEntry>;
  unclaimTask(input: UnclaimTaskInput): Promise<TaskMutationResult>;
  updateStatus(input: UpdateStatusInput): Promise<TaskMutationResult>;
}

// ClaimResultEntry shape (extended from today's; `code` typed):
// type ClaimResultEntry =
//   | { success: true; message_id: string; task_number: number; title: string;
//       status: TaskStatus; assignee: { agent_id: string; name: string } | null }
//   | { success: false; reason: string; code: ClaimErrorCode;
//       message_id?: string; task_number?: number };
// type TaskMutationResult =
//   | { success: true }
//   | { success: false; reason: string; code: TaskMutationErrorCode };
```

The route layer collapses:
- Agent `claim` (bulk: `task_numbers[] + message_ids[]`) → route iterates,
  calls `claimTask` per ref, aggregates `ClaimResultEntry[]`. Bulk
  semantics live in the agent route, not the service. Service is
  single-target. Route passes `{by, actor}` only — no number scope.
- Agent `unclaim` → `unclaimTask({by:{taskNumber}, actor})`.
- Agent `update_status` → `updateStatus({by:{taskNumber}, status, actor})`.
- Human `claim` (`POST /api/tasks/:messageId/claim`, optional
  `agent_id`) → `claimTask({by:{messageId}, assignee: agent_id ? {agentId} : undefined, actor:{user}})`.
- Human `unclaim` → `unclaimTask({by:{messageId}, actor:{user}})`.
- Human `update status` → `updateStatus({by:{messageId}, status, actor:{user}})`.

## Why action-oriented (not single `setAssignee`)
Today's behaviour (verified in `tasks.ts` 745-849):
- `humanClaim(messageId, agentId?)`: SQL `assignee=?, status = CASE WHEN
  todo THEN in_progress ELSE current` — preserves status if already
  in_progress/in_review.
- `humanUnclaim(messageId)`: SQL `assignee=NULL, status='todo'` — forces
  status to todo regardless of current.
- `unclaimTaskByAgent`: same as humanUnclaim's SQL.

Same `assignee=null` outcome with **different `task_status` semantics**.
A single `setAssignee({assignee:null})` cannot express both. Splitting
into `claimTask` (preserves/lifts status) vs `unclaimTask` (forces
status='todo') matches both today's behaviour and the agent-facing tool
verbs (`claim_tasks` / `unclaim_task`).

## Policy table (locked inside the service file)

`POLICIES[actor.kind]` const map per op (rather than scattered
`if origin==='user'` branches), same shape as PR-2:

| Behaviour | user | agent |
|---|---|---|
| `claimTask: requireSelfAssignment` | false | true — `assignee` undefined or `assignee.agentId === actor.agentId` |
| `claimTask: requireUnclaimedTarget` | false (override allowed) | true — current `task_assignee_agent_id` MUST be NULL (atomic WHERE-NULL guard, same as today) |
| `unclaimTask: requireSelfOnUnclaim` | false | true — current task assignee MUST equal `actor.agentId` else `not_assignee` |
| `requireOwnConversation` | false | true — `task.conversation_id === actor.conversationId` (binding; cross-conversation rejected with `wrong_conversation`) |
| `requireConversationMembership` | false | true — `getAgent(task.conversation_id, actor.agentId)` exists (data-integrity guard, redundant with above but kept) |
| `requireValidTransition` | false | true — must follow `VALID_TRANSITIONS[current]` |
| `allowAnyTransitionExceptCurrent` | true | false — user can jump to any non-current status (matches today's `humanUpdateStatus`) |
| `assigneeMustBeConversationMember` | true | true — when assignee != null, that agent must be member of `task.conversation_id` |
| `taskCreationRestricted` | false (no v1 user route) | true — agent must be member of target conversation; conversation must be open |
| `list: scopeToActorWorkspace` | false (global) | true — only tasks in `actor.conversationId.workspace_id`; for DM workspaces, the physical `task_workspace_id` is used (no special-case rewrite to dm_channel root id; UI scope rewrite belongs at DTO layer where it already lives) |
| `getByMessageId: requireVisible` | false | true — agent can only fetch tasks in actor's conversation workspace |
| `systemMessageActor` | `"by user"` | `"@<agent.name>"` |

## Invariant contract (top-of-file doc block)
The service is the **single owner** of the following side-effects for
task create / claimTask / unclaimTask / updateStatus:

For each op, inside ONE `db.transaction(() => { ... })`:
- (createTasks) per requested task: `messages.insertForConversation`
  → allocate workspace-scoped `task_number` → UPDATE message with
  task_* fields.
- (claimTask) lookup task by `by` (per actor+op resolution rules
  below) → validate per policy → UPDATE message with new
  `task_assignee_agent_id` and `task_status = CASE WHEN todo THEN
  in_progress ELSE current`. Atomic WHERE-NULL guard for agent actor.
- (unclaimTask) lookup → validate per policy → UPDATE
  `task_assignee_agent_id = NULL, task_status = 'todo'`.
- (updateStatus) lookup → validate per policy → UPDATE message with
  new `task_status`.

After the transaction commits, in this exact order (PR-1 / PR-2 pattern;
**fixes the existing `tasks.ts` `broadcast()` ordering bug**):
1. For each affected task, insert the system narrative message
   (`subtype: 'task_<kind>'`) — itself a small write done in a second
   small txn after the main mutation commits, so the system message
   timestamps follow the mutation cleanly.
2. `events.publish(conversationId, { kind: 'message', payload:
   { message: sysMsg } })`.
3. `events.publish(conversationId, { kind: 'task_changed', payload })`.
4. `events.publishToScope('workspace:'+workspaceId, 'task_changed', payload)`.
5. Best-effort, fire-and-forget: per recipient
   `conversationManager.deliverMessage(conversationId, agentId,
   sysMsg.id)` — try/catch + warn. **Today's `broadcast()` AWAITS
   deliver before publishing — this is the same drift PR-2 fixed for
   send-message, so PR-5 inverts it.** New ordering test asserts
   `publish` precedes `deliver`.

Service ALWAYS returns its result once the main mutation txn commits
and the realtime publishes succeed. Best-effort delivery cannot
produce 5xx.

## Pre-conditions (validated inside service, per actor+op)

### Shared `by` resolution (NOT a single helper — branched per actor+op)
Listed below as part of each op's preconditions to avoid the
"non-task message_id" ambiguity Cindy flagged.

### `createTasks`
- C1 conversation exists & not closed.
- C2 if `actor.kind === 'agent'`: `getAgent(conversationId, actor.agentId)`
  required (matches today's `not_conversation_member`).

### `claimTask`
- CL1 resolve `by`:
  - `by.messageId` + actor=agent: fetch message;
    - **promote pre-guards** (when `task_number === null`, fired BEFORE
      promote inside the same txn — preserves today's `claimByMessageId`):
      - (a) message exists → else `code:'message_not_found'`.
      - (b) `message.conversation_id === actor.conversationId` → else
        `code:'wrong_conversation', reason:'message belongs to another conversation'`.
      - (c) `from_kind !== 'system'` → else `code:'cannot_promote_system_message'`.
      - (d) `metadata.subtype !== 'thread_anchor'` → else
        `code:'cannot_promote_anchor'`.
    - if all guards pass and `task_number === null` → promote-and-claim
      atomically inside the same txn (allocate task_number, set task_*
      fields, then claim).
    - if `task_number !== null` → claim-by-number semantics (still
      validates CL3 below).
  - `by.messageId` + actor=user: fetch message; if `task_number === null`
    → `{success:false, code:'not_a_task', reason:'not a task'}`
    (preserve human-route shape; user never promotes).
  - `by.taskNumber` (agent only — type system rejects user+number):
    fetch row by `(taskWorkspaceId, task_number)` where
    `taskWorkspaceId = conversations.get(actor.conversationId).workspace_id`.
- CL2 task not `done`: `{success:false, code:'task_done', reason:'task is already done'}`.
- CL3 if actor.kind === 'agent':
  - `task.conversation_id === actor.conversationId`, else
    `{success:false, code:'wrong_conversation', reason:'task belongs to another conversation'}`
    (preserve `owner_conversation`-style explanation for claim-by-number).
  - `getAgent(task.conversation_id, actor.agentId)` exists (data-integrity).
  - `assignee` undefined OR `assignee.agentId === actor.agentId`, else
    `code:'not_self_assignment'`.
  - Atomic WHERE assignee IS NULL — if no row affected:
    `{success:false, code:'already_claimed', reason:'already claimed by ...'}` (preserve).
- CL4 if actor.kind === 'user' AND `assignee != null`:
  - `assignee.agentId` exists.
  - `getAgent(task.conversation_id, assignee.agentId)` else
    `code:'assignee_not_conversation_member'`.

### `unclaimTask`
- UN1 resolve `by`: same as CL1 (no promote-on-unclaim, even for
  agent — non-task message_id → `not a task`).
- UN2 task not `done`.
- UN3 if actor.kind === 'agent':
  - `task.conversation_id === actor.conversationId`, else `wrong_conversation`.
  - current `task_assignee_agent_id === actor.agentId`, else `not_assignee`.
- UN4 if actor.kind === 'user': no further check (any current
  assignee/null OK; matches today's humanUnclaim).
- All paths SQL: `assignee=NULL, status='todo'`.

### `updateStatus`
- US1 resolve `by`: same as CL1 (no promote).
- US2 if actor.kind === 'agent':
  - `task.conversation_id === actor.conversationId`, else `wrong_conversation`.
  - actor must be task assignee, else `not_assignee`.
  - status must satisfy `VALID_TRANSITIONS[current]` else
    `invalid_transition`.
- US3 if actor.kind === 'user':
  - `status !== current_status` else `already_at_status` (preserve
    today's `task already has that status`).

### `list` / `getByMessageId`
- L1 actor.kind === 'user': honor `workspaceId` filter if present
  (else global), then honor `conversationId` filter if present.
- L2 actor.kind === 'agent': service derives
  `derivedWorkspaceId = conversations.get(actor.conversationId).workspace_id`,
  IGNORES caller-supplied `workspaceId`. Returns only tasks where
  `task_workspace_id = derivedWorkspaceId`. If `conversationId` filter
  present, applied AFTER the workspace scope check (route never
  enforces this boundary).
- L3 `getByMessageId` for agent actor: returns null if task's
  `task_workspace_id ≠ derivedWorkspaceId`.

## Error taxonomy → HTTP mapping
TaskService keeps the existing `TaskOpError` string union for
backward-compat with the route response shape, AND adds a typed `code`
field on `{success:false}` results so HTTP layer can map without
string-matching `reason`. Old `reason` strings preserved verbatim for
agent tool consumers.

New typed codes:
- `not_self_assignment` (400) — agent tried to claim FOR another agent.
- `assignee_not_conversation_member` (400) — typed version of today's
  free-form reason.
- `wrong_conversation` (400) — agent op against task in another conv.
- `not_assignee` (400) — agent unclaim/status of non-self task.
- `not_a_task`, `task_done`, `already_claimed`, `invalid_transition`,
  `already_at_status`, `conversation_not_found`, `not_conversation_member`,
  `conversation_closed`.

The service returns shaped result objects matching today's
`TaskMutationResult` and `ClaimResultEntry`. No new error class
machinery; the service catches typed cases and returns them as
discriminated union members rather than throwing — preserving today's
HTTP route shape (`success: false, reason, code`) without forcing every
route to wrap in try/catch.

This is intentionally different from PR-1 / PR-2 / PR-3 which throw
typed errors. Tasks already use a result-discriminated-union shape
across both human and agent routes; rewriting that to throws would
churn 4 route bodies for no behavioural gain. The "policy is enforced
in service" invariant still holds — the difference is just whether the
verdict comes back via throw or via `{success:false, code, reason}`.

## Test matrix (services/task-service.test.ts)

### `createTasks`
| # | Scenario | Expected |
|---|---|---|
| 1 | agent member creates 2 tasks | both inserted, task_number monotonic per workspace, broadcast fires `message` + `task_changed` for each |
| 2 | agent not in conversation | `code:'not_conversation_member'`, no insert |
| 3 | conversation closed | `code:'conversation_closed'` |
| 4 | conversation missing | `code:'conversation_not_found'` |
| 5 | concurrent createTasks: two callers in same workspace | task_numbers do not collide |
| 6 | broadcast publishes BEFORE deliver | order assertion via spy; `message` event fires before `deliverMessage` resolves |

### `claimTask` — agent actor
| # | Scenario | Expected |
|---|---|---|
| 7 | agent self-claim by taskNumber, currently unassigned | success entry: `{success:true, task_number, status:'in_progress', assignee:{...}}`, publishes |
| 8 | agent self-claim by messageId, message is already a task | falls through to claim-by-number semantics, success |
| 9 | agent self-claim by messageId, message is not yet a task | promote-and-claim atomically, allocates new task_number; entry includes new `task_number` |
| 10 | agent claim, task already claimed by other | `{success:false, code:'already_claimed', reason:'already claimed by ...'}` |
| 11 | agent claim with `assignee.agentId !== actor.agentId` | `code:'not_self_assignment'` |
| 12 | agent claim, task in another conversation (same agent is also member there) | `code:'wrong_conversation'` (binding check fires before membership) |
| 13 | agent claim, task done | `code:'task_done'` |
| 14 | agent claim preserves status if already in_progress | status unchanged (CASE WHEN todo) |
| 14a | agent claim by messageId, message does not exist | `code:'message_not_found'` (promote pre-guard a) |
| 14b | agent claim by messageId, message in another conversation | `code:'wrong_conversation'` (promote pre-guard b — fires BEFORE promote, no allocation happens) |
| 14c | agent claim by messageId, message is system message (e.g. onboarding) | `code:'cannot_promote_system_message'` (promote pre-guard c) |
| 14d | agent claim by messageId, message is thread_anchor | `code:'cannot_promote_anchor'` (promote pre-guard d) |

### `claimTask` — user actor
| # | Scenario | Expected |
|---|---|---|
| 15 | user claim with agentId on todo task | success, assignee set, status=in_progress |
| 16 | user claim WITHOUT agentId on todo task | success, assignee=null, status=in_progress (matches humanClaim no-agent_id) |
| 17 | user claim with agentId on in_progress task | success, assignee overridden, status preserved |
| 18 | user claim assigning to agent not in conversation | `code:'assignee_not_conversation_member'` |
| 19 | user claim on non-task messageId | `code:'not_a_task', reason:'not a task'` (NO promote for user) |

### `unclaimTask`
| # | Scenario | Expected |
|---|---|---|
| 20 | agent unclaim of self-owned task | success, assignee=null, status='todo' |
| 21 | agent unclaim of task assigned to OTHER agent | `code:'not_assignee'` |
| 22 | agent unclaim of task with no assignee | `code:'not_assignee'` |
| 23 | agent unclaim, task in another conversation | `code:'wrong_conversation'` |
| 24 | user unclaim of any task | success, assignee=null, status='todo' (forced regardless of prior status) |
| 25 | user unclaim on non-task messageId | `code:'not_a_task'` |

### `updateStatus`
| # | Scenario | Expected |
|---|---|---|
| 26 | agent updates own task in_progress → in_review | success |
| 27 | agent invalid transition (in_progress → todo) | `code:'invalid_transition'` |
| 28 | agent updates non-self task | `code:'not_assignee'` |
| 29 | agent updates task in other conversation | `code:'wrong_conversation'` |
| 30 | user overrides any non-current status | success (e.g. todo → done) |
| 31 | user sets same status | `code:'already_at_status'` |
| 32 | broadcast publish-first ordering for status change | order assertion |

### `list` / `getByMessageId`
| # | Scenario | Expected |
|---|---|---|
| 33 | user list global | sees tasks across all workspaces |
| 34 | user list filtered by `workspaceId` | only that workspace |
| 34a | user list filtered by `workspaceId + conversationId` | only tasks in that conversation |
| 35 | agent list ignores caller `workspaceId`, derives from actor.conversationId | only sees tasks in actor's physical workspace, even if caller passes a different workspaceId |
| 35a | agent list with `conversationId` filter inside actor's workspace | only that conversation's tasks |
| 35b | agent list with `conversationId` filter pointing OUTSIDE actor's workspace | empty result (workspace scope check applied first; route never enforces) |
| 36 | agent getByMessageId for task in another workspace | returns null |
| 37 | task with `task_workspace_id` belonging to a DM workspace | service returns rows by physical `task_workspace_id`. PR-5 makes no claim about `TaskSummaryDto.workspace_id` projection — that DTO field stays whatever today's DTO layer produces (no change in this PR). Per round-3 consensus with Cindy, the per-agent `system_dm` workspace work is deferred to PR-6 candidate; PR-5 does not bake DM projection into the service. |

### Workspace-scope event
| # | Scenario | Expected |
|---|---|---|
| 38 | task_changed fires for both `conversation:<cid>` AND `workspace:<wid>` scopes per mutation | both subscribers receive event |

### Route-level integration (`tests/routes/tasks.test.ts` already exists; extend)
- Agent `POST /internal/.../claim-tasks` with bulk `task_numbers + message_ids` returns aggregated `ClaimResultEntry[]` (route does iteration; passes only `actor + ref` per call).
- Human `POST /api/tasks/:messageId/claim` with no `agent_id` lifts todo→in_progress, leaves assignee null.
- Human `POST /api/tasks/:messageId/unclaim` forces status='todo' even if currently in_review.
- Human `POST /api/tasks/:messageId/status` allows overriding any status except current.

## Migration ordering inside PR-5
1. Add `task-service.ts` + tests (green in isolation).
2. Update shared DTO schemas to match new shapes:
   - `ClaimResultEntrySchema` — add typed `code?` on failure variant.
   - `TaskMutationResultSchema` — add typed `code?` on failure variant.
   - `CreateTasksResultSchema` — add `error|tasks` discriminated union.
3. Wire into `BackendContext` and `buildTestApp`.
4. Replace human task routes (`/api/tasks/:messageId/claim |
   unclaim | status` and `/api/tasks` GET) → ~10 lines each. GET route
   loses workspace-filter logic; service handles `workspaceId` +
   `conversationId` filters.
5. Replace agent task routes
   (`/internal/.../create-tasks | claim-tasks | unclaim-task | status`)
   → agent claim route loops over `task_numbers + message_ids` and
   aggregates `ClaimResultEntry[]`. Route passes ONLY `actor + ref`;
   no workspace_id, no scope derivation.
6. Delete `tasks.ts` entirely (`listTasks` + `getTaskByMessageId` moved
   into service).
7. Update `docs/mcp-system.md` only if any agent-facing schema changes
   (none expected; the MCP `claim_tasks` tool surface stays the same;
   typed `code` is additive on existing `success/reason` shape).

## Resolved questions (round 1, agreed with @Cindy)
1. Result union OK — keep `{success:false, reason}`, ADD typed `code`.
2. `listTasks` + `getByMessageId` move into TaskService; both
   actor-aware (agent scoped to actor's physical workspace).
3. Bulk in route OK; route passes only `actor + ref`, no number scope.
4. `broadcast` publish-first reversion confirmed; new tests #6 / #32
   assert ordering.

## Round-2 blockers fixed (agreed with @Cindy)
1. Action-oriented split: `setAssignee` removed; `claimTask` +
   `unclaimTask` + `updateStatus` instead. `claimTask` preserves /
   lifts status (CASE WHEN todo); `unclaimTask` always forces
   `status='todo'`. Eliminates the ambiguous `assignee:null`.
2. `by.messageId` resolution branched per actor+op (CL1 / UN1 / US1)
   rather than a shared helper.
3. `task.conversation_id === actor.conversationId` is a binding check
   for agent ops (CL3 / UN3 / US2), not informational; membership stays
   as data-integrity guard.
4. `taskWorkspaceId` rename — service derives from
   `actor.conversationId.workspace_id`; route never passes a workspace
   for number scope.

## Round-3 blockers fixed (agreed with @Cindy)
1. `claimTask` returns `Promise<ClaimResultEntry>` (richer per-target
   result with new `task_number` on promote-success), enabling agent
   bulk route aggregation. Human route only reads `success/reason/code`.
2. `createTasks` typed error union: `{tasks} | {error, code}`; eliminates
   implicit error shape contract.
3. `list` honors `conversationId` filter; user honored directly, agent
   honored AFTER physical workspace scope check (route never enforces).
4. `claimTask(by:messageId)` agent promote: 4 explicit pre-guards
   (message_not_found, wrong_conversation, cannot_promote_system_message,
   cannot_promote_anchor) inside the same txn, BEFORE allocation.
5. `TaskRef` narrowed per actor via discriminated union: user-actor
   inputs are typed to `{messageId}` only; user+taskNumber is rejected
   by the type system, not by runtime `unsupported_ref`.

## Round-3 clarifications (agreed with @Cindy)
- DM wording: PR-5 makes NO claim about DM projection. Number/filter
  scope is pure physical `task_workspace_id = conversation.workspace_id`.
  `TaskSummaryDto.workspace_id` rewrite (DM → dm_channel root id) stays
  at today's DTO layer untouched. Per-agent `system_dm` workspace
  becomes PR-6 candidate (separate design).
- Shared DTO schema bumps included in migration step 2.
- Agent claim-by-number `wrong_conversation` keeps explanatory
  `reason: 'task belongs to another conversation'` for tool consumers,
  while `code` is the typed `wrong_conversation`.

## PR-6 candidate (out of scope, noted for follow-up)
Per-agent `system_dm` workspace, lifecycle-coupled to agent. Design
needs to cover: schema (`workspace_kind='system_dm'`, FK back to agent),
`agents.create` / `agents.delete` symmetric provisioning, attachments &
inbox sweep on delete, sidebar rendering, migration from current global
`SYSTEM_DM_WORKSPACE_ID` (per-channel split + `messages.task_workspace_id`
backfill), guardrails preventing DM workspace from accreting extra
channels/members. Eliminates the projection layer rather than
formalizing it.
