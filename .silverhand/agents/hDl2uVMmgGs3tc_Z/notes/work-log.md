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
