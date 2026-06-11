import { useCallback, useMemo } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import type { AppSection } from '@/components/layout/NavRail';

interface ThreadRouteOptions {
  fullscreen?: boolean;
}

/**
 * Single source of truth for our URL scheme. Keep all path templates
 * here so callers don't sprinkle string concatenation across the
 * codebase.
 *
 * Naming: workspace (outer container) → channel (conversation) → thread (nested).
 * Route shape: /chat/w/:workspaceId/c/:channelId/t/:threadId
 *
 * Secondary pane (PR-1 generic side-pane): the right-hand pane is no
 * longer thread-only. URL-level model:
 *
 *   1. `?side=<conversation_id>`  — opens that conversation in the right
 *      pane as an *overlay* on top of the current base path. The base
 *      path (including any `/t/<threadId>`) is NOT touched, so closing
 *      the side pane simply removes `?side` and the previous thread (if
 *      any) reappears.
 *   2. `/t/<threadId>` (legacy)  — keeps working as a thread fallback
 *      when no `?side` is present. Sidebar / "Thread" button still write
 *      this form. `?side` wins when both are present.
 *   3. `?fullscreen=1`  — applies to whichever pane is "secondary" by the
 *      priority above (side > thread). When fullscreen is set with
 *      neither side nor thread, it is a no-op (primary already fills the
 *      viewport).
 *
 * Priority table:
 *
 *   ┌─────────┬─────────┬───────────────┬────────────────────┐
 *   │ ?side   │ /t/:tid │ ?fullscreen=1 │ Render result       │
 *   ├─────────┼─────────┼───────────────┼────────────────────┤
 *   │ x       │ —       │ —             │ split: primary │ x  │
 *   │ x       │ y       │ —             │ split: primary │ x  │ (side wins)
 *   │ —       │ y       │ —             │ split: primary │ y  │
 *   │ x       │ —       │ 1             │ fullscreen x        │
 *   │ x       │ y       │ 1             │ fullscreen x        │
 *   │ —       │ y       │ 1             │ fullscreen y        │
 *   │ —       │ —       │ —             │ primary only        │
 *   │ —       │ —       │ 1             │ primary only        │ (no-op)
 *   └─────────┴─────────┴───────────────┴────────────────────┘
 *
 * Closing the side overlay should clear ONLY `?side` (and `?fullscreen`
 * if it was tied to the side); the base path stays so a previously-open
 * thread reappears as fallback.
 */
export const routes = {
  home: () => '/',
  chat: () => '/chat',
  chatSearch: () => '/chat/search',
  chatSaved: () => '/chat/saved',
  chatArchived: () => '/chat/archived',
  chatWorkspace: (workspaceId: string) => `/chat/w/${workspaceId}`,
  chatChannel: (workspaceId: string, channelId: string) =>
    `/chat/w/${workspaceId}/c/${channelId}`,
  chatThread: (
    workspaceId: string,
    channelId: string,
    threadId: string,
    options: ThreadRouteOptions = {},
  ) => {
    const path = `/chat/w/${workspaceId}/c/${channelId}/t/${threadId}`;
    return options.fullscreen ? `${path}?fullscreen=1` : path;
  },
  members: () => '/members',
  membersAgent: (agentId: string) => `/members/${agentId}`,
  // Distinct prefix for users so a user id can never collide with the
  // agent id namespace at the URL level. The MembersPanel writes this
  // when a HUMANS row is clicked; AgentView and HumanView are then
  // mutually exclusive at the App level (parseRouteState produces one
  // of agentId / userId, never both).
  membersUser: (userId: string) => `/members/u/${userId}`,
  computers: () => '/computers',
  tasks: () => '/tasks',
  settings: () => '/settings',
} as const;

export const routePatterns = {
  chatThread: '/chat/w/:workspaceId/c/:channelId/t/:threadId',
  chatChannel: '/chat/w/:workspaceId/c/:channelId',
  chatWorkspace: '/chat/w/:workspaceId',
  chatArchived: '/chat/archived',
  chatSearch: '/chat/search',
  chatSaved: '/chat/saved',
  chat: '/chat',
  membersAgent: '/members/:agentId',
  membersUser: '/members/u/:userId',
  members: '/members',
  computers: '/computers',
  tasks: '/tasks',
  settings: '/settings',
} as const;

export type ChatView = 'channel' | 'saved' | 'search' | 'archived';

