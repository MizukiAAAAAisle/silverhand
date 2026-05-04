export const apiPaths = {
  health: '/api/health',
  runtimes: '/api/runtimes',

  // hosts
  hosts: '/api/hosts',

  // agents
  agents: '/api/agents',
  agent: (id: string) => `/api/agents/${id}`,
  agentWorkspace: (id: string) => `/api/agents/${id}/workspace`,
  agentRuntimeState: (id: string) => `/api/agents/${id}/runtime-state`,
  agentStop: (id: string) => `/api/agents/${id}/stop`,
  agentDeleteImpact: (id: string) => `/api/agents/${id}/delete-impact`,

  // channels
  channels: '/api/channels',
  channel: (id: string) => `/api/channels/${id}`,
  channelArchive: (id: string) => `/api/channels/${id}/archive`,
  channelMembers: (id: string) => `/api/channels/${id}/members`,
  channelMember: (id: string, agentId: string) =>
    `/api/channels/${id}/members/${agentId}`,
  channelSessions: (id: string) => `/api/channels/${id}/sessions`,
  /** Per-session unread notification counts for a channel.
   *  GET → `{ counts: Record<sessionId, number> }` */
  channelUnreadBySession: (id: string) => `/api/channels/${id}/unread-by-session`,
  /** Per-session message unread counts for a channel (session_reads cursor).
   *  GET → `{ by_session: Record<sessionId, number>; total: number }` */
  channelMessageUnread: (id: string) => `/api/channels/${id}/message-unread`,
  /** Global message unread summary across all channels.
   *  GET → `{ by_channel: Record<channelId, number> }` */
  messageUnreadSummary: '/api/message-unread-summary',

  // sessions
  session: (id: string) => `/api/sessions/${id}`,
  sessionAgents: (id: string) => `/api/sessions/${id}/agents`,
  sessionAgentRunStates: (id: string) => `/api/sessions/${id}/agent-run-states`,
  sessionMessages: (id: string) => `/api/sessions/${id}/messages`,
  sessionEvents: (id: string) => `/api/sessions/${id}/events`,
  sessionStream: (id: string) => `/api/sessions/${id}/stream`,
  sessionClose: (id: string) => `/api/sessions/${id}/close`,
  sessionChildren: (id: string) => `/api/sessions/${id}/children`,
  /** Open-thread summary under a parent session — one row per open
   *  child with its anchor message id and reply count. Used by the UI
   *  to render the per-message "{count} Reply" badge. */
  sessionThreads: (id: string) => `/api/sessions/${id}/threads`,
  sessionStop: (id: string) => `/api/sessions/${id}/stop`,
  sessionResume: (id: string) => `/api/sessions/${id}/resume`,
  sessionArchive: (id: string) => `/api/sessions/${id}/archive`,
  /** Advance the viewer's read cursor to the latest message in the session.
   *  POST (no body required) → `{ last_read_seq: number }` */
  sessionMarkRead: (id: string) => `/api/sessions/${id}/mark-read`,

  // saved messages
  saved: '/api/saved',
  search: '/api/search',
  messageSave: (id: string) => `/api/messages/${id}/save`,

  // single message lookup — used by thread anchor preview to backfill
  // old rows whose metadata snapshot is missing (pre-PR4-fix data).
  message: (id: string) => `/api/messages/${id}`,

  // human-triggered child session ("Thread" on a chat message).
  // Per docs/app-layout.md §7.
  messageThread: (id: string) => `/api/messages/${id}/thread`,

  // host-wide app settings (proxy_url etc). Flat KV.
  settings: '/api/settings',

  // notifications (v1: cross-channel mention CC events)
  notifications: '/api/notifications',
  notificationsUnread: '/api/notifications/unread',
  notificationsRead: '/api/notifications/read',

  // tasks — human-facing list + mutation endpoints. Per
  // docs/tasks-design.md §6.2. Path key = message id (a task is a
  // message with task metadata).
  tasks: '/api/tasks',
  taskClaim: (messageId: string) => `/api/tasks/${messageId}/claim`,
  taskUnclaim: (messageId: string) => `/api/tasks/${messageId}/unclaim`,
  taskStatus: (messageId: string) => `/api/tasks/${messageId}/status`,
} as const;

export const internalPaths = {
  /** Agent posts a chat message; backend writes + distributes. */
  agentSendMessage: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/send-message`,
  /** Agent spawns a child session off the current one. */
  agentSpawnChild: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/spawn-child`,
  /** Agent closes the current session (must be a child or own). */
  agentCloseSession: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/close`,
  /** Agent creates a new top-level session in the same channel. */
  agentCreateSession: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/create-session`,

  // ── Task MCP tool endpoints (chat-bridge → backend) ──────────────
  // Scoped under (session_id, agent_id) so the backend can enforce
  // "you may only operate on your own session's tasks". See
  // docs/tasks-design.md §6.1.
  agentListTasks: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/tasks`,
  agentCreateTasks: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/tasks/create`,
  agentClaimTasks: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/tasks/claim`,
  agentUnclaimTask: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/tasks/unclaim`,
  agentUpdateTaskStatus: (sid: string, aid: string) =>
    `/internal/sessions/${sid}/agents/${aid}/tasks/update-status`,
} as const;
