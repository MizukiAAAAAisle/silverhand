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
  /** Per-agent schedule list for the user-facing Agent panel. Backed by
   *  `ScheduleService.list` — same data the agent sees via the MCP
   *  `list_schedules` tool, but reachable from the host UI without an
   *  agent-principal context. */
  agentSchedules: (id: string) => `/api/agents/${id}/schedules`,
  /** User-initiated cancel of one of the agent's schedules. Cancel is
   *  legal from `pending` or `firing`; the route validates ownership by
   *  passing both ids into `ScheduleService.cancel(scheduleId, agentId)`,
   *  which surfaces `not_owner` (403) when the schedule belongs to a
   *  different agent — preventing UI mis-drag from cancelling somebody
   *  else's row. */
  agentScheduleCancel: (agentId: string, scheduleId: string) =>
    `/api/agents/${agentId}/schedules/${scheduleId}/cancel`,

  // workspaces / conversations (new workspace -> channel -> thread model)
  workspaces: '/api/workspaces',
  workspace: (id: string) => `/api/workspaces/${id}`,
  workspacePin: (id: string) => `/api/workspaces/${id}/pin`,
  workspaceMembers: (id: string) => `/api/workspaces/${id}/members`,
  workspaceMember: (id: string, agentId: string) =>
    `/api/workspaces/${id}/members/${agentId}`,
  workspaceChannels: (id: string) => `/api/workspaces/${id}/channels`,
  workspaceArchivedChannels: (id: string) =>
    `/api/workspaces/${id}/channels/archived`,
  /** Global flat archived-channel list across every workspace the
   *  caller can view. Backs the "Archived" chat-tool page (filters:
   *  workspace, archived date). Per-workspace endpoint above is still
   *  used by the workspace-scoped query path. */
  archivedChannels: '/api/archived-channels',
  channelMessages: (id: string) => `/api/channels/${id}/messages`,
  channelAgents: (id: string) => `/api/channels/${id}/agents`,
  channelAgentStart: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/start`,
  channelAgentStop: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/stop`,
  channelAgentClearSession: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/clear-session`,
  channelAgentRunStates: (id: string) => `/api/channels/${id}/agent-run-states`,
  channelClose: (id: string) => `/api/channels/${id}/close`,
  channelThreads: (id: string) => `/api/channels/${id}/threads`,
  channelStop: (id: string) => `/api/channels/${id}/stop`,
  channelResume: (id: string) => `/api/channels/${id}/resume`,
  channelMarkRead: (id: string) => `/api/channels/${id}/mark-read`,
  channelArchive: (id: string) => `/api/channels/${id}/archive`,
  conversationChannel: (id: string) => `/api/channels/${id}`,
  conversationChannelMessages: (id: string) => `/api/channels/${id}/messages`,
  conversationChannelAgents: (id: string) => `/api/channels/${id}/agents`,
  conversationChannelThreads: (id: string) => `/api/channels/${id}/threads`,
  thread: (id: string) => `/api/threads/${id}`,
  threadMessages: (id: string) => `/api/threads/${id}/messages`,
  threadAgents: (id: string) => `/api/threads/${id}/agents`,
  threadAgentStart: (id: string, agentId: string) =>
    `/api/threads/${id}/agents/${agentId}/start`,
  threadAgentStop: (id: string, agentId: string) =>
    `/api/threads/${id}/agents/${agentId}/stop`,
  threadAgentClearSession: (id: string, agentId: string) =>
    `/api/threads/${id}/agents/${agentId}/clear-session`,
  threadAgentRunStates: (id: string) => `/api/threads/${id}/agent-run-states`,
  threadClose: (id: string) => `/api/threads/${id}/close`,
  threadStop: (id: string) => `/api/threads/${id}/stop`,
  threadResume: (id: string) => `/api/threads/${id}/resume`,
  threadMarkRead: (id: string) => `/api/threads/${id}/mark-read`,

  /** Identity + routing metadata for ANY conversation by id (channel /
   *  dm_channel / thread). Backs cross-workspace secondary-pane
   *  resolution and the `#conv:<id>` sigil renderer. Returns
   *  `ConversationRefResponse`; does NOT include messages or per-user
   *  unread state. Permission: workspace member of the target
   *  conversation's workspace. */
  conversationRef: (id: string) => `/api/conversations/${id}/ref`,

  // attachments — upload via channel/thread context, download by id.
  // Each upload creates an independent blob (no de-dup).
  channelAttachments: (id: string) => `/api/channels/${id}/attachments`,
  threadAttachments: (id: string) => `/api/threads/${id}/attachments`,
  attachment: (id: string) => `/api/attachments/${id}`,

  /** Global message unread summary across all workspace/sidebar items.
   *  GET -> `{ by_workspace: Record<workspaceId, number> }` */
  messageUnreadSummary: '/api/message-unread-summary',

  // saved messages
  saved: '/api/saved',
  search: '/api/search',
  messageSave: (id: string) => `/api/messages/${id}/save`,

  // single message lookup — used by thread anchor preview to backfill
  // old rows whose metadata snapshot is missing (pre-PR4-fix data).
  message: (id: string) => `/api/messages/${id}`,

  // human-triggered child conversation ("Thread" on a chat message).
  // Per docs/app-layout.md §7.
  messageThread: (id: string) => `/api/messages/${id}/thread`,

  // host-wide app settings (proxy_url etc). Flat KV.
  settings: '/api/settings',

  // current viewer (the local human user). After PR-1 (V1 single
  // user), this resolves to the registered `users` row pointed at by
  // `app_settings.viewer_user_id`. Pre-registration the endpoint
  // returns the discriminated `RegistrationRequired` shape so the
  // renderer can mount the registration gate. In V2 multi-user the
  // same endpoints continue to work — only the principal source
  // changes from `app_settings` to session/token claims.
  me: '/api/me',
  meAvatar: '/api/me/avatar',
  /** One-shot identity registration. Sole creator of `users` rows —
   *  the renderer calls this on V1 first launch (when `/api/me`
   *  returned `registration_required: true`) and V2 will call it
   *  after auth signup. Atomically INSERTs the user row and writes
   *  `app_settings.viewer_user_id`. Returns 409 when the viewer has
   *  already registered. The pre-register gate whitelists only this
   *  route + `GET /api/me` + `GET /api/health`. */
  register: '/api/register',
  /** Public avatar fetch for any user. Returns the blob bytes (auth
   *  via the standard principal header). The DTO's `avatar_url`
   *  points here; renderer resolves it via the same auth-headers
   *  + blob URL pattern used by attachments. Returns 404 when the
   *  user has no avatar set. */
  userAvatar: (id: string) => `/api/users/${id}/avatar`,

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
  agentSendConversationMessage: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/send-message`,
  /** Agent spawns a Thread off the current channel. */
  agentCreateThread: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/create-thread`,
  /** Agent closes the current Thread. */
  agentCloseThread: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/close-thread`,
  /** Agent creates a new top-level channel in the same workspace. */
  agentCreateChannel: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/create-channel`,
  /** Agent reads anchored message history in its current/target conversation. */
  agentReadHistory: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/read-history`,
  /** Agent lists workspaces it currently has member access to (regular
   *  workspaces via `workspace_members` ∪ its own `agent_home`). */
  agentListWorkspaces: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/list-workspaces`,
  /** Agent lists channels of a workspace it is currently a member of.
   *  Defaults to the source conversation's workspace when no
   *  `workspace_id` query param is supplied. */
  agentListChannels: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/list-channels`,
  /** Agent searches messages visible from current/workspace/channel scope. */
  agentSearchMessages: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/search-messages`,

  // Canonical task endpoints used by the Silverhand CLI.
  agentListConversationTasks: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks`,
  agentCreateConversationTasks: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/create`,
  agentClaimConversationTasks: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/claim`,
  agentUnclaimConversationTask: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/unclaim`,
  agentUpdateConversationTaskStatus: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/update-status`,

  // Agent-owned schedules (cron-like reminders). Per-agent surface — no
  // channel/thread coupling — but the route is still hung off the
  // calling conversation so the agent principal middleware (which
  // resolves cid+aid → principal) can authenticate the request without
  // a second auth path.
  agentScheduleCreate: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/schedules`,
  agentScheduleList: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/schedules/list`,
  agentScheduleCancel: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/schedules/cancel`,

  /** Agent uploads a local file from its current channel/thread context.
   *  Backend resolves channel ownership from `cid`. */
  agentUploadAttachment: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/attachments`,
  /** Agent asks the backend where/how to read an attachment. Returns
   *  either a local path (zero-copy) or a download URL. */
  agentLocateAttachment: (cid: string, aid: string, attachmentId: string) =>
    `/internal/conversations/${cid}/agents/${aid}/attachments/${attachmentId}/locate`,

  /** Observability-only: CLI fire-and-forget upload of a pre-flight
   *  failure (parse / strict-flag / unknown-noun) that never reached
   *  any other internal route. Logged as `cli.preflight_failure` and
   *  excluded from the `cli.invoke` success-rate stats. Best-effort:
   *  CLI does not retry and does not surface failures from this call. */
  agentCliTrace: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/cli-trace`,

} as const;