/**
 * Resolved view of the current URL. Components read this instead of
 * useState — single hook keeps the parsing in one place.
 */
export interface RouteState {
  section: AppSection;
  /** Within the chat section: 'channel' or 'saved'. */
  chatView: ChatView;
  workspaceId: string | null;
  channelId: string | null;
  threadId: string | null;
  /** Generic side-pane pointer (`?side=<conversation_id>`). May be any
   *  conversation id (channel/thread/dm). PR-1 only resolves ids that
   *  exist in the current workspace's channels union; cross-workspace
   *  resolution lands in PR-2 with `useConversationById`. */
  sideConversationId: string | null;
  /** Reply-cluster pane pointer (`?cluster=<root_message_id>`). When set,
   *  the right pane shows that main-line message's reply cluster (root +
   *  replies sharing the parent channel context). A cluster is NOT a
   *  conversation, so this is a message id, not a conversation id — it is
   *  resolved against the current channel (`channelId`), never the
   *  workspace conversation union. Mutually exclusive with
   *  `sideConversationId` at the nav layer (opening one clears the other);
   *  `?side` wins if both somehow coexist. */
  clusterRootId: string | null;
  /** Tasks-drawer focus pointer (`?task=<task_number>`). When set, the
   *  drawer opens to "all" filter and scrolls/highlights the row. The
   *  number is workspace-scoped — resolution uses the workspace of the
   *  message the sigil appears in (see `TaskRefContext`). PR-4. */
  focusedTaskNumber: number | null;
  /** Raw `?fullscreen=1` flag. Applies to whichever pane is secondary
   *  by the side > thread priority. */
  fullscreen: boolean;
  /** Back-compat shorthand: `fullscreen && /t/:tid present && no ?side`.
   *  Keeps existing thread-fullscreen consumers wired without forcing
   *  every call site to re-derive. New code should prefer reading
   *  `fullscreen` + `secondaryDescriptor` from App-level selectors. */
  threadFullscreen: boolean;
  agentId: string | null;
  /** Set when the URL is `/members/u/:userId`. Mutually exclusive with
   *  `agentId` (the patterns are disjoint by segment count). The
   *  members section's right-pane branches on whichever is non-null. */
  userId: string | null;
}

/**
 * Pure URL → RouteState parser. Exported for unit testing — the React
 * hook below is just `parseRouteState(useLocation())`. Keeping this
 * separate avoids spinning up a router in tests.
 */
export function parseRouteState(pathname: string, search: string): RouteState {
  const mThread = matchPath(routePatterns.chatThread, pathname);
  const mChannel = matchPath(routePatterns.chatChannel, pathname);
  const mWorkspace = matchPath(routePatterns.chatWorkspace, pathname);
  // Order matters: the user route is more specific (`/members/u/:userId`,
  // three segments) than the agent route (`/members/:agentId`, two
  // segments), and matchPath returns the first match. Trying the user
  // pattern first means `/members/u/foo` resolves cleanly. The patterns
  // are still disjoint by segment count — `/members/:agentId` will not
  // match a three-segment URL — but checking explicitly keeps intent
  // visible to the next reader.
  const mUser = matchPath(routePatterns.membersUser, pathname);
  const mAgent = mUser ? null : matchPath(routePatterns.membersAgent, pathname);

  const workspaceId =
    mThread?.params.workspaceId ??
    mChannel?.params.workspaceId ??
    mWorkspace?.params.workspaceId ??
    null;
  const channelId =
    mThread?.params.channelId ?? mChannel?.params.channelId ?? null;
  const threadId = mThread?.params.threadId ?? null;
  const searchParams = new URLSearchParams(search);
  const fullscreen = searchParams.get('fullscreen') === '1';
  const rawSide = searchParams.get('side');
  // Defensive: empty string treated as unset; prevents `?side=` from
  // forcing an "unresolved secondary" placeholder.
  const sideConversationId = rawSide && rawSide.length > 0 ? rawSide : null;
  const rawCluster = searchParams.get('cluster');
  // Defensive: empty string treated as unset (mirrors `?side`). The value
  // is a main-line message id whose reply cluster the right pane shows.
  const clusterRootId = rawCluster && rawCluster.length > 0 ? rawCluster : null;
  const rawTask = searchParams.get('task');
  // Defensive: positive-integer-string only — no leading zeros, no
  // decimals, no trailing garbage. `parseInt` would silently accept
  // `12abc` as 12 and `1.5` as 1, both of which point at a row the
  // user did not ask for. The strict regex matches the contract that
  // `?task=<n>` came from `nav.openTask(n)` writing
  // `String(taskNumber)` against an integer task_number, with a hand-
  // typed/foreign URL falling through to null.
  const focusedTaskNumber =
    rawTask !== null && /^[1-9]\d*$/.test(rawTask) ? Number(rawTask) : null;
  const threadFullscreen =
    fullscreen && !!threadId && !sideConversationId;

  let section: AppSection = 'chat';
  if (pathname.startsWith('/members')) section = 'members';
  else if (pathname.startsWith('/computers')) section = 'computers';
  else if (pathname.startsWith('/tasks')) section = 'tasks';
  else if (pathname.startsWith('/settings')) section = 'settings';

  const chatView: ChatView = pathname.startsWith('/chat/saved')
    ? 'saved'
    : pathname.startsWith('/chat/search')
      ? 'search'
      : pathname.startsWith('/chat/archived')
        ? 'archived'
        : 'channel';

  return {
    section,
    chatView,
    workspaceId: workspaceId ?? null,
    channelId: channelId ?? null,
    threadId: threadId ?? null,
    sideConversationId,
    clusterRootId,
    focusedTaskNumber,
    fullscreen,
    threadFullscreen,
    agentId: mAgent?.params.agentId ?? null,
    userId: mUser?.params.userId ?? null,
  };
}

