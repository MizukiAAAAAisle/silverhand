import { useCallback, useMemo } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import type { AppSection } from '@/components/layout/NavRail';

/**
 * Single source of truth for our URL scheme. Keep all path templates
 * here so callers don't sprinkle string concatenation across the
 * codebase.
 *
 * Naming: workspace (outer container) → channel (conversation). The base
 * path is `/chat/w/:workspaceId/c/:channelId`. There is no path-level
 * thread segment — the legacy isolated-thread `/t/<threadId>` fossil pane
 * was retired (the reply-cluster model replaces it). The right-hand
 * "secondary" pane is driven entirely by query params:
 *
 *   1. `?side=<conversation_id>`  — opens that conversation in the right
 *      pane as an *overlay* on top of the current base path. The base
 *      path is NOT touched, so closing the side pane simply removes
 *      `?side`.
 *   2. `?thread=<root_message_id>`  — opens that main-line message's
 *      thread (reply cluster) in the right pane.
 *   3. `?threads=1`  — opens the channel Threads-list pane.
 *   4. `?fullscreen=1`  — applies to whichever pane is "secondary" by the
 *      priority side > thread > threads-list. When fullscreen is set with
 *      no secondary pane, it is a no-op (primary already fills the viewport).
 *
 * Closing the secondary pane clears its query param (and `?fullscreen`);
 * the base path is untouched.
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
  /** Generic side-pane pointer (`?side=<conversation_id>`). May be any
   *  conversation id (channel/thread/dm). PR-1 only resolves ids that
   *  exist in the current workspace's channels union; cross-workspace
   *  resolution lands in PR-2 with `useConversationById`. */
  sideConversationId: string | null;
  /** Reply-cluster (thread) pane pointer (`?thread=<root_message_id>`).
   *  When set, the right pane shows that main-line message's thread (root +
   *  replies sharing the parent channel context). A thread is NOT a
   *  conversation, so this is a message id, not a conversation id — it is
   *  resolved against the current channel (`channelId`), never the
   *  workspace conversation union. Mutually exclusive with
   *  `sideConversationId` at the nav layer (opening one clears the other);
   *  `?side` wins if both somehow coexist. (Internally the message group
   *  is still a "reply cluster"; the URL/router speaks the user-facing
   *  "thread" word — `?cluster=` was retired with the legacy `/t/` viewer.) */
  threadRootId: string | null;
  /** Channel Threads-list pane flag (`?threads=1`). When set, the right
   *  pane shows the list of every thread in the current channel (newest
   *  activity first) so threaded messages are discoverable without
   *  scrolling the whole stream (#task:1073, P2). Like a single thread it
   *  is NOT a conversation — it is a channel-scoped index resolved against
   *  `channelId` — and it is mutually exclusive with `sideConversationId`
   *  and `threadRootId` at the nav layer (opening any one clears the
   *  others). */
  threadsListOpen: boolean;
  /** Tasks-drawer focus pointer (`?task=<task_number>`). When set, the
   *  drawer opens to "all" filter and scrolls/highlights the row. The
   *  number is workspace-scoped — resolution uses the workspace of the
   *  message the sigil appears in (see `TaskRefContext`). PR-4. */
  focusedTaskNumber: number | null;
  /** Raw `?fullscreen=1` flag. Applies to whichever pane is secondary
   *  by the side > thread > threads-list priority. */
  fullscreen: boolean;
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
    mChannel?.params.workspaceId ?? mWorkspace?.params.workspaceId ?? null;
  const channelId = mChannel?.params.channelId ?? null;
  const searchParams = new URLSearchParams(search);
  const fullscreen = searchParams.get('fullscreen') === '1';
  const rawSide = searchParams.get('side');
  // Defensive: empty string treated as unset; prevents `?side=` from
  // forcing an "unresolved secondary" placeholder.
  const sideConversationId = rawSide && rawSide.length > 0 ? rawSide : null;
  const rawThread = searchParams.get('thread');
  // Defensive: empty string treated as unset (mirrors `?side`). The value
  // is a main-line message id whose thread (reply cluster) the right pane
  // shows.
  const threadRootId = rawThread && rawThread.length > 0 ? rawThread : null;
  // Channel Threads-list pane: a simple boolean flag (`?threads=1`). The
  // list is channel-scoped (resolved against `channelId`), so no id is
  // carried — the flag alone is enough to switch the right pane to the
  // index view.
  const threadsListOpen = searchParams.get('threads') === '1';
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
    sideConversationId,
    threadRootId,
    threadsListOpen,
    focusedTaskNumber,
    fullscreen,
    agentId: mAgent?.params.agentId ?? null,
    userId: mUser?.params.userId ?? null,
  };
}

export function useRouteState(): RouteState {
  const { pathname, search } = useLocation();
  return parseRouteState(pathname, search);
}

