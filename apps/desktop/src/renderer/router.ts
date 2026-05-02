import { useCallback } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import type { AppSection } from '@/components/layout/NavRail';

/**
 * Single source of truth for our URL scheme. Keep all path templates
 * here so callers don't sprinkle string concatenation across the
 * codebase.
 */
export const routes = {
  home: () => '/',
  chat: () => '/chat',
  chatSaved: () => '/chat/saved',
  chatChannel: (channelId: string) => `/chat/c/${channelId}`,
  chatSession: (channelId: string, sessionId: string) =>
    `/chat/c/${channelId}/s/${sessionId}`,
  chatThread: (channelId: string, sessionId: string, childSessionId: string) =>
    `/chat/c/${channelId}/s/${sessionId}/t/${childSessionId}`,
  members: () => '/members',
  membersAgent: (agentId: string) => `/members/${agentId}`,
  computers: () => '/computers',
  settings: () => '/settings',
} as const;

export const routePatterns = {
  chatThread: '/chat/c/:channelId/s/:sessionId/t/:childSessionId',
  chatSession: '/chat/c/:channelId/s/:sessionId',
  chatChannel: '/chat/c/:channelId',
  chatSaved: '/chat/saved',
  chat: '/chat',
  membersAgent: '/members/:agentId',
  members: '/members',
  computers: '/computers',
  settings: '/settings',
} as const;

export type ChatView = 'channel' | 'saved';

/**
 * Resolved view of the current URL. Components read this instead of
 * useState — single hook keeps the parsing in one place.
 */
export interface RouteState {
  section: AppSection;
  /** Within the chat section: 'channel' or 'saved'. */
  chatView: ChatView;
  channelId: string | null;
  sessionId: string | null;
  childSessionId: string | null;
  agentId: string | null;
}

export function useRouteState(): RouteState {
  const { pathname } = useLocation();
  // useMatch is order-independent — we evaluate the longest patterns
  // first and use the deepest non-null result so /chat/c/x/s/y/t/z
  // doesn't get masked by /chat/c/x.
  const mThread = useMatch(routePatterns.chatThread);
  const mSession = useMatch(routePatterns.chatSession);
  const mChannel = useMatch(routePatterns.chatChannel);
  const mAgent = useMatch(routePatterns.membersAgent);

  const channelId =
    mThread?.params.channelId ??
    mSession?.params.channelId ??
    mChannel?.params.channelId ??
    null;
  const sessionId =
    mThread?.params.sessionId ?? mSession?.params.sessionId ?? null;
  const childSessionId = mThread?.params.childSessionId ?? null;

  let section: AppSection = 'chat';
  if (pathname.startsWith('/members')) section = 'members';
  else if (pathname.startsWith('/computers')) section = 'computers';
  else if (pathname.startsWith('/settings')) section = 'settings';

  const chatView: ChatView = pathname.startsWith('/chat/saved') ? 'saved' : 'channel';

  return {
    section,
    chatView,
    channelId,
    sessionId,
    childSessionId,
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
  toChatSaved: () => void;
  toChannel: (channelId: string) => void;
  toSession: (channelId: string, sessionId: string) => void;
  toThread: (channelId: string, sessionId: string, childSessionId: string) => void;
  toMembers: (agentId?: string) => void;
  toComputers: () => void;
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
    toChatSaved: useCallback(() => go(routes.chatSaved()), [go]),
    toChannel: useCallback((id: string) => go(routes.chatChannel(id)), [go]),
    toSession: useCallback(
      (cid: string, sid: string) => go(routes.chatSession(cid, sid)),
      [go],
    ),
    toThread: useCallback(
      (cid: string, sid: string, tid: string) => go(routes.chatThread(cid, sid, tid)),
      [go],
    ),
    toMembers: useCallback(
      (agentId?: string) =>
        go(agentId ? routes.membersAgent(agentId) : routes.members()),
      [go],
    ),
    toComputers: useCallback(() => go(routes.computers()), [go]),
    toSettings: useCallback(() => go(routes.settings()), [go]),
  };
}
