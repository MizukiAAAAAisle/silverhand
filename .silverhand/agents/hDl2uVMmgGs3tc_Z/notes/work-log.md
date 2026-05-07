# Work Log

## 2026-05-04
- Reviewed and helped close early lifecycle, message latency, and pinned-session
  issues. Important outcomes: backend delivery was not the send-delay bottleneck;
  optimistic message append fixed visible latency; pinned sessions required both
  UI sibling controls and backend child-session rejection.
- Implemented or reviewed agent activity foundations: run state, snapshot
  endpoint, terminal cleanup, Codex resume error handling, raw activity display,
  and tool-call counts.
- Fixed several UI correctness issues, including chat layout flex stability,
  thread quote jump behavior, closed-thread cache propagation, Events window
  labels/list behavior, and Thread activity subscriptions.
- Message unread design settled on `session_reads` cursors and a frontend
  viewer boundary for `local`.

## 2026-05-05
- Helped drive workspace/channel/thread rename. Accepted internal conversation
  abstraction while keeping public terminology as workspace/channel/thread.
- Implemented backend/shared rename slices, shadow migration, MCP/tool prompt
  rename follow-through, and guarded top-level channel/thread semantics.
- Worked on search, theme, and identity cleanup. Key invariant: do not spread
  hard-coded `local` beyond viewer/API boundary.
- Implemented prompt hardening for ping-loop prevention: agent messages are not
  invitations to chat unless directly relevant, assigned, or a blocker exists.

## 2026-05-06
- Implemented WebSocket transport/client slices and later SSE cleanup. WS uses
  app/workspace/conversation/viewer scopes with auth, epoch, resume, and
  snapshot-required behavior.
- Fixed post-WS regressions: duplicate network requests, stale subscribe state,
  unread invalidation, search route regression, sidebar thread fallback removal,
  and related task/sidebar refresh paths.
- Added dev-only Electron CDP support for network diagnostics.
- Compared Silverhand and Slock prompt behavior. Findings: notes and Thread
  proactivity depended on prompt/tool friction; Silverhand Thread semantics
  should stay heavier than Slock lightweight thread targets for now.
- Task #104 tightened memory behavior: MEMORY.md is now a compact index/current
  handoff, with detail moved to notes.
- Task #105 compacted existing workspace agent MEMORY.md files and created note
  files for durable details.
- Task #111 audited human-route vs agent-internal duplicate backend business
  flows. Agreed service extraction order starts with ChannelService to close the
  #109 class of publish drift, then message, thread, attachment locate after
  #110, and tasks. Reviewed Alice's ChannelService PR-1 draft and required
  explicit member snapshot semantics, source-conversation errors, post-commit
  publish guarantees, and typed setPinned errors.
- Task #113 implemented ChannelService PR-1: service owns channel create,
  seed-message fan-out/start, pin/unpin, and `workspace_channels_changed`;
  human and internal create-channel routes delegate to it, with route tests
  covering #109 publish regression and thread-member snapshot semantics.
- Task #115 implemented ConversationMessageService PR-2: service owns user
  and agent send-message attachment validation, message insert, publish,
  unread/thread refresh, resolveRun, best-effort delivery, cc-mentions, and
  user auto-start policy. Human channel/thread message routes and internal
  send-message now delegate to the service.
- Task #118 implemented ThreadService PR-3 and moved it to review: service
  owns message-anchored thread creation, agent-created thread creation, and
  agent close-thread side effects. Routes now delegate wrappers only; create
  and close publish before best-effort delivery/start/stop, close validates
  the `(threadId, agentId)` actor membership, and agent-created threads
  explicitly do not auto-start the spawner.

## 2026-05-07
- Reviewed Alice's TaskService PR-5 implementation (#120). Verification passed
  for backend vitest (374/374) and backend/shared/chat-bridge typechecks, but
  the review blocked merge because agent claim/unclaim/status no longer
  validate that the actor agent exists and is a member of the source
  conversation, and the documented transaction contract for mutations plus
  task system-message insert was not actually implemented.
- Re-reviewed #120 after Alice's round-2 fixes and passed it. Agent actor
  validation and mutation transaction boundaries were restored, system-message
  insert moved into its own transaction, backend vitest reported 38 files /
  382 tests passing, and `pnpm -r typecheck` was green. Noted a non-blocking
  follow-up: agent `unclaimTask` / `updateStatus` messageId refs should get
  claim-style conversation guards or be narrowed to taskNumber-only.
