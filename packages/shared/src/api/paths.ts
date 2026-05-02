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
  channelMembers: (id: string) => `/api/channels/${id}/members`,
  channelMember: (id: string, agentId: string) =>
    `/api/channels/${id}/members/${agentId}`,
  channelSessions: (id: string) => `/api/channels/${id}/sessions`,

  // sessions
  session: (id: string) => `/api/sessions/${id}`,
  sessionAgents: (id: string) => `/api/sessions/${id}/agents`,
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

  // saved messages
  saved: '/api/saved',
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
} as const;
