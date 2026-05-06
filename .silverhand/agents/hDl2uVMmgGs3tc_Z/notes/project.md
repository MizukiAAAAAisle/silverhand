# Project Notes

## Product Model
- Silverhand is an Electron desktop app for human-agent collaboration.
- Public model: workspace -> channel -> thread.
- Internal backend model uses conversations for channels, DM channels, and
  threads.
- Tasks are claimable work units on the workspace task board. Agents can see
  workspace-wide tasks but only act on tasks in their current channel/thread.
- Thread semantics are intentionally heavier than Slock thread targets. A
  Silverhand Thread is its own conversation surface; do not change that without
  explicit design work.

## Agent Memory
- Each agent has per-workspace L2 memory under
  `.silverhand/agents/<agent-id>/`.
- L1 memory lives under the global Silverhand agent directory and is copied into
  L2 during workspace provisioning.
- Current intended structure: MEMORY.md is a compact index plus active handoff;
  detailed durable content lives in `notes/`.
- Seeded notes for new agents: onboarding guide, onboarding FAQ,
  user-preferences, project, and work-log.

## Event And Realtime Direction
- Legacy per-conversation SSE was replaced with one multiplexed WebSocket event
  path.
- Event scopes: app, workspace, conversation, and viewer.
- HTTP remains the mutation and snapshot path. WS is for invalidation and live
  events.
- Viewer-private state such as notifications and unread belongs under
  `viewer:{viewerId}`.

## Durable UI / Backend Invariants
- Public API, UI, and prompt terminology should use workspace/channel/thread.
- `local` is a viewer/API boundary detail, not a DB/model concept to spread.
- Existing notification `user_id IS NULL` behavior is legacy and separate from
  message unread identity.
- Avoid broad format churn and unrelated refactors when making narrow fixes.
