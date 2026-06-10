export const apiPaths = {
  health: '/api/health',
  serverInfo: '/api/server/info',
  runtimes: '/api/runtimes',
  eventWebSocket: '/api/ws/events',

  // hosts
  hosts: '/api/hosts',
  /** D2 daemon-outbound WebSocket endpoint. The bundled desktop daemon
   *  presents `Authorization: Bearer <host_token>` during upgrade;
   *  this is host-token auth, not a user-session route. */
  hostConnect: '/api/hosts/connect',
  hostClaimOrCreate: '/api/hosts/claim-or-create',
  /** Soft-delete a host the caller owns (Stage B.4). Sets
   *  `hosts.revoked_at` and bulk-revokes every active row in
   *  `host_credentials` for that host in one transaction. Idempotent:
   *  re-revoking an already-revoked host still sweeps any straggler
   *  credentials but does not move the original tombstone timestamp.
   *  No row cascade — agents/conversations bound to the host are
   *  preserved; runtime placement fails closed instead. Bearer must
   *  be a user session bearer. */
  hostRevoke: (id: string) => `/api/hosts/${id}/revoke`,
  /** Rotate the long-lived credential for a host the caller owns
   *  (Stage B.4). Server applies a 60-second grace to the prior
   *  credential and mints a fresh long_lived row, returning the new
   *  cleartext token. The token is consumed by Electron main only —
   *  `assertApiProxyPath` blocks this route from the generic renderer
   *  proxy, and the desktop IPC strips the token from any value that
   *  crosses back to the renderer. */
  hostRotateToken: (id: string) => `/api/hosts/${id}/rotate-token`,
  /** v36 (#task:808): rename a host the caller owns. Body =
   *  `UpdateHostInput { display_label }`. Only `display_label` is
   *  mutable today; `name` is the stable identifier set at claim time. */
  host: (id: string) => `/api/hosts/${id}`,
  /** v36 (#task:808): dynamic host snapshot (OS / daemon version /
   *  registered agents + online state). Always HTTP 200 with tagged
   *  `availability` once owner ACL passes. 404 for missing / cross-user. */
  hostStatus: (id: string) => `/api/hosts/${id}/status`,

  // agents
  agents: '/api/agents',
  agent: (id: string) => `/api/agents/${id}`,
  /** #task:811 — flat tree of every visible file/directory under the
   *  agent home dir. The two-column AgentWorkspacePane drives left-side
   *  navigation off this list; `path` values are valid inputs to the
   *  read endpoint below. Path semantics are agent-home-rooted today; a
   *  future scope/workspace selector will be additive (see
   *  AgentWorkspaceTreeNodeSchema). */
  agentWorkspaceTree: (id: string) => `/api/agents/${id}/workspace/tree`,
  /** #task:811 — read one file from the agent home dir by virtual path.
   *  The `path` query param is parsed segment-by-segment and rejects
   *  empty / `.` / `..` / dotfile / NUL / backslash segments; symlinks
   *  (intermediate or leaf) and any escape from the agent-home base are
   *  fail-closed (404 not_found, never a leaked path). 64KB preview cap;
   *  the response carries `truncated` so the UI can surface a banner. */
  agentWorkspaceFile: (id: string) => `/api/agents/${id}/workspace/file`,
  agentRuntimeState: (id: string) => `/api/agents/${id}/runtime-state`,
  agentStop: (id: string) => `/api/agents/${id}/stop`,
  agentDeleteImpact: (id: string) => `/api/agents/${id}/delete-impact`,
  /** Public avatar fetch for any agent. Returns the blob bytes with a
   *  long immutable Cache-Control header (cache-busted via the
   *  `?v=updated_at` query param baked into `AgentDto.avatar_url`).
   *  Read gate matches `GET /api/agents/:id` (authed + agent exists);
   *  write gates (POST/DELETE) are creator-only via `canEditAgent`.
   *  Returns 404 when the agent has no avatar set. */
  agentAvatar: (id: string) => `/api/agents/${id}/avatar`,
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
  workspaceHumanMember: (id: string, userId: string) =>
    `/api/workspaces/${id}/members/users/${userId}`,
  workspaceHumanMemberRole: (id: string, userId: string) =>
    `/api/workspaces/${id}/members/users/${userId}/role`,
  /** Agent capability set within a workspace (graded-permissions cut 2).
   *  GET reads the effective set (any workspace viewer); PUT replaces it
   *  (owner/admin). */
  workspaceAgentCapabilities: (id: string, agentId: string) =>
    `/api/workspaces/${id}/agents/${agentId}/capabilities`,
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
  conversationLogDebug: (id: string) => `/api/conversations/${id}/log-debug`,

  /** Members (agents + humans) of any conversation by id (channel /
   *  dm_channel / thread). Backs the chat-header member chips. The
   *  shape is the same `MemberDto[]` rendered into the agent system
   *  prompt, so renderer + prompt see the same source of truth. Self
   *  is NOT filtered server-side: the renderer drops the current
   *  human viewer (UI-self) — agent self has no UI meaning here.
   *  Permission: `canViewConversation` (workspace member or
   *  conversation member). */
  conversationMembers: (id: string) => `/api/conversations/${id}/members`,
  /** Remove one agent from a channel/thread conversation. This only
   *  mutates the conversation membership edge; workspace membership and
   *  the agent row stay intact. */
  conversationAgentMember: (id: string, agentId: string) =>
    `/api/conversations/${id}/members/agents/${agentId}`,

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

  // legacy host-wide app settings. Runtime proxy is daemon-local now.
  settings: '/api/settings',

  // current viewer (the local human user). Pre-authentication the
  // endpoint returns the discriminated `RegistrationRequired` shape so
  // the renderer can mount the auth gate.
  users: '/api/users',
  me: '/api/me',
  meAvatar: '/api/me/avatar',
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

export const probePaths = {
  readyz: '/readyz',
} as const;

export const authPaths = {
  embeddedBootstrap: '/auth/embedded-bootstrap',
  signup: '/auth/signup',
  login: '/auth/login',
  logout: '/auth/logout',
} as const;

export const internalPaths = {
  /** Agent posts a chat message; backend writes + distributes. */
  agentSendConversationMessage: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/send-message`,
  /** Agent reports that a stale send was intentionally abandoned. */
  agentResolveStaleMessage: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/stale-message-resolution`,
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
  /** Agent adds an existing workspace member to its current channel. */
  agentAddConversationMember: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/members`,

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
  /** Agent asks the backend where/how to read an attachment. Embedded can
   *  return a zero-copy local path; remote-safe callers may use the
   *  paired download route and cache bytes locally. */
  agentLocateAttachment: (cid: string, aid: string, attachmentId: string) =>
    `/internal/conversations/${cid}/agents/${aid}/attachments/${attachmentId}/locate`,
  /** Agent downloads attachment bytes after locate has proved same-channel access. */
  agentDownloadAttachment: (cid: string, aid: string, attachmentId: string) =>
    `/internal/conversations/${cid}/agents/${aid}/attachments/${attachmentId}/download`,

  /** Agent uploads its own avatar (multipart). Token middleware enforces
   *  `principal.agentId === aid`, so the route is structurally self-only.
   *  PR-2 mirrors the public `POST /api/agents/:id/avatar` write path
   *  for the agent-self branch of `canEditAgent`. */
  agentUploadAvatar: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/avatar`,
  /** Agent clears its own avatar. Idempotent; returns the updated DTO.
   *  Token middleware enforces self-only as above. */
  agentDeleteAvatar: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/avatar`,

  /** Observability-only: CLI fire-and-forget upload of a pre-flight
   *  failure (parse / strict-flag / unknown-noun) that never reached
   *  any other internal route. Logged as `cli.preflight_failure` and
   *  excluded from the `cli.invoke` success-rate stats. Best-effort:
   *  CLI does not retry and does not surface failures from this call. */
  agentCliTrace: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/cli-trace`,

} as const;
