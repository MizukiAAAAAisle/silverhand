# Alice's Memory

## Identity
- Handle: @Alice
- Runtime: claude
- Channel: #silverhand (multi-agent channel)
- Session: "backend perf" (current)

## Status
- Role: architecture planning and technical solution design
- @Cindy's role: review/discuss proposals, surface potential issues
- **Updated (2026-05-05):** Do NOT blindly accept Cindy's critiques — evaluate each one seriously, adopt when valid, push back with reasoning when not. Goal = genuine debate → excellent outcome.
- Design emphasis: global perspective, modularity, clear module boundaries, impact analysis of changes.

## Channel Context
- Channel: #silverhand with @Cindy (codex) also present
- CONSENSUS.md is empty (no binding agreements yet)
- Current session: "v1 优化" — discussing UI/UX improvement tech proposals

## What I Know
- Previously had a DM session where user greeted in Chinese
- Silverhand is an Electron desktop app orchestrating Claude/Codex CLIs in chat channels

## Work History

### v1 优化 session — completed
All 7 UI/UX improvements shipped and approved.

### Incident 2026-05-04 — agent shutdown/resume/reconcile
Three bugs fixed, reviewed by Cindy, task #7 approved (done).

### Session sidebar PIN (task #16, in_review → pending user approval)
- Migration v9: `sessions.pinned_at INTEGER`
- `SessionRepo.pin()` validates top-level only; `unpin()`; `listForChannel` pinned-first ordering
- Routes: `POST/DELETE /api/sessions/:id/pin` (400 on child session)
- `usePinSession` hook; `SessionsSidebar` sibling-button pattern (no nested interactive)
- 213/213 tests pass, typecheck clean
- Backlog: focus-within / context menu for keyboard-only pin access
Root cause: `useSendMessage` had no optimistic update — message only appeared after full POST+SSE roundtrip.
Fixes:
- `onMutate`: append temp `MessageDto` to `['sessions', sid, 'messages']` cache immediately
- `onSuccess`: replace temp with real message, de-dup against SSE
- `onError`: rollback cache to `prev` (backlog: handle `prev === undefined` edge case with `prev ?? []` or `onSettled` invalidate)
- `Composer.submit()`: clear draft before mutate, restore on error
- Fixed `tempMsg` shape: `task_assignee: null` not flat fields (matched actual `MessageDto`)
- Fixed `MockClaudeEnvOverrides` missing `MOCK_CLAUDE_IGNORE_INTERRUPT?: '1'`
Status: done. typecheck clean, 197/197 tests pass. Cindy reviewed, user approved.

**Fixes:**
- Bug B: `initObserved` flag on AgentHandle — resume no longer skips first session_init
- Bug A: `before-quit` preventDefault + async shutdown; `stop(hard)` arms timers BEFORE writeLine, awaits child exit
- Bug C: `reconcileOnBoot` SIGKILL orphan pids on boot

**Tests:** 197/197, typecheck clean

**Post-ship backlog:**
- PID recycle cmdline validation in reconcile
- Process-group kill for chat-bridge if needed
- `agent_crashed` kind when notification list gets filtering UI

## Notes
- notes/ directory: will populate with project context details


7 UI improvements discussed with @Cindy. Finalized approach:

**Batch 1 (first):**
- Backend message ordering: insert → publish SSE → return → background auto-start. Fixes the real latency root cause.
- New channel activation: `setQueryData` immediately on `onSuccess` (not just invalidate), then `nav.toSession(channelId, onboarding_session_id)` directly.
- Textarea auto-resize: `useEffect([draft])` watching draft state, `el.scrollHeight` resize, capped at 192px.

**Batch 2:** AgentPicker unified component (chips + Radix Select), shared between CreateChannelDialog and CreateSessionDialog.

**Batch 3:** Notification system — use existing polling (`/api/notifications/unread`, 5s) as global channel (not new SSE endpoint). In-app toasts via `sonner`. Agent crashed: `SessionManager.start()` pre-spawn failure path publishes `agent_status {status:'crashed', reason:'spawn_error'}`. System notifications: renderer → preload → main, `mainWindow?.isFocused()`.

**Batch 4 (last):** Events view — URL query param for initial sessionId, IPC for updates, use `openChildSessionId ?? selectedSessionId`.

### Key Corrections from @Cindy
- Message latency root cause is backend awaiting auto-start before publishing, not HTTP/SSE roundtrip
- New channel: must `setQueryData` before invalidate or router bounces the route
- No channel-level SSE currently; global notification needs its own channel (chose polling)
- System notification path: renderer → main (not backend → IPC)
- Agent startup failure before handle creation won't trigger exit handler; needs explicit helper in start()
- Optimistic update query key: `['sessions', sid, 'messages']`, append order, local type extension for `pending`
- Events view: URL query param avoids IPC race condition on webContents.send before listener registers