/**
 * The remembered secondary-pane layout of a single channel. The right
 * pane is driven by three mutually-exclusive query params (`?side` /
 * `?thread` / `?threads`); this captures whichever one is open so a
 * channel can be re-entered with the same layout.
 *
 * `none` is a first-class value, NOT "no memory": when a user explicitly
 * closes the secondary pane we record `none` so re-entering the channel
 * keeps it closed rather than resurrecting a stale pane.
 *
 * Fullscreen is deliberately NOT part of this model: no UI affordance
 * writes `?fullscreen=1` today (the `/t/` viewer that owned the only
 * fullscreen toggle was retired), and the render gate only honours
 * fullscreen for a resolved `?side`. Persisting a fullscreen bit would be
 * speculative generality ahead of the product — re-add it together with a
 * real unified secondary-fullscreen affordance when that lands.
 */
export type ChannelLayout =
  | { kind: 'none' }
  | { kind: 'threads-list' }
  | { kind: 'thread'; rootId: string }
  | { kind: 'side'; id: string };

/**
 * The secondary-pane slice of a RouteState that determines a channel's
 * layout. Narrower than the full RouteState so callers (and the layout
 * write-effect) depend only on these primitives, not route identity.
 */
export type SecondaryRouteFields = Pick<
  RouteState,
  'sideConversationId' | 'threadRootId' | 'threadsListOpen'
>;

/**
 * Project the secondary-pane fields of a RouteState down to the persisted
 * {@link ChannelLayout}. The three panes are mutually exclusive at the
 * nav layer, but we resolve in the same priority the render layer uses
 * (side > thread > threads-list) so a malformed URL with more than one
 * set maps deterministically.
 */
export function layoutMemoryFromRoute(
  route: SecondaryRouteFields,
): ChannelLayout {
  if (route.sideConversationId) {
    return { kind: 'side', id: route.sideConversationId };
  }
  if (route.threadRootId) {
    return { kind: 'thread', rootId: route.threadRootId };
  }
  if (route.threadsListOpen) {
    return { kind: 'threads-list' };
  }
  return { kind: 'none' };
}

/**
 * Build the channel URL that restores a remembered {@link ChannelLayout}.
 * `none`/absent memory yields the bare channel path; an open pane appends
 * its query param. Mirrors the `withSide/Thread/ThreadsQuery` writers but
 * composes the layout from scratch onto a fresh path so it is independent
 * of whatever query the previous channel carried.
 */
export function buildChannelLayoutUrl(
  workspaceId: string,
  channelId: string,
  layout: ChannelLayout | null | undefined,
): string {
  const base = routes.chatChannel(workspaceId, channelId);
  if (!layout || layout.kind === 'none') return base;
  const params = new URLSearchParams();
  switch (layout.kind) {
    case 'threads-list':
      params.set('threads', '1');
      break;
    case 'thread':
      params.set('thread', layout.rootId);
      break;
    case 'side':
      params.set('side', layout.id);
      break;
  }
  return `${base}?${params.toString()}`;
}

/**
 * Build a URL with `?side` written or cleared. Pure helper so the nav
 * hook can stay tiny and tests can assert URL shape without React.
 *
 * Rules:
 *  - `id == null`     → strip `?side` AND `?fullscreen` (closing side
 *                       removes both).
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
 * conversation the user is reading.
 *
 * Rationale: `nav.toChannel(wid, cid)` calls `routes.chatChannel(...)`
 * which hands `navigate()` a fresh path with no query string, stripping
 * `?side`. For the cross-workspace `?side=<conversation>` flow, the
 * user's intent is "show me the parent channel of this conversation" —
 * the side overlay must survive. PR-2 fix per Cindy review of msg
 * `tEZtWtHiHzpq8PxC`.
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
 * fullscreen flag, `shouldSecondaryFullscreen` would render ONLY the
 * side, hiding the channel the user was reading. PR-4 review finding
 * by @Cindy.
 *
 * Other params on the URL are preserved so closeSide falls back to
 * whatever was below.
 */
