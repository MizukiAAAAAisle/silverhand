import { useCallback } from 'react';
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
  /** Raw `?fullscreen=1` flag. Applies to whichever pane is secondary
   *  by the side > thread priority. */
  fullscreen: boolean;
  /** Back-compat shorthand: `fullscreen && /t/:tid present && no ?side`.
   *  Keeps existing thread-fullscreen consumers wired without forcing
   *  every call site to re-derive. New code should prefer reading
   *  `fullscreen` + `secondaryDescriptor` from App-level selectors. */
  threadFullscreen: boolean;
  agentId: string | null;
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
  const mAgent = matchPath(routePatterns.membersAgent, pathname);

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
    fullscreen,
    threadFullscreen,
    agentId: mAgent?.params.agentId ?? null,
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
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
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
  return {
    go,
    toChat: useCallback(() => go(routes.chat()), [go]),
    toChatSearch: useCallback(() => go(routes.chatSearch()), [go]),
    toChatSaved: useCallback(() => go(routes.chatSaved()), [go]),
    toChatArchived: useCallback(() => go(routes.chatArchived()), [go]),
    toWorkspace: useCallback((id: string) => go(routes.chatWorkspace(id)), [go]),
    toChannel: useCallback(
      (wid: string, cid: string) => go(routes.chatChannel(wid, cid)),
      [go],
    ),
    toThread: useCallback(
      (wid: string, cid: string, tid: string, opts = {}) =>
        go(routes.chatThread(wid, cid, tid, opts), { replace: opts.replace }),
      [go],
    ),
    toMembers: useCallback(
      (agentId?: string) =>
        go(agentId ? routes.membersAgent(agentId) : routes.members()),
      [go],
    ),
    toComputers: useCallback(() => go(routes.computers()), [go]),
    toTasks: useCallback(() => go(routes.tasks()), [go]),
    toSettings: useCallback(() => go(routes.settings()), [go]),
    openSide,
    closeSide,
  };
}
