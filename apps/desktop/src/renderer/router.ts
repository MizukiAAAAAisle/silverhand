import { useCallback } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import type { AppSection } from '@/components/layout/NavRail';

/**
 * Single source of truth for our URL scheme. Keep all path templates
 * here so callers don't sprinkle string concatenation across the
 * codebase.
 *
 * Naming: workspace (outer container) → channel (conversation) → thread (nested).
 * Old: /chat/c/:channelId/s/:sessionId/t/:childSessionId
 * New: /chat/w/:workspaceId/c/:channelId/t/:threadId
 */
export const routes = {
  home: () => '/',
  chat: () => '/chat',
  chatSearch: () => '/chat/search',
  chatSaved: () => '/chat/saved',
  chatWorkspace: (workspaceId: string) => `/chat/w/${workspaceId}`,
  chatChannel: (workspaceId: string, channelId: string) =>
    `/chat/w/${workspaceId}/c/${channelId}`,
  chatThread: (workspaceId: string, channelId: string, threadId: string) =>
    `/chat/w/${workspaceId}/c/${channelId}/t/${threadId}`,
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
  chatSearch: '/chat/search',
  chatSaved: '/chat/saved',
  chat: '/chat',
  membersAgent: '/members/:agentId',
  members: '/members',
  computers: '/computers',
  tasks: '/tasks',
  settings: '/settings',
} as const;

export type ChatView = 'channel' | 'saved' | 'search';

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
  agentId: string | null;
}

export function useRouteState(): RouteState {
  const { pathname } = useLocation();
  // useMatch is order-independent — we evaluate the longest patterns
  // first and use the deepest non-null result so /chat/w/x/c/y/t/z
  // doesn't get masked by /chat/w/x.
  const mThread = useMatch(routePatterns.chatThread);
  const mChannel = useMatch(routePatterns.chatChannel);
  const mWorkspace = useMatch(routePatterns.chatWorkspace);
  const mAgent = useMatch(routePatterns.membersAgent);

  const workspaceId =
    mThread?.params.workspaceId ??
    mChannel?.params.workspaceId ??
    mWorkspace?.params.workspaceId ??
    null;
  const channelId =
    mThread?.params.channelId ?? mChannel?.params.channelId ?? null;
  const threadId = mThread?.params.threadId ?? null;

  let section: AppSection = 'chat';
  if (pathname.startsWith('/members')) section = 'members';
  else if (pathname.startsWith('/computers')) section = 'computers';
  else if (pathname.startsWith('/tasks')) section = 'tasks';
  else if (pathname.startsWith('/settings')) section = 'settings';

  const chatView: ChatView = pathname.startsWith('/chat/saved')
    ? 'saved'
    : pathname.startsWith('/chat/search')
      ? 'search'
      : 'channel';

  return {
    section,
    chatView,
    workspaceId,
    channelId,
    threadId,
    agentId: mAgent?.params.agentId ?? null,
  };
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
  toWorkspace: (workspaceId: string) => void;
  toChannel: (workspaceId: string, channelId: string) => void;
  toThread: (workspaceId: string, channelId: string, threadId: string) => void;
  toMembers: (agentId?: string) => void;
  toComputers: () => void;
  toTasks: () => void;
  toSettings: () => void;
} {
  const navigate = useNavigate();
  const go = useCallback(
    (to: string, opts?: { replace?: boolean }) =>
      navigate(to, { replace: opts?.replace ?? false }),
    [navigate],
  );
  return {
    go,
    toChat: useCallback(() => go(routes.chat()), [go]),
    toChatSearch: useCallback(() => go(routes.chatSearch()), [go]),
    toChatSaved: useCallback(() => go(routes.chatSaved()), [go]),
    toWorkspace: useCallback((id: string) => go(routes.chatWorkspace(id)), [go]),
    toChannel: useCallback(
      (wid: string, cid: string) => go(routes.chatChannel(wid, cid)),
      [go],
    ),
    toThread: useCallback(
      (wid: string, cid: string, tid: string) => go(routes.chatThread(wid, cid, tid)),
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
  };
}