export function useRouteState(): RouteState {
  const { pathname, search } = useLocation();
  return parseRouteState(pathname, search);
}

/**
 * Build a URL with `?side` written or cleared. Pure helper so the nav
 * hook can stay tiny and tests can assert URL shape without React.
 *
 * Rules:
 *  - `id == null`     → strip `?side` AND `?fullscreen` (closing side
 *                       removes both; if a `/t/<tid>` thread is still in
 *                       the path it falls back to non-fullscreen split).
 *  - `id !== null`    → set `?side=<id>`, leave other params untouched.
 *  - Non-relevant query params (anything other than `side` / `fullscreen`)
 *    are preserved verbatim.
 */
export function withSideQuery(
  pathname: string,
  search: string,
  id: string | null,
): string {
  const params = new URLSearchParams(search);
  if (id == null) {
    params.delete('side');
    params.delete('fullscreen');
  } else {
    params.set('side', id);
  }
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}

/**
 * Build a base-path navigation URL that preserves the current `?side`
 * overlay. Used by "View in channel" on the secondary pane so jumping
 * the *primary* to the foreign-workspace parent doesn't drop the side
 * thread the user is reading.
 *
 * Rationale: `nav.toChannel(wid, cid)` calls `routes.chatChannel(...)`
 * which hands `navigate()` a fresh path with no query string, stripping
 * `?side`. For the cross-workspace `?side=<thread>` flow, the user's
 * intent is "show me the parent channel of this thread" — the side
 * overlay must survive. PR-2 fix per Cindy review of msg
 * `tEZtWtHiHzpq8PxC`: previously this case closed the side because
 * `handleJumpToMessage`'s preserveThreadLayout early-return only fires
 * for same-workspace + same-channel + open path-thread.
 *
 * `?fullscreen` is intentionally NOT preserved — fullscreen + visible
 * primary is contradictory, and the user just asked to see the primary.
 */
export function buildChannelPathPreservingSide(
  workspaceId: string,
  channelId: string,
  sideConversationId: string,
): string {
  const params = new URLSearchParams();
  params.set('side', sideConversationId);
  return `${routes.chatChannel(workspaceId, channelId)}?${params.toString()}`;
}

/**
 * Build a URL with `?task` written or cleared. Pure helper so the nav
 * hook can stay tiny and tests can assert URL shape without React.
 *
 * Rules:
 *  - `taskNumber == null` → strip `?task`. Other params (`side`,
 *    `fullscreen`, …) are preserved verbatim.
 *  - `taskNumber !== null` → set `?task=<n>`. Validation (positive
 *    integer, exists in workspace) lives in `parseRouteState` and the
 *    drawer's focus effect; this writer is dumb on purpose.
 */
export function withTaskQuery(
  pathname: string,
  search: string,
  taskNumber: number | null,
): string {
  const params = new URLSearchParams(search);
  if (taskNumber == null) {
    params.delete('task');
  } else {
    params.set('task', String(taskNumber));
  }
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}

