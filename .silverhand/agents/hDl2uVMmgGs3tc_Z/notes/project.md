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
- Agent DMs are modeled as per-agent `agent_home` workspaces. An agent_home
  may contain multiple `dm_channel` roots; `owner_agent_id` is the ownership
  link, `workspace_members` remains regular-only, and `WorkspaceDto.dm_channel_id`
  is only a default landing channel pointer. New agent homes create an
  `Onboarding` default channel; migrated legacy `dm-<name>` channel titles are
  preserved for continuity. `WorkspaceDto.dm_channel_ids` carries every
  dm_channel id in the home as a navigation alias list for legacy callers.
- Avoid broad format churn and unrelated refactors when making narrow fixes.

## Application Service Direction
- Human HTTP routes and agent internal/MCP routes should not duplicate the same
  business side effects. Routes own auth and parameter translation; application
  services own inserts, fan-out, realtime publish, agent delivery/start, and
  notification-like side effects.
- Current extraction order: ChannelService including pin/unpin, then
  ConversationMessageService, ThreadService, attachment locate unification after
  task #110, and TaskService caller-kind consolidation.
- ChannelService PR-1 contract: regular workspaces only, agent actor must be a
  member of its source conversation in the same workspace, agent-created channel
  members are explicitly snapshotted from the current conversation by the route,
  seed messages are agent-only, and `workspace_channels_changed` must be
  published after commit for create/pin/unpin.
- ThreadService PR-3 contract: public wrappers are `createThreadFromMessage`,
  `createThreadFromAgent`, and `closeThread`; routes never call the private
  core or assemble seed side effects. Threads do not nest. Seed delivery/fanout
  is explicit per seed, DB mutations are transactional, realtime publish happens
  post-commit before best-effort delivery/start/stop, and agent close-thread
  requires the caller agent to be a member of the thread.