export function buildSideOpenUrl(
  pathname: string,
  search: string,
  conversationId: string,
): string {
  const params = new URLSearchParams(search);
  params.set('side', conversationId);
  params.delete('fullscreen');
  // Side and thread are mutually exclusive secondary panes — opening the
  // side overlay closes any open thread. No-op when `?thread` is absent,
  // so existing side-pane URLs are unaffected.
  params.delete('thread');
  // Same exclusion for the channel Threads-list pane (#task:1073).
  params.delete('threads');
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Build a URL with `?thread` written or cleared. Pure helper mirroring
 * `withSideQuery` so the nav hook stays tiny and tests can assert URL
 * shape without React. NOTE: singular `?thread=<id>` opens one thread;
 * the plural `?threads=1` (see {@link withThreadsQuery}) opens the
 * channel Threads-list — they are distinct panes.
 *
 * Rules:
 *  - `rootMessageId == null` → strip `?thread` AND `?fullscreen` (closing
 *    the thread removes the secondary pane).
 *  - `rootMessageId !== null` → set `?thread=<id>`, strip `?side` and
 *    `?fullscreen` (the thread is a fresh secondary pane, mutually
 *    exclusive with the side overlay).
 *  - Other query params (`task`, …) are preserved verbatim.
 */
export function withThreadQuery(
  pathname: string,
  search: string,
  rootMessageId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (rootMessageId == null) {
    params.delete('thread');
    params.delete('fullscreen');
  } else {
    params.set('thread', rootMessageId);
    params.delete('side');
    params.delete('threads');
    params.delete('fullscreen');
  }
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}

/**
 * Build the URL written by `openThread(rootMessageId)`. Sets
 * `?thread=<id>`, clearing the side overlay + fullscreen so the thread
 * takes the secondary pane cleanly. Thin wrapper over
 * `withThreadQuery` for call-site symmetry with `buildSideOpenUrl`.
 */
export function buildThreadOpenUrl(
  pathname: string,
  search: string,
  rootMessageId: string,
): string {
  return withThreadQuery(pathname, search, rootMessageId);
}

/**
 * Build a URL with `?threads` written or cleared. Pure helper mirroring
 * `withThreadQuery` for the channel Threads-list pane (#task:1073).
 *
 * Rules:
 *  - `open === false` → strip `?threads` AND `?fullscreen` (closing the
 *    list removes the secondary pane).
 *  - `open === true` → set `?threads=1`, strip `?side`, `?thread` and
 *    `?fullscreen` (the list is a fresh secondary pane, mutually exclusive
 *    with the side overlay and a single thread).
 *  - Other query params (`task`, …) are preserved verbatim.
 */
export function withThreadsQuery(
  pathname: string,
  search: string,
  open: boolean,
): string {
  const params = new URLSearchParams(search);
  if (!open) {
    params.delete('threads');
    params.delete('fullscreen');
  } else {
    params.set('threads', '1');
    params.delete('side');
    params.delete('thread');
    params.delete('fullscreen');
  }
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
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
   *  pile entries into history. The base path (`/chat/w/.../c/...`) is
   *  preserved verbatim so closing the overlay restores whatever was
   *  below it. */
  openSide: (conversationId: string) => void;
  /** Close the side overlay. Strips `?side` (and `?fullscreen`) from the
   *  current URL. `replace` so the user's back button doesn't have to
   *  step through every overlay open/close. */
  closeSide: () => void;
  /** Open the thread for `rootMessageId` in the right pane. Writes
   *  `?thread=<id>` (clearing `?side`/`?fullscreen`) via `replace` so it
   *  doesn't pile history entries. The base path is preserved so closing
   *  restores whatever was below. */
  openThread: (rootMessageId: string) => void;
  /** Close the thread pane. Strips `?thread` (and `?fullscreen`). */
  closeThread: () => void;
  /** Open the channel Threads-list pane in the right pane. Writes
   *  `?threads=1` (clearing `?side`/`?thread`/`?fullscreen`) via `replace`
   *  so it doesn't pile history entries (#task:1073). */
  openThreadsList: () => void;
  /** Close the channel Threads-list pane. Strips `?threads` (and
   *  `?fullscreen`). */
  closeThreadsList: () => void;
  /** Toggle the channel Threads-list pane — opens it when closed, closes
   *  it when open. Drives the header Threads icon's click-to-toggle
   *  behaviour (#task:1126 follow-up). */
  toggleThreadsList: () => void;
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
  const openThread = useCallback(
    (rootMessageId: string) => {
      const next = buildThreadOpenUrl(
        location.pathname,
        location.search,
        rootMessageId,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeThread = useCallback(() => {
    const next = withThreadQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const openThreadsList = useCallback(() => {
    const next = withThreadsQuery(location.pathname, location.search, true);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const closeThreadsList = useCallback(() => {
    const next = withThreadsQuery(location.pathname, location.search, false);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const toggleThreadsList = useCallback(() => {
    const open = new URLSearchParams(location.search).get('threads') === '1';
    const next = withThreadsQuery(location.pathname, location.search, !open);
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
    toMembers,
    toMembersUser,
    toComputers,
    toTasks,
    toSettings,
    openSide,
    closeSide,
    openThread,
    closeThread,
    openThreadsList,
    closeThreadsList,
    toggleThreadsList,
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
    toMembers,
    toMembersUser,
    toComputers,
    toTasks,
    toSettings,
    openSide,
    closeSide,
    openThread,
    closeThread,
    openThreadsList,
    closeThreadsList,
    toggleThreadsList,
    openTask,
    closeTask,
  ]);
}