/**
 * Build the URL written by `openTask(taskNumber)`. Sets `?task=<n>` on
 * the current location, preserving any base path and other query params
 * (`side`, `fullscreen`). The drawer reads `focusedTaskNumber` from the
 * resulting RouteState and uses it to (a) override its conversation
 * filter to "all" so the row is reachable and (b) scroll-and-highlight
 * the target row.
 *
 * Mirrors `buildSideOpenUrl` in spirit — purely additive on the URL,
 * with closing handled by `withTaskQuery(..., null)`.
 */
export function buildTaskOpenUrl(
  pathname: string,
  search: string,
  taskNumber: number,
): string {
  return withTaskQuery(pathname, search, taskNumber);
}

/**
 * Build the URL written by `openSide(conversationId)`. Sets `?side=<id>`
 * AND strips `?fullscreen=1` — sigil clicks promise "side pane, doesn't
 * replace your main view" (see platform-prompt's "Referencing
 * conversations in chat"). If we let openSide inherit a previous
 * fullscreen flag (e.g. user was in a fullscreen thread),
 * `shouldSecondaryFullscreen` would render ONLY the side, hiding both
 * the channel and the thread the user was reading. PR-4 review finding
 * by @Cindy.
 *
 * Other params (including `/t/<tid>` on the path) are preserved so
 * closeSide falls back to whatever was below.
 */
