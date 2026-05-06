# Alice Memory

## Role
- Handle: @Alice
- Runtime: claude
- Workspace: silverhand
- Default role in this workspace: architecture planning and technical solution
  design.
- Collaboration rule from the user: seriously evaluate Cindy's critiques;
  adopt them when valid and push back with reasoning when not.
- Design emphasis: global perspective, modularity, clear boundaries, and change
  impact.

## Key Knowledge
- Read [notes/user-preferences.md](notes/user-preferences.md) for durable user
  preferences and collaboration rules.
- Read [notes/project.md](notes/project.md) for Silverhand architecture,
  terminology, and current invariants.
- Read [notes/work-log.md](notes/work-log.md) for compact work history and
  follow-ups.
- Read [notes/attachment-auth.md](notes/attachment-auth.md) for the locked
  v1 attachment auth design (slice in the broader permission redesign).
- Read [notes/permission-system.md](notes/permission-system.md) for the
  holistic permission system design (3 principals × 3 transports × 4 ACL
  families, v1 slices A–D, deferred multi-user artifacts).
- Read [notes/agent-home-pr6.md](notes/agent-home-pr6.md) for the PR-6
  per-agent agent_home workspace design draft (in_review).

## Active Context
- Thread: "统一 human/agent 共用业务到 application service 层"
  (forked from mcp system). Goal: collapse duplicated human-route +
  agent-internal business into one application-service layer; routes
  only do auth + param translation + HTTP mapping. Trigger: #109
  channel-create drift on `workspace_channels_changed`.
- Framing locked with @Cindy: **service is the single owner of business
  side-effects**. Routes never wire publish/CC/auto-start themselves.
- @Cindy owns task #111 (audit human/agent dual-entry routes, inventory
  + diff). She skipped pure single-entry endpoints.
- @Alice owns task #112 "Draft ChannelService interface (PR-1)" — in_review
  (kept open as the design reference). Draft saved at
  [notes/channel-service-pr1.md](notes/channel-service-pr1.md), 21-case
  test matrix, all of @Cindy's review amendments applied.
- @Cindy is implementing PR-1 against that design under a separate
  follow-up task; she will mark it in_review and @Alice reviews.
- Task #113 "Implement ChannelService PR-1" — done. Three nits filed
  for cleanup (shared `agent_not_found` code, duplicated repoError
  helper, missing `autoStart='none'` assertion).
- Task #114 / #115 (ConversationMessageService PR-2) — done.
- Task #116 "Draft ThreadService interface (PR-3)" — in_review, owned
  by @Alice. Draft at [notes/thread-service-pr3.md](notes/thread-service-pr3.md).
  Cindy review-passed after 4 blocker-fixes (no thread→thread, per-seed
  delivery flags, closeThread actor membership, close publish-first
  ordering).
- Task #118 "Implement ThreadService PR-3" — in_review, @Alice
  reviewed and approved (328-test backend suite green; per-seed
  flags, closeThread T4 actor validation, summary publish-before-deliver
  all match design). Cindy noted dynamic `serverConfig` callable form
  is intentional (tests/runtime config changes); my "over-engineered"
  nit was wrong.
- Awaiting user to flip #116 + #118 to done. PR-4 (attachment locate
  unification) still gated on #110.
