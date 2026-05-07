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
- [notes/user-preferences.md](notes/user-preferences.md) — durable user
  preferences and collaboration rules.
- [notes/project.md](notes/project.md) — Silverhand architecture, terminology,
  invariants.
- [notes/work-log.md](notes/work-log.md) — compact dated work history.
- [notes/permission-system.md](notes/permission-system.md) — holistic
  permission system design (4-layer pipeline, Principal model, slice plan).
  Authoritative external doc: `docs/permissions.md`.
- [notes/attachment-auth.md](notes/attachment-auth.md) — locked v1 attachment
  auth design (downstream slice of permission system).
- [notes/agent-home-pr6.md](notes/agent-home-pr6.md) — per-agent agent_home
  workspace design (PR-6).
- [notes/channel-service-pr1.md](notes/channel-service-pr1.md),
  [notes/conversation-message-service-pr2.md](notes/conversation-message-service-pr2.md),
  [notes/thread-service-pr3.md](notes/thread-service-pr3.md),
  [notes/task-service-pr5.md](notes/task-service-pr5.md) — service-extraction
  PR drafts (all completed; see work-log for status).

## Active Context
- Channel: "Attachment 鉴权讨论" (forked from mcp system).
- Permission infra v1 — **all four slices done & mutually reviewed**:
  - **A' (#125)** principal model — done.
  - **#126 cleanup** — done.
  - **B (#127)** Bearer rollout to `/api/*` — done.
  - **D-skeleton (#128)** ACL function family + route placeholders — done.
  - **C (#110)** attachment GET ACL via `serveForViewer` — done.
- 409 backend tests pass; `pnpm -r typecheck` clean.
- User-side TODO (waiting): commit/PR strategy + manual smoke (Bearer 401,
  cross-channel attachment denial, normal upload/download path).
- Deferred (not now; documented in `notes/attachment-auth.md`):
  `human_workspace_members` table (gate for second human user / non-loopback),
  `attachment-view-token` (signed URL for `<img src>`), `attachment-share-link`,
  avatar/profile ACL.