- Reviewed Alice's PR-6 `agent_home` workspace design draft (#121) and blocked
  r1. Main issues: current migration runner only accepts SQL strings inside a
  transaction with foreign keys on, so context-bound/foreign-keys-off migration
  assumptions do not hold; saved_messages/notifications/unread/search/saved
  projection rewrites were missing; removing the DM channels route needs a
  replacement channel-list path for agent_home workspaces; global workspace
  name uniqueness conflicts with generated home names; and agent delete still
  needs explicit attachment blob sweep before relying on DB cascade.
- Re-reviewed #121 r2 and kept it blocked. Direct SQLite reproduction showed
  `ALTER TABLE workspaces RENAME TO ...` with foreign keys on retargets child
  FK declarations to the legacy table; `PRAGMA defer_foreign_keys` only defers
  checks and does not retarget schema, while dropping the legacy parent can
  cascade-delete child rows. r3 must either rebuild the full FK tree or add an
  explicit migration-runner special path. Also asked Alice to write the exact
  `WorkspaceDto.dm_channel_id` / channel-like API contract and separate DB
  `agent_home` storage kind from UI/search `dm` presentation. Confirmed
  `sweepForChannel(dm.id)` covers thread attachments because uploads store the
  parent channel id.
- Passed #121 r3 design. Accepted a v16-only migration runner escape:
  `foreign_keys=OFF` outside the transaction plus `legacy_alter_table=ON`,
  `foreign_key_check` inside the same transaction before `_migrations` insert,
  and pragma restoration afterward. Final model: DB/API storage kind is
  `regular | agent_home`; renderer/search continue projecting `agent_home` to
  `dm` without adding a second `kind` to `WorkspaceDto`; `workspace_members`
  stays regular-only, while home ownership is `workspaces.owner_agent_id`;
  `/api/workspaces/:id/channels` branches by workspace kind and uses a new
  dm-channel lookup rather than loosening `listChannelsForWorkspace`.
- Implemented #122 PR-6 and moved it toward review. The implementation adds
  v16 `agent_home` migration support with runner escape + rollback tests,
  per-agent owned home workspaces with multiple dm_channel roots, regular-only
  workspace_members enforcement, agent create/delete lifecycle wiring, backend
  route/repo/search/saved/notification/unread projection cleanup, and renderer
  `agent_home -> dm` projection. Verification: backend vitest 39 files / 387
  tests passing and `pnpm -r typecheck` green.
- Fixed a PR-6 semantic regression found during user sandbox testing: newly
  created agent homes now use `Onboarding` as the default dm_channel title
  instead of repeating `dm-<name>` at both workspace and channel levels. Legacy
  migrated `dm-<name>` titles stay untouched; default landing channel selection
  prefers `Onboarding` then legacy `dm-<owner.name>` then creation time.
  Rebuilt `better-sqlite3` for the active Node ABI, then re-ran verification:
  backend vitest 39 files / 387 tests passing and `pnpm -r typecheck` green.
- Added the non-blocking PR-6 navigation fallback fix: `WorkspaceDto` now
  includes `dm_channel_ids` with all dm_channel roots under an agent_home, while
  `dm_channel_id` remains the default landing pointer. Renderer workspace list
  items use the full id list so old callers that navigate with a secondary
  channel id such as Mentions can still resolve to the owning home workspace.
  Verification after this patch: backend vitest 39 files / 387 tests passing
  and `pnpm -r typecheck` green.
- After the user cut over to the new release, ran a read-only check against
  `~/.silverhand/silverhand.db`: migration max version is 16, `quick_check` is
  ok, `foreign_key_check` has 0 violations, legacy `__system_dm_workspace__`
  rows/references are gone, every agent has exactly one agent_home, no
  workspace_members row points at agent_home, all DM channels are under
  agent_home, and task/saved/notification workspace scopes have no legacy or
  mismatch rows.
- Implemented #125 auth infra Slice A' and moved it to review: added backend
  Principal types/resolvers, shared `X-Silverhand-Principal` header helpers,
  public user-principal resolution with legacy user-id compatibility, internal
  agent principal derivation from URL membership plus rejection of principal
  headers, and folded message/channel/thread/task service actor shapes onto
  the Principal variants. Scope intentionally did not add public Bearer gates,
  ACL skeletons, or attachment GET authorization. Verification used the repo
  ABI-aware `pnpm test -- ...` path and `pnpm typecheck`; backend vitest ran
  39 files / 390 tests passing and typecheck was green across workspaces.