- #119 (PR-5 design) and #120 (PR-5 impl) — done.
- Task #121 "Draft PR-6: per-agent agent_home workspace design" —
  in_review, owned by @Alice. Cindy r3 PASS (after r1 + r2 both got
  blockered). Final draft at
  [notes/agent-home-pr6.md](notes/agent-home-pr6.md) covers:
  schema v16 (workspaces rebuild via opt-in `foreignKeyEscape`
  runner branch: `foreign_keys=OFF` outside txn + `legacy_alter_table=ON`
  inside, both pragmas restored in finally; `foreign_key_check`
  inside-txn before `_migrations` insert so violations roll back
  atomically; recipe empirically verified end-to-end against
  v15-shape DB), 9-step ordered backfill (workspaces rebuild →
  regular copy → agent_home insert → reparent dm_channel + threads →
  retag messages/saved_messages/notifications → drop legacy),
  membership vs ownership split (`workspace_members` regular-only
  with guard trigger; `owner_agent_id` UNIQUE FK CASCADE expresses
  agent_home ownership; `listForAgent` UNIONs both;
  `computeAgentDeleteImpact` returns `{regular_memberships,
  owned_home, dm_channel, attachments_count}`), API/DTO precision
  (no new `kind` field on `WorkspaceDto` — only storage truth
  `workspace_kind: regular|agent_home`; UI/search projection happens
  in renderer mapper + search-repo, each consumer projects locally;
  `dm_channel_id` filled by explicit subquery; channel route branches
  by workspace_kind without relaxing `listChannelsForWorkspace`),
  task-service SELECT collapse (drop `dm_channel` CASE branches),
  agent DELETE keeps `sweepForChannel(dm.id)` before DB delete (one
  call covers thread attachments per Cindy Q5).
- Task #122 "Implement PR-6 per-agent agent_home workspace" —
  in_review, owned by @Cindy. @Alice review PASS. Verified:
  runner escape (db.ts) matches design exactly; v16 migration body
  9-step retag + extra `source_workspace_id` retag + INSERT/UPDATE
  triggers; createAgentWithHome txn covers all DB writes;
  multi-DM aware (agent dedupe in step 3, channels endpoint returns
  all dm_channels under home, delete sweeps every home dm_channel
  for blob cleanup). `db-migrations.test.ts` covers success + FK
  rollback paths with pragma restore. 39 files / 387 tests green;
  full typecheck green. PR-6 follow-up patches landed inside #122
  (verified post-fix): (a) new agent default dm_channel title back
  to `Onboarding`; primary-channel selection ordering = `Onboarding`
  → legacy `dm-<owner>` → `created_at`; migrated rows keep
  `dm-<name>` titles. (b) `WorkspaceDto.dm_channel_ids: string[]`
  now carries every dm_channel under an agent_home (json_group_array
  subquery in WORKSPACE_SELECT + listForAgent), renderer mapper
  transparently passes through, so `resolveNavWorkspaceId` resolves
  Mentions channel id back to home. Re-verified: pnpm -r typecheck
  green, 39 files / 387 tests green. Awaiting user to flip #122 done.
- Task #119 "Draft TaskService interface (PR-5)" — in_review, owned
  by @Alice. Draft at [notes/task-service-pr5.md](notes/task-service-pr5.md).
  Rounds completed: r1 (initial), r2 (action-oriented split + binding
  conv check + taskWorkspaceId rename), r3 (richer ClaimResultEntry,
  CreateTasksResult union, list conversationId filter, 4 promote
  pre-guards, narrowed TaskRef discriminated union). All Cindy
  blockers addressed.
- Task #120 "Implement TaskService PR-5" — in_review, owned by @Alice
  (user reassigned implementation from Cindy → Alice this round).
  Round 1: 11 implementation steps (shared DTO bumps, new
  task-service.ts, BackendContext + buildTestApp + manager.ts +
  index.ts wiring, 4 agent + 4 human routes replaced, tasks.ts
  deleted, 42-case task-service.test.ts, vitest 374/374, all packages
  typecheck green). Round 2 (Cindy review fixes): added
  `validateAgentActorForClaim/forMutation` helpers (agent-existence +
  source-conv membership), wrapped every mutation
  (createTasks loop, claimTask*, unclaimTask*, updateStatus*) in
  `db.transaction(() => { read+validate+write; return {failure}|{success,...} })()`,
  post-commit broadcast; broadcast's sysMsg insert wrapped in own txn;
  added `actor_conversation_mismatch` typed code (createTasks distinct
  from `agent_not_found` and `not_conversation_member`); added 8
  regression tests (cross-conv mismatch, agent_not_found on
  create/claim/unclaim/status, not_conversation_member on
  claim/unclaim/status). Final 382/382 vitest green, full typecheck
  green. Cindy approved round 2 ("可以合"). Round-3 follow-up
  (Cindy non-blocking nit) closed: added `wrong_conversation` guard
  to `unclaimTaskAgent` / `updateStatusAgent` `by:{messageId}` branch
  + 2 regression tests. Final 384/384 vitest, typecheck green.
  Awaiting user to flip #120 to done.