### Verification Points (per batch)
- Batch 1: `pnpm typecheck` + manual verify message appears instantly, new channel jumps to onboarding session, textarea resizes
- Batch 2: typecheck + both dialogs behave consistently
- Batch 3: notification kind schema/migration test; polling dedup (same id fires once only); no toast when channel is active
- Batch 4: Events window cold-start (URL query) and already-open (IPC push) paths both tested

### Batch 5 — Agent activity indicator (task #10, in_review)
Feature: show activity bubble during long agent thinking (spinner + elapsed + stale fallback).

**Contract (from @Cindy):**
- `AgentRunStatus` = `starting | thinking | tool_running | idle | failed`
- `AgentRunState`: `runId/agentId/sessionId/status/startedAt/updatedAt/lastActivityAt/terminalReason?/detail?`
- SSE event kind: `agent_activity` (payload = full AgentRunState)
- Snapshot endpoint: `GET /api/sessions/:id/agent-run-states` → `{ states: AgentRunState[] }`
- Shared types in `packages/shared/src/api/dto.ts`, path in `packages/shared/src/api/paths.ts`

**Frontend changes (Alice, task #10 in_review):**
- `useSessionStream.ts`: added `agent_activity` to known events
- `features/sessions/hooks.ts`: `useAgentRunStates` — GET snapshot + SSE live updates, runId-guarded terminal removal
- `components/chat/AgentActivityBubble.tsx`: spinner/elapsed/stale bubble component
- `components/layout/SessionView.tsx`: wired into MessageList with `activeRunStates` prop

**Backend (Cindy, task #9, in_review):** done — 203/203 tests pass, typecheck clean. Covers reply/stop/crash/session_close paths + runId anti-stale-clear tests.

## Notes
- notes/ directory: will populate with project context details

### Task #46 — Chat render fixes (done, 2026-05-04)
- Bug 1: `.markdown-body ul/ol` lacked `list-style-type` (Tailwind preflight reset). Fixed in `global.css`.
- Bug 2: Shift+Enter newlines rendered as spaces in Markdown. Fixed by adding `remark-breaks` to `Markdown.tsx` remarkPlugins.
- Implemented by @Cindy, reviewed/approved by user.

### Search feature (session: message system, 2026-05-05) — done

Full search implemented. Backend was already complete (SearchRepo + GET /api/search + DTOs).
Frontend shipped:
- `router.ts` — `/chat/search` route, `toChatSearch` nav helper, ChatView type extended
- `Sidebar.tsx` — Search button (magnifying glass) above Saved, `searchActive`/`onSelectSearch` props
- `features/search/hooks.ts` — `useMessageSearch(filters)` with intent detection
- `components/layout/SearchPanel.tsx` — full search UI: query input, scope pills (All/Channels/DM), channel select, sender filter (user/agent), time range pickers, results list with highlight
- `App.tsx` — wired: `view === 'search'` renders `<SearchPanel>` with jump/navigate callbacks
- 246/246 tests, typecheck clean

## Session: backend perf (current)

### Issue: channel create/delete latency under active sessions

**Delete channel (Cindy, task #34, in_review)**:
- Root cause: `deleteChannel()` awaited `Promise.all(stopTasks)` where each `stop(hard)` waits for agent process exit (up to 10s SIGKILL escalation)
- Fix: HTTP 204 returned immediately after DB delete; stop+L2 cleanup run in background
- 225 tests pass

**Create channel (Alice, task #35, in_review)**:
- Root cause: `provisionChannel` step 3 (L1/L2 seeding) ran `ensureAgentL1Dir + seedAgentL2` sequentially per agent (N×T instead of T)
- Fix: separated sync DB writes (members.add — kept sequential) from async fs ops (Promise.all parallel)
- Also added `busy_timeout = 5000` pragma to `db.ts` as defensive measure
- New test: 3-agent channel creation verifies all L2 dirs seeded + delivers/starts correct
- 227/227 tests pass, typecheck clean
- Status: in_review, awaiting Cindy's review


4 fixes:
1. **Auto-scroll threshold**: `wasNearBottomRef` updated via `onScroll`, reset on `sessionId` change. Jump effect sets `wasNearBottomRef=false` explicitly. Auto-scroll effect reads ref (not post-render distFromBottom).
2. **Jump-then-scroll**: solved by same ref mechanism — after jump, ref=false until user scrolls back down.
3. **Pin hover**: removed `hover:bg-*`, added `group/pin` + `group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]` on icon.
4. **Task card layout**: outer `div` (not button) + jump `<button flex-1>` sibling + status pill `<div shrink-0>` — no button-in-button. Applied to both `ChannelTasksDialog` and `TasksSection`. Title has `min-w-0 break-words`.

### Electron drag region gotcha (2026-05-04)
- Titlebar has `drag-region` = `-webkit-app-region: drag` (global.css line 98)
- OS-level drag intercepts pointer events in the titlebar vertical band regardless of CSS z-index
- Any overlay/drawer whose top edge overlaps the titlebar MUST have `no-drag` class on its panel element
- Applied to `ChannelTasksDrawer.tsx` panel div — fixed dead X button + missing cursor:pointer

### Task #29 — Tasks drawer (in_review)
- New `ChannelTasksDrawer.tsx`: `fixed inset-y-0 right-0 z-50`, `translate-x-full` when closed, does NOT affect main layout
- Left-edge drag handle with inverted delta (`originWidth - dx`) persisted to `silverhand.layout.tasks-drawer-width` (340-900px default 520)
- Transparent click-away backdrop (no dim), Escape key to close, X button in header
- Content identical to ChannelTasksDialog (kanban + session strip), all copied in-file
- App.tsx: `tasksDialogOpen` → `tasksDrawerOpen`, import swapped to `ChannelTasksDrawer`

### Thread: Session sidebar unread badge (current thread)

**Design decisions (fully converged):**
- Two separate systems: `notifications` (mention_external/agent_start_failed alerts) vs `message unread` (session_reads cursor)
- `session_reads(user_id, session_id, last_read_seq INTEGER NOT NULL DEFAULT 0, read_at)` — cursor-based
- Unread filter: `seq > last_read_seq AND NOT (from_kind='user' AND (from_user_id=? OR from_user_id IS NULL))`
- Upsert via `ON CONFLICT DO UPDATE SET last_read_seq = max(existing, excluded)` — no INSERT OR REPLACE
- `POST /api/sessions/:id/mark-read` — no body; backend queries MAX(seq), resolver from header
- `GET /api/channels/:id/message-unread` → `{ by_session, total }`
- `GET /api/message-unread-summary` → `{ by_channel }` — global, for channel sidebar
- Viewer identity: frontend `CURRENT_USER_ID = 'local'` in `lib/current-user.ts` (single source); `api()` injects `X-Silverhand-User-Id` header; backend `requireViewerUserId(c)` extracts it; Repo receives as param, SQL uses `?`
- notifications.user_id NULL stays as legacy — not touched in this PR

**Task #50 (Alice, in_review) — Frontend COMPLETE:**
- `lib/current-user.ts` — CURRENT_USER_ID constant
- `lib/api.ts` — X-Silverhand-User-Id header injection
- `shared/api/paths.ts` — channelMessageUnread, sessionMarkRead, messageUnreadSummary
- `features/sessions/hooks.ts` — useMessageUnreadCounts, useMarkMessageSessionRead, useMessageUnreadSummary; old hooks deprecated
- `components/layout/SessionView.tsx` — useSessionStream subscription → markRead on 'message' SSE; split view parent+child each handle own cursor
- `App.tsx` — channel badge from messageUnreadSummary; nav effects mark both selectedSessionId + openChildSessionId; removed 5s polling watcher

**Task #51 (Cindy, in_progress) — Backend:**
- migration v10: session_reads table
- SessionReadRepo
- viewer header resolver (requireViewerUserId)
- GET /api/channels/:id/message-unread
- GET /api/message-unread-summary
- POST /api/sessions/:id/mark-read
- human send route: write from_user_id from header

**Shutdown parallelization** (`packages/backend/src/index.ts`):
- Phase 1: `stopAll()` (sequential, must finish before activity log)
- Phase 2: `server.close(cb)` → `closeAllConnections()` → `Promise.allSettled([closeActivityLog, serverDrained])` (parallel)
  - Order: `server.close` first (stop accepting), then `closeAllConnections` (terminate existing SSE/sockets) — no reconnect window
  - `closeAllConnections()` guarded by `'in' check` for Http2Server union
- Phase 3: `db.close()` (all connections already terminated, in-flight safety sacrificed for clean quit)
**Progress overlay** (`main/index.ts` → preload → `App.tsx`):
- `mainWindow.webContents.send('shutdown:progress', step)` at start and end of `backend.close()`
- Preload: `onShutdownProgress` IPC listener exposed
- Renderer: `shutdownStep` state drives a z-50 backdrop overlay with spinner
**Watchdog**: Expected in dev — safety net for truly wedged shutdowns. With `closeAllConnections`, normal quit no longer depends on watchdog.
