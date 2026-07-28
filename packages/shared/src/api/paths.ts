export const apiPaths = {
  health: '/api/health',
  serverInfo: '/api/server/info',
  runtimes: '/api/runtimes',
  eventWebSocket: '/api/ws/events',
  presence: '/api/presence',

  // hosts
  hosts: '/api/hosts',
  /** D2 daemon-outbound WebSocket endpoint. The bundled desktop daemon
   *  presents `Authorization: Bearer <host_token>` during upgrade;
   *  this is host-token auth, not a user-session route. */
  hostConnect: '/api/hosts/connect',
  /** Resolve a reveal-once user-managed connect token to the server-side host
   *  id. The id is not present in the copied command; the daemon calls this
   *  with `Authorization: Bearer <connect-token>` before opening the outbound
   *  websocket, then still authenticates the websocket with the same token. */
  hostConnectTokenResolve: '/api/hosts/connect-token/resolve',
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
  /** User-managed computer connect-token rotation. This is renderer-visible:
   *  the cleartext connect token is reveal-once in the response and must never
   *  be recoverable later. Desktop app-managed hosts continue using
   *  `hostRotateToken`, whose cleartext host_token belongs to Electron main. */
  hostRotateConnectToken: (id: string) => `/api/hosts/${id}/connect-token/rotate`,
  /** Disconnect the currently live daemon connection for a user-managed
   *  computer without rotating or revoking its credential. The same
   *  connection command remains valid and can reconnect later. */
  hostDisconnect: (id: string) => `/api/hosts/${id}/disconnect`,
  /** v36 (#task:808): rename a host the caller owns. Body =
   *  `UpdateHostInput { display_label }`. Only `display_label` is
   *  mutable today; `name` is the stable identifier set at claim time. */
  host: (id: string) => `/api/hosts/${id}`,
  /** Delete a user-managed computer together with everything rooted on it (its
   *  agents and its `regular` workspaces). Body = `HostDeleteInput`
   *  `{ cascade_dependents }`; without the flag a non-empty computer is refused
   *  with `has_dependents`. Unfinalized Add-computer drafts are naturally empty
   *  and use this same hard-delete path. */
  hostDelete: (id: string) => `/api/hosts/${id}`,
  /** Legacy alias for the Add-computer modal cancel path. */
  hostCancelPending: (id: string) => `/api/hosts/${id}`,
  /** What is persistently rooted on this computer: the agents placed on it and
   *  the `regular` workspaces whose files live on it. PERSISTENT OWNERSHIP —
   *  contrast `hostStatus`, which reports dynamic daemon/runtime availability. */
  hostResources: (id: string) => `/api/hosts/${id}/resources`,
  /** v36 (#task:808): dynamic host snapshot (OS / daemon version /
   *  registered agents + online state). Always HTTP 200 with tagged
   *  `availability` once owner ACL passes. 404 for missing / cross-user. */
  hostStatus: (id: string) => `/api/hosts/${id}/status`,
  /** Per-computer runtime availability catalog. The target daemon probes its
   *  own host-local resolver; server only dispatches and returns the result.
   *  `?force=1` bypasses the short resolver cache for manual refresh and
   *  create-time hard-block checks. */
  hostRuntimeCatalog: (id: string) => `/api/hosts/${id}/runtime-catalog`,
  /** Host-local proxy config. Server never stores proxy bytes; it dispatches
   *  get/set to the live daemon for the target computer. */
  hostProxyConfig: (id: string) => `/api/hosts/${id}/proxy-config`,

  // agents
  agents: '/api/agents',
  /** Create-form onBlur uniqueness probe. Static segment — MUST be
   *  registered before `agent(:id)` so it is not shadowed by the param route. */
  agentNameAvailability: '/api/agents/name-availability',
  agent: (id: string) => `/api/agents/${id}`,
  /** #task:811/#1190 — flat tree of every visible file/directory under the
   *  agent home dir by default, or under the agent's per-workspace L2 memory
   *  dir when `?workspace_id=` is supplied. The two-column
   *  AgentWorkspacePane/Browser drives left-side navigation off this list;
   *  `path` values are valid inputs to the read endpoint below. */
  agentWorkspaceTree: (id: string) => `/api/agents/${id}/workspace/tree`,
  /** #task:811/#1190 — read one file from the selected agent memory source
   *  (home/L1 by default, workspace L2 with `?workspace_id=`) by virtual path.
   *  The `path` query param is parsed segment-by-segment and rejects
   *  empty / `.` / `..` / dotfile / NUL / backslash segments; symlinks
   *  (intermediate or leaf) and any escape from the agent-home base are
   *  fail-closed (404 not_found, never a leaked path). Daemon-side preview cap;
   *  the response carries `truncated` so the UI can surface a banner. */
  agentWorkspaceFile: (id: string) => `/api/agents/${id}/workspace/file`,
  /** #task:1135 — read an agent's profile MCP config for the agent-pane
   *  "Profile MCP" section. Returns `{ raw: string | null }` (null when no
   *  `mcp.json`). Read requires `canEditAgent` (creator/self): raw mcp.json
   *  can carry secrets, so a non-editor viewer is 403'd even though
   *  `canViewAgent` would let them see the agent exists. The write path is
   *  agent-self-only via the internal CLI route — there is no public PUT. */
  agentProfileMcp: (id: string) => `/api/agents/${id}/profile/mcp`,
  /** Live-probe one of an agent's profile MCP servers (#task:1137). POST
   *  `{ server_name, include_tools? }`; returns a `McpProbeResult`. Same
   *  `canEditAgent` gate as the read mirror (a probe connects to the user's
   *  endpoint with their secrets) — a non-editor viewer is 403'd. The renderer
   *  (Test connection / List tools buttons) calls this. */
  agentProfileMcpProbe: (id: string) => `/api/agents/${id}/profile/mcp/probe`,
  agentRuntimeState: (id: string) => `/api/agents/${id}/runtime-state`,
  agentRuntime: (id: string) => `/api/agents/${id}/runtime`,
  agentStop: (id: string) => `/api/agents/${id}/stop`,
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
  workspaceLocalPaths: '/api/workspaces/local-paths',
  /** Create-form onBlur uniqueness probe. Static segment — MUST be
   *  registered before `workspace(:id)` so it is not shadowed. */
  workspaceNameAvailability: '/api/workspaces/name-availability',
  workspace: (id: string) => `/api/workspaces/${id}`,
  /** Personal ⭐ star toggle for the workspace rail (#task:1209). POST = star,
   *  DELETE = unstar. Viewer-scoped (writes the caller's sort state), gated by
   *  can-view — NOT shared/admin governance. Replaced the old admin-gated
   *  shared `/pin` route. */
  workspaceStar: (id: string) => `/api/workspaces/${id}/star`,
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
  /** Per-user (viewer-scoped) list sort state mutations (#task:1147).
   *  Read state is carried inline on the workspace / channel list responses;
   *  these only WRITE preferences. All viewer-scoped. */
  sortMode: '/api/sort/mode',
  sortOrder: '/api/sort/order',
  sortTouch: '/api/sort/touch',
  /** Personal ⭐ star toggle for a channel in the sidebar (#task:1209). POST =
   *  star, DELETE = unstar. Viewer-scoped, can-view gated — replaced the old
   *  admin-gated shared `/pin` route. */
  channelStar: (id: string) => `/api/channels/${id}/star`,
  channelMessages: (id: string) => `/api/channels/${id}/messages`,
  channelThreadFollowers: (id: string, rootMessageId: string) =>
    `/api/channels/${id}/threads/${rootMessageId}/followers`,
  channelThreadFollow: (id: string, rootMessageId: string) =>
    `/api/channels/${id}/threads/${rootMessageId}/follow`,
  channelAgents: (id: string) => `/api/channels/${id}/agents`,
  channelAgentStart: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/start`,
  channelAgentStop: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/stop`,
  channelAgentClearSession: (id: string, agentId: string) =>
    `/api/channels/${id}/agents/${agentId}/clear-session`,
  channelAgentRunStates: (id: string) => `/api/channels/${id}/agent-run-states`,
  channelClose: (id: string) => `/api/channels/${id}/close`,
  channelStop: (id: string) => `/api/channels/${id}/stop`,
  channelResume: (id: string) => `/api/channels/${id}/resume`,
  channelArchive: (id: string) => `/api/channels/${id}/archive`,
  /** Self-join a PUBLIC channel. POST, empty body — the caller is
   *  ALWAYS the joined member, so there is no target on the wire to forge. The
   *  only non-member channel mutation; a member of a private / dm_channel /
   *  archived target is rejected. Returns the same `{channel, is_member:true}`
   *  envelope as channel detail so the client can backfill its cache. */
  channelJoin: (id: string) => `/api/channels/${id}/join`,
  /** Self-LEAVE a channel — the symmetric counterpart of `channelJoin`. A human
   *  member removes THEMSELVES (empty body, no forgeable target). Member-only
   *  (a non-member's only mutation is Join); an archived channel or the last
   *  human of a private channel is rejected with a typed reason. */
  channelLeave: (id: string) => `/api/channels/${id}/leave`,
  conversationChannel: (id: string) => `/api/channels/${id}`,
  conversationChannelMessages: (id: string) => `/api/channels/${id}/messages`,
  conversationChannelAgents: (id: string) => `/api/channels/${id}/agents`,

  /** Identity + routing metadata for ANY conversation by id (channel /
   *  dm_channel). Backs cross-workspace secondary-pane
   *  resolution and the `#conv:<id>` sigil renderer. Returns
   *  `ConversationRefResponse`; does NOT include messages or per-user
   *  unread state. Permission: `canReadConversation` — the same
   *  public-aware read gate as channel detail + message history, i.e. a
   *  conversation member OR a workspace member browsing an ACTIVE PUBLIC
   *  channel. Workspace membership alone is NOT enough: a private channel
   *  / archived public channel / non-participant `dm_channel` in the
   *  viewer's own workspace all stay 403. */
  conversationRef: (id: string) => `/api/conversations/${id}/ref`,
  /** Per-channel reply-cluster ("Threads") discovery list (#task:1074).
   *  Takes a conversation id but only resolves channel / dm_channel; a
   *  legacy `kind='thread'` conversation is not channel-like → 404. */
  conversationThreads: (id: string) => `/api/conversations/${id}/threads`,
  /** Per-conversation per-viewer stream-unread read-model (#task:1226). The
   *  SINGLE client source of truth for thread / mainline "N new" + first-unread:
   *  the reply chip and the Threads list both read it, so the same fact never
   *  lives in two caches. Sparse (only threads with unread > 0). Refreshed
   *  ONLY by the viewer-scoped `unread_updated` WS signal — never inferred from
   *  message events (unread is server-scored). Human viewer-scoped. */
  conversationUnread: (id: string) => `/api/conversations/${id}/unread`,
  /** Per-(viewer, channel) ambient attention preference (#task:1227,
   *  docs/activity-lifecycle-v1.md §9.3). GET resolves the effective mode
   *  (default applied when unset); PUT is the ONLY surface that writes attention
   *  state (the channel `所有消息 / 仅提及` control) — it never touches
   *  delivery/follow. Regular channel only (dm_channel + thread 404 — a DM's
   *  unread is directed-grade, a thread's ambient is follow-driven). Human
   *  viewer-scoped. */
  conversationAttentionPreference: (id: string) =>
    `/api/conversations/${id}/attention-preference`,
  /** The viewer's Activity list (#task:1227, docs/activity-lifecycle-v1.md §9.3)
   *  — the `listActivity` projection (directed mentions/tasks ∪ positional
   *  unread ∩ `enter()`), already deduped + salience-sorted. Read-only,
   *  human viewer-scoped. Optional `?workspace_id=` filters to one workspace
   *  (the data model is global; v1 UI is per-workspace). */
  activity: '/api/activity',
  /** The viewer's flat global Favorites — the EXCLUSIVE global STARRED list
   *  (#task:1252, docs/list-sort-v1.md): a starred entity lives here and is moved
   *  OUT of its home list. A read projection of `user_sort_entry.starred_at`
   *  UNIONed across the workspace rail + every channel sidebar, plus the viewer's
   *  `list_key='favorites'` ordering state. The authoritative display order comes
   *  from `viewer_sort` (recent → home last_accessed_at / manual → rank); raw
   *  `items` order is only a deterministic fallback, NOT pre-sorted by starred_at.
   *  Read-only, human viewer-scoped, global (no workspace filter). */
  favorites: '/api/favorites',
  /** The single Attention eliminate primitive:
   *  every read-cleared Activity item collapses into one `observe(source_ref[])`
   *  use case that delegates the write back to the source aggregate (per-stream
   *  cursor / `notifications.read_at`). The legacy channel mark-read route was
   *  retired into this primitive (#task:1232). Owned by the Attention bounded
   *  context; human viewer-scoped. */
  attentionObserve: '/api/attention/observe',
  conversationLogDebug: (id: string) => `/api/conversations/${id}/log-debug`,
  conversationAgentActivity: (id: string, agentId: string) =>
    `/api/conversations/${id}/agents/${agentId}/activity`,

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
  /** Remove ANOTHER human from a channel (#task:1688). The third-party
   *  counterpart of `channelLeave`: same eligibility guards evaluated for the
   *  TARGET, plus workspace governance (`admin`) on the caller. Removing
   *  YOURSELF is not this route — `channelLeave` is, and it deliberately emits
   *  no system message. Workspace membership and the user row stay intact;
   *  only the conversation edge is removed. */
  conversationHumanMember: (id: string, userId: string) =>
    `/api/conversations/${id}/members/users/${userId}`,

  // attachments — upload via channel context, download by id.
  // Each upload creates an independent blob (no de-dup).
  channelAttachments: (id: string) => `/api/channels/${id}/attachments`,
  /** Distinct canonical-source senders for the channel Attachments panel's
   *  sender filter. Identity-only facets; same channel view permission as the
   *  list. A distinct path from the list route, and `attachment(:id)` lives
   *  under `/api/attachments`, so there is no route-ordering hazard. */
  channelAttachmentSenders: (id: string) => `/api/channels/${id}/attachments/senders`,
  attachment: (id: string) => `/api/attachments/${id}`,

  /** Global message unread summary across all workspace/sidebar items.
   *  GET -> `{ by_workspace: Record<workspaceId, number> }` */
  messageUnreadSummary: '/api/message-unread-summary',

  // saved messages
  saved: '/api/saved',
  search: '/api/search',
  messageSave: (id: string) => `/api/messages/${id}/save`,

  /** Message reactions (docs/reactions-design.md §5.1). POST adds, DELETE
   *  removes (both `{emoji}` in body); GET returns the lazy reactor detail
   *  (`{emoji, reactors:[{kind,id,display_name}]}[]`) for hover, kept off the
   *  message-window DTO per §6 perf. */
  messageReactions: (id: string) => `/api/messages/${id}/reactions`,

  // single message lookup — used by thread anchor preview to backfill
  // old rows whose metadata snapshot is missing (pre-PR4-fix data).
  message: (id: string) => `/api/messages/${id}`,

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

  /** #task:1664 — the desktop reports a layout-v2 migration failure that
   *  happened BEFORE any daemon could connect, on the next authenticated
   *  start. Body = `LayoutMigrationDiagnosticsReport` (closed enums, release
   *  versions, saturating counts — no free text, path, or id). User-session
   *  bearer; observability only (logged, not persisted); 204 on accept.
   *  Called by Electron main, never the renderer. */
  clientLayoutMigrationDiagnostics: '/api/client-diagnostics/layout-migration',

  // notifications (v1: cross-channel mention CC events)
  notifications: '/api/notifications',
  notificationsUnread: '/api/notifications/unread',
  notificationsRead: '/api/notifications/read',

  // tasks — human-facing list + mutation endpoints. Per
  // docs/tasks-design.md. Path key = task id (`tasks.id`); a task is a
  // first-class aggregate, not a message (v60).
  tasks: '/api/tasks',
  taskClaim: (taskId: string) => `/api/tasks/${taskId}/claim`,
  taskUnclaim: (taskId: string) => `/api/tasks/${taskId}/unclaim`,
  taskStatus: (taskId: string) => `/api/tasks/${taskId}/status`,
  /** Human edits a task's title/content (optimistic-concurrency CAS). */
  taskEdit: (taskId: string) => `/api/tasks/${taskId}/edit`,
  /** Human reads one task's full detail (content + provenance + nav). */
  taskDetail: (taskId: string) => `/api/tasks/${taskId}`,
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
  /** Agent creates a new top-level channel in the same workspace. */
  agentCreateChannel: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/create-channel`,
  /** Agent reads anchored message history in its current/target conversation. */
  agentReadHistory: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/read-history`,
  /** Agent voluntarily follows a reply cluster (thread = root message id),
   *  `source='manual'`. Idempotent; a new follow backfills thread history. */
  agentFollowThread: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/follow-thread`,
  /** Agent stops following a reply cluster; re-followed automatically on a
   *  later mention/reply (§5). */
  agentUnfollowThread: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/unfollow-thread`,
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
  /** Agent reacts to a message with an emoji (POST add / DELETE remove,
   *  `{message_id, emoji}` body). Requires the `send_messages` capability —
   *  reaction is a write (docs/reactions-design.md §1). */
  agentReactMessage: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/react-message`,

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
  /** Agent edits a task's title/content (optimistic-concurrency CAS). */
  agentEditConversationTask: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/edit`,
  /** Agent reads one task's full detail (content + provenance + source_ref). */
  agentGetConversationTaskDetail: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/tasks/detail`,

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

  /** Agent reads its own profile MCP config (#task:1135). Returns
   *  `{ raw: string | null }` — null when the agent has no `mcp.json`.
   *  Token middleware enforces `principal.agentId === aid` (self-only).
   *  Backs `silverhand profile mcp get` and the agent-pane "Profile MCP"
   *  view (the pane calls the public mirror on `/api/agents/:id`). */
  agentProfileMcpGet: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/profile/mcp`,
  /** Agent replaces its own profile MCP config (#task:1135). Body is the
   *  raw JSON text; the backend validates it (fail-loud `invalid_config`)
   *  before dispatching the atomic host write. Self-only as above.
   *  Backs `silverhand profile mcp set`. */
  agentProfileMcpSet: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/profile/mcp`,
  /** Agent live-probes one of its own profile MCP servers (#task:1137). Body
   *  is `{ server_name, include_tools? }`; returns a `McpProbeResult`. The
   *  daemon opens a one-shot connection and closes it. Self-only via the
   *  internal principal middleware. Backs `silverhand profile mcp probe`. */
  agentProfileMcpProbe: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/profile/mcp/probe`,

  /** Agent reads its own profile metadata (#task:1178). Returns an
   *  `AgentProfileDto` (display_name / description / avatar_url + identity).
   *  Token middleware enforces `principal.agentId === aid` (self-only).
   *  Backs `silverhand profile get`. The avatar bytes themselves are
   *  served by the existing `agentAvatar` route via `avatar_url`. */
  agentProfileGet: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/profile`,
  /** Agent updates its own profile (#task:1178) in ONE multipart request —
   *  `display_name` / `description` text fields plus an optional avatar
   *  action (`avatar_action=set` with a `file` part, or `avatar_action=
   *  clear`). One handler applies the whole edit atomically (no partial
   *  write) and the avatar bytes ride a `file` part so they never base64
   *  into JSON; the avatar service stays the MIME/size/storage validator.
   *  Same URL as the GET above (method-distinguished). Self-only as above.
   *  Returns the updated `AgentProfileDto`. Backs `silverhand profile
   *  update`. */
  agentProfileUpdate: (cid: string, aid: string) =>
    `/internal/conversations/${cid}/agents/${aid}/profile`,

} as const;
