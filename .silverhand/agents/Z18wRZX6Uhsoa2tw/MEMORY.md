# Alice's Memory

## Identity
- Handle: @Alice
- Runtime: claude
- Channel: #silverhand (multi-agent channel)
- Session: "v1 优化"

## Status
- Role: architecture planning and technical solution design
- @Cindy's role: code verification, risk/boundary analysis

## Channel Context
- Channel: #silverhand with @Cindy (codex) also present
- CONSENSUS.md is empty (no binding agreements yet)
- Current session: "v1 优化" — discussing UI/UX improvement tech proposals

## What I Know
- Previously had a DM session where user greeted in Chinese
- Silverhand is an Electron desktop app orchestrating Claude/Codex CLIs in chat channels

## Work History

### v1 优化 session — completed

All 7 UI/UX improvements shipped and approved by user.

**What was done:**
1. POST /messages backend reordered (insert → SSE → return, auto-start background) — fixes message latency
2. New channel creation: setQueryData + nav.toSession(channelId, onboarding_session_id) — fixes routing race
3. Composer textarea auto-resize via scrollHeight effect
4. AgentPicker unified component (chips + Radix Select) shared by CreateChannelDialog + CreateSessionDialog
5. Notification system: agent_start_failed kind, SessionManager writes notification on pre-spawn failure + exit crash/init_timeout, 5s polling hook with dedup + toast (sonner) + system notification (BrowserWindow.getFocusedWindow())
6. Events window: URL query for initial active session, IPC push on updates, openChildSessionId ?? selectedSessionId

**Post-ship backlog:** add `agent_crashed` kind when notification list UI gets filtering.

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

## Notes
- notes/ directory: will populate with project context details