- **PR-6 candidate locked with @user + @Cindy**: per-agent `agent_home`
  workspace replaces global `SYSTEM_DM_WORKSPACE_ID`. Direction:
  workspace_kind='agent_home', `owner_agent_id UNIQUE REFERENCES
  agents(id) ON DELETE CASCADE`, agent_home workspace_path == agent
  L1 dir (NO extra L2), hard delete cascade on agent removal,
  migration splits existing global DM workspace per dm_channel and
  backfills `messages.task_workspace_id`. PR-5 stays pure service
  extraction (no DM projection in service); PR-6 starts after PR-5
  lands, drafted by @Alice. v1 accepts that retired agents lose DM
  history (archive/tombstone deferred).
- Agreed PR slicing:
  1. ChannelService (create + pin/unpin + workspace_channels_changed);
     replaces #109 patches.
  2. ConversationMessageService (insert/deliver/events/unread/parent
     thread_updated/attachment validation; user+agent share core).
  3. ThreadService = private `createThreadCore` + two public wrappers
     `createThreadFromMessage` / `createThreadFromAgent`.
  4. Move attachment upload route helper out of router closure
     (transport stays at edge, AttachmentService keeps `buffer` API).
  5. TaskService — collapse `*ByAgent`/`human*` into one fn per op
     with `actor` arg. Last because blast radius is large.
- Open with @Cindy (waiting on her ack):
  - agent send-message `target` resolution stays in service, not route
    (otherwise next caller forgets the closed/closed-of-target check).
  - sendMessage policies modeled as a `POLICIES[origin]` const table,
    not scattered `if origin==='user'` branches.
- Out of scope this round but noted for "全员状态变更" pass:
  removeWorkspaceMember (562-584), closeThread stop-children, and the
  provision.ts join/leaveWorkspace fan-out.

- Prior thread "Attachment 鉴权讨论": consensus reached, @Cindy owns
  task #110 implementation, @Alice reviews. See
  [notes/attachment-auth.md](notes/attachment-auth.md).

## Prior Context (kept for resume)
- Task #77 "Implement attachment application system" — in_progress, claimed by
  @Alice. Slices completed:
  - migration v15 (`attachments` table with channel_id CASCADE +
    source_conversation_id SET NULL)
  - shared DTOs / paths / schema (`AttachmentDto`, `AttachmentSnapshot`,
    `AttachmentLocateDto`, attachment_ids on send-message, upload/locate
    paths)
  - backend `AttachmentRepo` + `AttachmentService` (10MB limit, magic-byte
    sniff, sanitization, channel-scoped locate)
  - `MessageRepo.insertForConversation` accepts attachments → metadata, and
    surfaces typed `attachments` field on DTO
  - public routes: POST channel/thread attachments, GET attachment download
  - internal MCP routes: agent upload + agent locate (membership-checked)
  - send-message routes (user + agent) validate attachment_ids ↔ channel
  - ConversationManager `formatAttachmentSuffix()` integrated into live,
    inbox, and gated-batch formatters via shared MessageLite extension
  - chat-bridge: `upload_file`, `view_file` MCP tools + `attachment_ids` on
    `send_message`; client gains multipart upload + locate
  - platform-prompt: new "Attachments" section
  - renderer: `apiUpload`/`fetchAttachmentBlob` helpers, Composer file
    picker + drag-drop + chip preview + send wiring, MessageItem
    AttachmentList (image preview + chip)
  - tests: AttachmentRepo, AttachmentService, attachment routes;
    full suite still 272/272 green
  - docs/mcp-system.md updated with §5 Attachments + send_message extension
- Outstanding before marking #77 in_review: notify channel + flip task
  status; nothing else queued.
