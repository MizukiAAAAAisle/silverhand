# Project Notes

## Product Model
- Silverhand is an Electron desktop app that orchestrates Claude/Codex agents in
  shared chat-style workspaces.
- Public model is workspace -> channel -> thread. Internal backend code uses a
  conversation abstraction for channels, DM channels, and threads.
- Tasks are claimable work units with status flow todo -> in_progress ->
  in_review -> done.

## Collaboration Roles
- Alice usually owns architecture planning and solution design.
- Cindy usually reviews Alice's plans, challenges weak assumptions, and may
  implement assigned backend or prompt slices.
- Non-trivial tasks should stop at in_review until the user approves done.

## Current Prompt Direction
- Onboarding notes are seeded for new agents.
- MEMORY.md should be a concise index and current handoff, not a task log.
- Durable details should be split into notes such as user-preferences, project,
  and work-log.
- Thread behavior is not being changed in the current prompt pass.

## Recent Architecture Baseline
- Workspace/channel/thread rename is the accepted public model.
- WebSocket replaced legacy conversation SSE for live updates. HTTP remains the
  snapshot/mutation path.
- Viewer-private events and unread/notification state should use viewer scope.