export function buildSideOpenUrl(
  pathname: string,
  search: string,
  conversationId: string,
): string {
  const params = new URLSearchParams(search);
  params.set('side', conversationId);
  params.delete('fullscreen');
  // Side and cluster are mutually exclusive secondary panes — opening the
  // side overlay closes any open reply cluster. No-op when `?cluster` is
  // absent, so existing side-pane URLs are unaffected.
  params.delete('cluster');
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Build a URL with `?cluster` written or cleared. Pure helper mirroring
 * `withSideQuery` so the nav hook stays tiny and tests can assert URL
 * shape without React.
 *
 * Rules:
 *  - `rootMessageId == null` → strip `?cluster` AND `?fullscreen` (closing
 *    the cluster removes the secondary pane; a `/t/<tid>` left on the path
 *    falls back to a non-fullscreen split).
 *  - `rootMessageId !== null` → set `?cluster=<id>`, strip `?side` and
 *    `?fullscreen` (cluster is a fresh secondary pane, mutually exclusive
 *    with the side overlay).
 *  - Other query params (`task`, …) are preserved verbatim.
 */
export function withClusterQuery(
  pathname: string,
  search: string,
  rootMessageId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (rootMessageId == null) {
    params.delete('cluster');
    params.delete('fullscreen');
  } else {
    params.set('cluster', rootMessageId);
    params.delete('side');
    params.delete('fullscreen');
  }
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}

/**
 * Build the URL written by `openCluster(rootMessageId)`. Sets
 * `?cluster=<id>`, clearing the side overlay + fullscreen so the reply
 * cluster takes the secondary pane cleanly. Thin wrapper over
 * `withClusterQuery` for call-site symmetry with `buildSideOpenUrl`.
 */
export function buildClusterOpenUrl(
  pathname: string,
  search: string,
  rootMessageId: string,
): string {
  return withClusterQuery(pathname, search, rootMessageId);
}

/**
 * Typed navigation helpers. All call sites that previously did
 * `setSelectedX` go through these — keeps URL construction in one
 * place and gives the call sites a self-documenting API.
 */
export function useNav(): {
  go: (to: string, opts?: { replace?: boolean }) => void;
  toChat: () => void;
  toChatSearch: () => void;
  toChatSaved: () => void;
  toChatArchived: () => void;
  toWorkspace: (workspaceId: string) => void;
  toChannel: (workspaceId: string, channelId: string) => void;
  toThread: (
    workspaceId: string,
    channelId: string,
    threadId: string,
    opts?: ThreadRouteOptions & { replace?: boolean },
  ) => void;
  toMembers: (agentId?: string) => void;
  /** Navigate the members section to a human's profile by user id.
   *  Mutually exclusive with the agent form — only one of agentId /
   *  userId is meaningful at a time. */
  toMembersUser: (userId: string) => void;
  toComputers: () => void;
  toTasks: () => void;
  toSettings: () => void;
  /** Open `conversationId` as the right-side overlay. Writes `?side=<id>`
   *  to the current URL via `replace` so opening a side pane doesn't
   *  pile entries into history. The base path (`/chat/w/.../c/...` and
   *  any `/t/<tid>`) is preserved verbatim so closing the overlay
   *  restores whatever was below it. */
  openSide: (conversationId: string) => void;
  /** Close the side overlay. Strips `?side` (and `?fullscreen`) from the
   *  current URL; the base path's thread, if any, becomes the secondary
   *  again. `replace` so the user's back button doesn't have to step
   *  through every overlay open/close. */
  closeSide: () => void;
  /** Open the reply cluster for `rootMessageId` in the right pane. Writes
   *  `?cluster=<id>` (clearing `?side`/`?fullscreen`) via `replace` so it
   *  doesn't pile history entries. The base path is preserved so closing
   *  restores whatever was below. */
  openCluster: (rootMessageId: string) => void;
  /** Close the reply-cluster pane. Strips `?cluster` (and `?fullscreen`);
   *  the base path's thread, if any, becomes secondary again. */
  closeCluster: () => void;
  /** Focus a task in the workspace tasks drawer by writing `?task=<n>`.
   *  The drawer auto-opens, switches to "all" filter, scrolls the row
   *  into view, and applies a brief highlight. `replace` so re-clicking
   *  task chips doesn't pile history entries. */
  openTask: (taskNumber: number) => void;
  /** Clear the focused-task pointer (`?task`). Drawer can stay open via
   *  its own React state — closing the URL focus is independent of
   *  open/close. */
  closeTask: () => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const go = useCallback(
    (to: string, opts?: { replace?: boolean }) =>
      navigate(to, { replace: opts?.replace ?? false }),
    [navigate],
  );
  const openSide = useCallback(
    (conversationId: string) => {
      const next = buildSideOpenUrl(
        location.pathname,
        location.search,
        conversationId,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeSide = useCallback(() => {
    const next = withSideQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const openCluster = useCallback(
    (rootMessageId: string) => {
      const next = buildClusterOpenUrl(
        location.pathname,
        location.search,
        rootMessageId,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeCluster = useCallback(() => {
    const next = withClusterQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const openTask = useCallback(
    (taskNumber: number) => {
      const next = buildTaskOpenUrl(
        location.pathname,
        location.search,
        taskNumber,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeTask = useCallback(() => {
    const next = withTaskQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const toChat = useCallback(() => go(routes.chat()), [go]);
  const toChatSearch = useCallback(() => go(routes.chatSearch()), [go]);
  const toChatSaved = useCallback(() => go(routes.chatSaved()), [go]);
  const toChatArchived = useCallback(() => go(routes.chatArchived()), [go]);
  const toWorkspace = useCallback((id: string) => go(routes.chatWorkspace(id)), [go]);
  const toChannel = useCallback(
    (wid: string, cid: string) => go(routes.chatChannel(wid, cid)),
    [go],
  );
  const toThread = useCallback(
    (
      wid: string,
      cid: string,
      tid: string,
      opts: ThreadRouteOptions & { replace?: boolean } = {},
    ) =>
      go(routes.chatThread(wid, cid, tid, opts), { replace: opts.replace }),
    [go],
  );
  const toMembers = useCallback(
    (agentId?: string) =>
      go(agentId ? routes.membersAgent(agentId) : routes.members()),
    [go],
  );
  const toMembersUser = useCallback(
    (userId: string) => go(routes.membersUser(userId)),
    [go],
  );
  const toComputers = useCallback(() => go(routes.computers()), [go]);
  const toTasks = useCallback(() => go(routes.tasks()), [go]);
  const toSettings = useCallback(() => go(routes.settings()), [go]);

  return useMemo(() => ({
    go,
    toChat,
    toChatSearch,
    toChatSaved,
    toChatArchived,
    toWorkspace,
    toChannel,
    toThread,
    toMembers,
    toMembersUser,
    toComputers,
    toTasks,
    toSettings,
    openSide,
    closeSide,
    openCluster,
    closeCluster,
    openTask,
    closeTask,
  }), [
    go,
    toChat,
    toChatSearch,
    toChatSaved,
    toChatArchived,
    toWorkspace,
    toChannel,
    toThread,
    toMembers,
    toMembersUser,
    toComputers,
    toTasks,
    toSettings,
    openSide,
    closeSide,
    openCluster,
    closeCluster,
    openTask,
    closeTask,
  ]);
}