- Fixed Alice's #125 review blocker: public principal middleware now skips
  `/internal/` paths before parsing headers, and internal route tests assert the
  exact rejection body for both `agent:*` and `user:*` principal headers.
  Re-verification: repo ABI-aware `pnpm test -- ...` reported backend vitest
  39 files / 391 tests passing, and `pnpm typecheck` was green.
- Implemented #126 cleanup after A' review nits: introduced typed Hono
  `AppEnv`/`AppContext` for principal storage, removed principal helper casts,
  added `PrincipalConversationMismatchError` plus agent conversation invariant
  guards in ConversationMessageService, TaskService.createTasks,
  ThreadService.createThreadFromAgent, and ThreadService.closeThread. Added
  service regression tests for mismatch rejection. Verification: repo
  ABI-aware `pnpm test -- ...` reported backend vitest 39 files / 394 tests
  passing, and `pnpm typecheck` was green.
- Fixed Alice's #126 cleanup nit by removing the dead
  `actor_conversation_mismatch` value from `CreateTasksOpErrorSchema`; service
  mismatch now throws `PrincipalConversationMismatchError` instead of returning
  that op error. Re-verification: backend vitest 39 files / 394 tests passing
  via `pnpm test -- ...`, and `pnpm typecheck` was green.
- Reviewed Alice's Slice B (#127) Bearer sweep and found no blocker: public
  Bearer middleware is mounted on `/api/*` before principal resolution, health
  is exact-allowlisted, test helpers inject Bearer only when passed a `TestApp`,
  and the new auth-bearer tests cover missing/wrong/correct token plus health.
  Combined verification after #128 changes: backend vitest 41 files / 405 tests
  passing via `pnpm test -- ...`, and `pnpm typecheck` was green.
- Implemented Slice D-skeleton (#128): moved WS permission helpers behind a new
  backend-level `permissions.ts`, added the ACL family
  `canViewWorkspace/canMutateWorkspace/canManageMembers/canViewConversation/
  canPostToConversation/canViewAttachment/canDeleteAttachment/canViewOwnedState`,
  and wired route placeholder callsites across workspace, conversation,
  viewer-state, attachment upload/delete, thread creation, and internal agent
  paths. Attachment GET ACL remains untouched for the later explicit task.
- Alice reviewed #128 and passed it. The only noted deferred item is expected:
  `GET /api/attachments/:id` still waits for Slice C / explicit user
  instruction before wiring `canViewAttachment`.
- Implemented #110 attachment GET auth v1 after user approval: public GET now
  inherits `/api/*` Bearer, requires a viewer principal, delegates row lookup
  and ACL folding to `AttachmentService.serveForViewer`, and passes
  `canViewAttachment(ctx, principal, row)` as the route-supplied ACL. Removed
  the unauthenticated service `serve` method. Tests cover missing/wrong Bearer,
  successful download, same-shape 404 for missing vs ACL-denied, and service
  callback-denied folding. Verification: backend vitest 41 files / 409 tests
  passing via `pnpm test -- ...`, and `pnpm typecheck` was green.
- The user manually smoke-verified the auth sequence: uploading an
  image/file in a channel still previews/downloads, and unauthenticated
  `/api/attachments/:id` returns 401. Auth infra v1 is closed; deferred items
  remain multi-human membership, signed URL helpers, and avatar/profile ACL.
- Investigated #129 in the `agent_activity` / `agent_event` thread after the
  user observed many Codex raw events but no stable activity events. Root cause:
  runState lifecycle was coupled to delivery, so `turn_end` could clear the run
  and later Codex self-driven raw events would hit `updateRun` with no current
  state and produce no `agent_activity`. Fixed backend aggregation so
  state-affecting parsed events materialize a thinking run before updating
  snippet/tool counts/tool-output transitions. Alice reviewed the first pass and
  noted `tool_output` should use the same materialization path; added that
  edge-case coverage before returning to review. Verification:
  `pnpm -r typecheck` passed, and
  `./scripts/test.sh tests/manager/lifecycle.test.ts` passed 41 tests including
  the new rematerialization regression.
