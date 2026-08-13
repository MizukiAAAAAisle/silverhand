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
  // Optional `q` prefills the advanced SearchPanel's query — the inline header
  // find's "高级搜索" hand-off carries the current keyword (#task:1335).
  chatSearch: (query?: string) =>
    query && query.trim()
      ? `/chat/search?q=${encodeURIComponent(query.trim())}`
      : '/chat/search',
  chatSaved: () => '/chat/saved',
  chatArchived: () => '/chat/archived',
  chatWorkspace: (workspaceId: string) => `/chat/w/${workspaceId}`,
  chatChannel: (workspaceId: string, channelId: string) =>
    `/chat/w/${workspaceId}/c/${channelId}`,
  // Activity is a top-level NavRail section (peer to chat, #task:1394). It has
  // exactly TWO states, both a pure projection of the route: bare `/activity`
  // (no workspace, no channel — the full-width global list) and the selected
  // state `/activity/w/:wid/c/:cid` (a specific channel, opened from a list
  // item). There is deliberately NO workspace-only `/activity/w/:wid` route:
  // the workspace is always derived from the selected channel, so a workspace
  // with no channel would be a third selection state with a titlebar/ws-scoped
  // queries but no Activity item behind it (Cindy, #task:1394 review). Secondary
  // panes (`?thread=<root>`) ride the shared query helpers, which operate on the
  // current pathname and thus stay in-section automatically.
  activity: () => '/activity',
  activityChannel: (workspaceId: string, channelId: string) =>
    `/activity/w/${workspaceId}/c/${channelId}`,
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
  activityChannel: '/activity/w/:workspaceId/c/:channelId',
  activity: '/activity',
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
  /** Advanced-search prefill (`/chat/search?q=<query>`). Seeds the SearchPanel
   *  query on mount when the inline header find hands off to advanced search
   *  (#task:1335). Null when absent. */
  searchQuery: string | null;
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
  /** Channel Attachments panel flag (`?files=1`). An OVERLAY utility pane,
   *  NOT a mutually-exclusive secondary-family peer: opening it clears
   *  `?side` / `?agent` / `?fullscreen` but PRESERVES `?thread` /
   *  `?threads`, so closing it (deleting `?files`) reveals whatever
   *  conversation pane was underneath — the URL itself is the restore
   *  stack, no memory needed (same model as `?agent`, #task:1433). The
   *  render layer honours priority `agent > files > task > side > thread >
   *  threads`. `?side` is cleared on open because a secondary CONVERSATION
   *  feeds notification suppression and must not stay "visible" while
   *  covered. It is NOT a conversation — a channel-scoped index resolved
   *  against `channelId` — and is deliberately absent from `ChannelLayout`
   *  persistence: a transient overlay should not resurrect on channel
   *  re-entry (only the underlying thread/threads pane persists). The URL
   *  uses `?files` (matching `?threads=1`) rather than the product-facing
   *  word "Attachments" for symmetry; the panel title is "Attachments". */
   filesListOpen: boolean;
  /** Open task-detail pointer (`?task=<task_id>`). When set, the app-level
   *  detail modal is open on that task (#task:1715).
   *
   *  The value is a task ID, not the `#<n>` the user reads in chat: a
   *  task_number is only unique inside a workspace, so it would need a
   *  second workspace axis to resolve — and the route's own workspace can't
   *  supply it (the tasks drawer is a cross-workspace aggregate, so a card
   *  it shows may belong to another workspace). One id is the whole
   *  coordinate: `GET /api/tasks/:taskId` gates a human read on
   *  conversation access alone, with no workspace term. Same shape as
   *  `?side=<conversation_id>` / `?agent=<agent_id>`; `task_number` stays a
   *  display name. */
  taskDetailId: string | null;
  /** Raw `?fullscreen=1` flag. Applies to whichever pane is secondary
   *  by the side > thread > threads-list priority. */
  fullscreen: boolean;
  agentId: string | null;
  /** Set when the URL is `/members/u/:userId`. Mutually exclusive with
   *  `agentId` (the patterns are disjoint by segment count). The
   *  members section's right-pane branches on whichever is non-null. */
  userId: string | null;
  /** Agent side-panel pointer (`?agent=<agentId>`). Opens that agent's
   *  compact panel in the chat section's right pane so a channel and an
   *  agent's Activity can be read side-by-side (#task:1189). It is NOT a
   *  conversation — it is an agent id rendered by `AgentView variant="side"`.
   *  It OVERLAYS the thread panes rather than excluding them: `?agent` can
   *  coexist with `?thread` / `?threads` in the URL (App renders the agent
   *  ahead of them by precedence, and closing it restores the covered pane
   *  — #task:1433). Only `?side` is cleared on open, because a secondary
   *  conversation enters the focus/notification-suppression model and must
   *  not stay "visible" while covered. Distinct from `agentId`, which is the
   *  `/members/:agentId` *full-page* route segment. */
  agentPanelId: string | null;
}

/**
 * Pure URL → RouteState parser. Exported for unit testing — the React
 * hook below is just `parseRouteState(useLocation())`. Keeping this
 * separate avoids spinning up a router in tests.
 */
export function parseRouteState(pathname: string, search: string): RouteState {
  // Both chat and activity carry the same `/w/:workspaceId/c/:channelId`
  // shape (activity just under a different prefix), so try both channel
  // patterns — workspaceId/channelId then populate identically for either
  // section, and the section itself is decided by the pathname prefix below.
  const mChannel =
    matchPath(routePatterns.chatChannel, pathname) ??
    matchPath(routePatterns.activityChannel, pathname);
  // Workspace-only is CHAT-only: activity has no `/activity/w/:wid` route (a
  // workspace with no channel would be a third selection state with no Activity
  // item behind it — #task:1394). A hand-typed `/activity/w/foo` therefore
  // matches no pattern here and resolves to activity section + no workspace/no
  // channel (the full-width list), never a phantom workspace selection.
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
  // Channel Attachments panel: same shape as `?threads=1` (a boolean
  // flag; the panel scopes to `channelId`). Fourth secondary-family axis.
  // Any value other than exactly `'1'` treated as absent.
  const filesListOpen = searchParams.get('files') === '1';
  // Agent side-panel pane (`?agent=<agentId>`). Empty string treated as
  // unset (mirrors `?side`). Carries an agent id, not a conversation id —
  // the chat-section right pane renders it as `AgentView variant="side"`.
  const rawAgentPanel = searchParams.get('agent');
  const agentPanelId =
    rawAgentPanel && rawAgentPanel.length > 0 ? rawAgentPanel : null;
  const rawTask = searchParams.get('task');
  // Opaque id, treated exactly like `?side` / `?agent`: non-empty or null.
  // An unresolvable value is NOT filtered out here — the modal host resolves
  // it and renders a "Task not found" terminal state, because silently
  // dropping a pointer the user clicked leaves them with no explanation
  // (the `?side` placeholder settled this).
  const taskDetailId = rawTask !== null && rawTask.length > 0 ? rawTask : null;

  // Advanced-search prefill query (`?q=`); empty treated as unset.
  const rawSearchQuery = searchParams.get('q');
  const searchQuery =
    rawSearchQuery && rawSearchQuery.length > 0 ? rawSearchQuery : null;

  let section: AppSection = 'chat';
  if (pathname.startsWith('/members')) section = 'members';
  else if (pathname.startsWith('/computers')) section = 'computers';
  else if (pathname.startsWith('/tasks')) section = 'tasks';
  else if (pathname.startsWith('/settings')) section = 'settings';
  else if (pathname.startsWith('/activity')) section = 'activity';

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
    searchQuery,
    workspaceId: workspaceId ?? null,
    channelId: channelId ?? null,
    sideConversationId,
    threadRootId,
    threadsListOpen,
    filesListOpen,
    taskDetailId,
    fullscreen,
    agentId: mAgent?.params.agentId ?? null,
    userId: mUser?.params.userId ?? null,
    agentPanelId,
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
 * The Attachments panel (`?files=1`) is deliberately ABSENT here: it is a
 * transient OVERLAY (see `RouteState.filesListOpen`), and resurrecting a
 * utility overlay on channel re-entry is not the intent. When it covers a
 * thread/threads pane, that underlying pane is what persists.
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
 * `filesListOpen` is intentionally NOT here — the Attachments overlay does
 * not persist (see {@link ChannelLayout}).
 */
export type SecondaryRouteFields = Pick<
  RouteState,
  'sideConversationId' | 'threadRootId' | 'threadsListOpen'
>;

/**
 * Project the secondary-pane fields of a RouteState down to the persisted
 * {@link ChannelLayout}. The three persisted panes are mutually exclusive
 * at the nav layer, but we resolve in the same priority the render layer
 * uses (side > thread > threads-list) so a malformed URL with more than
 * one set maps deterministically. The Attachments overlay (`?files`) is
 * not projected here: when it covers a thread/threads pane, that pane's
 * query param is still present and wins; when it is open alone the layout
 * is `none`, so a bare channel + Files does not resurrect on re-entry.
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
 * Behavior registry for the right-pane "secondary family" — the SINGLE source
 * of truth for how opening one pane treats the panes beneath it. `PaneKind`
 * and the opener's clear-list both derive from this one object, so adding a
 * pane forces a behavior declaration in exactly one place; the runtime set and
 * the type can't drift apart.
 *
 * `mode` is an intrinsic property of the pane KIND, never a caller argument —
 * so the illegal "open `side` as an overlay" combination has no API surface at
 * all (it's unconstructable, not merely gated).
 *
 *  - `mode: 'replace'` — conversation-context panes (`side`/`thread`/`threads`).
 *    Opening one writes itself and clears EVERY other secondary param (+
 *    `fullscreen`): one conversation context at a time, no restore stack.
 *  - `mode: 'overlay'` — utility/inspector panes (`agent`/`files`/`task`).
 *    Opening one writes itself, drops `fullscreen`, clears `?side` and the
 *    OTHER overlays, but PRESERVES every pane flagged `survivesOverlay` as the
 *    URL restore stack — closing brings the covered pane back with no in-memory
 *    state.
 *
 * `survivesOverlay` is a second axis because `mode` alone underdetermines the
 * restore stack: `side` is `replace` yet must NOT survive being covered. The
 * two `false` values are NOT the same kind of `false` — do not "unify" them:
 *  - `side: false` is a HARD CORRECTNESS invariant, never flippable to `true`.
 *    A hidden `?side` still feeds `useSecondaryPaneModel`'s visible/focused set
 *    (driving notification suppression + read-advance), so leaving it set while
 *    invisible is data corruption. The runtime matrix test locks this — it is a
 *    gate, not a style choice; do not remove it.
 *  - `agent`/`files`/`task` `false` is a SOFT TOPOLOGY choice — "one overlay on
 *    top at a time." These panes are visually neutral (no visible/focused
 *    side-effect), so this could flip to `true` later (e.g. if an agent panel
 *    is allowed to coexist with another overlay) without hurting correctness.
 *  - `thread`/`threads` `true`: pure render panes with no visibility
 *    side-effect, so an overlay preserves them as the restore stack.
 */
const SECONDARY_PANES = {
  // `replace` conversation-context panes.
  //   side: covered-but-in-URL is data corruption → false is a HARD invariant.
  side: { mode: 'replace', survivesOverlay: false },
  //   thread/threads: pure render, safe to keep under an overlay (restore stack).
  thread: { mode: 'replace', survivesOverlay: true },
  threads: { mode: 'replace', survivesOverlay: true },
  // `overlay` utility/inspector panes. survivesOverlay:false here is a SOFT
  // topology choice ("one overlay at a time"), flippable without correctness risk.
  agent: { mode: 'overlay', survivesOverlay: false },
  files: { mode: 'overlay', survivesOverlay: false },
  task: { mode: 'overlay', survivesOverlay: false },
} as const satisfies Record<
  string,
  { mode: 'overlay' | 'replace'; survivesOverlay: boolean }
>;

/** Every secondary-pane query param, derived from the registry. */
export type SecondaryPane = keyof typeof SECONDARY_PANES;

const SECONDARY_PANE_KEYS = Object.keys(SECONDARY_PANES) as SecondaryPane[];

/**
 * Write an "open pane" transform onto `params` in place. `mode` is looked up
 * from {@link SECONDARY_PANES}, never passed, so `side` can never take overlay
 * semantics. An overlay open preserves the `survivesOverlay` panes (the URL
 * restore stack) and clears everything else; a replace open clears every other
 * secondary param. `fullscreen` is always dropped — a freshly opened pane
 * shows at its normal width.
 */
function writeSecondaryPaneOpen(
  params: URLSearchParams,
  pane: SecondaryPane,
  value: string,
): void {
  params.set(pane, value);
  params.delete('fullscreen');
  const overlay = SECONDARY_PANES[pane].mode === 'overlay';
  for (const other of SECONDARY_PANE_KEYS) {
    if (other === pane) continue;
    if (overlay && SECONDARY_PANES[other].survivesOverlay) continue;
    params.delete(other);
  }
}

/**
 * Write a "close pane" transform onto `params` in place. Only the pane's own
 * param + `fullscreen` are removed; whatever the URL still carries below (the
 * restore stack an overlay preserved) surfaces on the next render — no memory.
 */
function writeSecondaryPaneClose(
  params: URLSearchParams,
  pane: SecondaryPane,
): void {
  params.delete(pane);
  params.delete('fullscreen');
}

function serializeQuery(pathname: string, params: URLSearchParams): string {
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}

/**
 * Build a URL with `?side` written or cleared. Pure helper so the nav
 * hook can stay tiny and tests can assert URL shape without React.
 *
 * Rules:
 *  - `id == null`  → strip `?side` AND `?fullscreen` (closing side removes
 *    both).
 *  - `id !== null` → open `side` (a `replace` pane): set `?side=<id>` and clear
 *    every other secondary pane + `fullscreen`. Unrelated query params (not in
 *    the secondary family) are preserved verbatim.
 */
export function withSideQuery(
  pathname: string,
  search: string,
  id: string | null,
): string {
  const params = new URLSearchParams(search);
  if (id == null) {
    writeSecondaryPaneClose(params, 'side');
  } else {
    writeSecondaryPaneOpen(params, 'side', id);
  }
  return serializeQuery(pathname, params);
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
 * Build a channel-switch URL that preserves the open agent side panel
 * (`?agent=<id>`, #task:1189). This is what makes A (Activity follows the
 * current channel) actually close the loop: switching the *left* channel keeps
 * the *right* agent panel mounted, and its locked Activity context re-points at
 * the new channel — instead of `buildChannelLayoutUrl` writing a bare path (or
 * restoring a remembered thread/side) and dropping `?agent`, which silently
 * closes the panel.
 *
 * No remembered secondary layout is restored here: while an agent panel is
 * docked it owns the right pane, so a channel switch must not resurrect that
 * channel's old thread/side. `?fullscreen` is not carried (same reasoning as
 * `buildChannelPathPreservingSide`).
 */
export function buildChannelPathPreservingAgent(
  workspaceId: string,
  channelId: string,
  agentId: string,
): string {
  const params = new URLSearchParams();
  params.set('agent', agentId);
  return `${routes.chatChannel(workspaceId, channelId)}?${params.toString()}`;
}

/**
 * Build a URL with `?task` written or cleared. Pure helper so the nav
 * hook can stay tiny and tests can assert URL shape without React.
 *
 * `task` is an OVERLAY pane (utility/inspector): the in-conversation task
 * detail floats over the conversation without replacing the thread beneath it.
 *
 * Rules:
 *  - `taskId == null` → strip `?task` AND `?fullscreen`. Any `?thread` /
 *    `?threads` PRESERVED when the pane opened survive, so the covered thread
 *    pane comes back — the URL is the restore stack, no memory.
 *  - `taskId !== null` → open `task`: set `?task=<task_id>`; strip `?side`, the
 *    other overlays (`?agent` / `?files`) and `?fullscreen`, but PRESERVE
 *    `?thread` / `?threads`. `?side` is cleared for correctness — a covered
 *    secondary conversation still feeds `useSecondaryPaneModel`'s
 *    visible/focused set. Whether the id resolves is the host's business (it
 *    renders a not-found state); this writer is dumb about resolution.
 */
export function withTaskQuery(
  pathname: string,
  search: string,
  taskId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (taskId == null) {
    writeSecondaryPaneClose(params, 'task');
  } else {
    writeSecondaryPaneOpen(params, 'task', taskId);
  }
  return serializeQuery(pathname, params);
}

/**
 * Build the URL written by `openTask(taskId)`. Opens the `task` overlay on the
 * current location, preserving the base path and the `?thread` / `?threads`
 * restore stack. The app-level host reads `taskDetailId` from the resulting
 * RouteState and shows the detail pane (in a conversation) or modal (drawer /
 * board) on that task.
 *
 * Thin wrapper over {@link withTaskQuery}; closing is `withTaskQuery(…, null)`.
 */
export function buildTaskOpenUrl(
  pathname: string,
  search: string,
  taskId: string,
): string {
  return withTaskQuery(pathname, search, taskId);
}

/**
 * Build the URL written by `openSide(conversationId)`. Opens the `side`
 * conversation pane (a `replace` pane): it clears every other secondary pane
 * and `?fullscreen`. A conversation sigil click reaches this through
 * `onOpenConversationRef`, and that affordance promises a side pane rather than
 * a replacement for the main view; if openSide inherited a stale
 * `?fullscreen=1`, `shouldSecondaryFullscreen` would render ONLY the side,
 * hiding the channel the user was reading (PR-4 review finding by @Cindy).
 * Unrelated query params are preserved so closeSide falls back to whatever was
 * below.
 */
export function buildSideOpenUrl(
  pathname: string,
  search: string,
  conversationId: string,
): string {
  const params = new URLSearchParams(search);
  writeSecondaryPaneOpen(params, 'side', conversationId);
  return serializeQuery(pathname, params);
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
 *  - `rootMessageId !== null` → open `thread` (a `replace` pane): set
 *    `?thread=<id>` and clear every other secondary pane + `?fullscreen`.
 *  - Unrelated query params (anything outside the secondary family, e.g.
 *    `?utm_source`) are preserved verbatim; the other secondary panes
 *    (`?task`, …) are same-family and cleared by the rule above.
 */
export function withThreadQuery(
  pathname: string,
  search: string,
  rootMessageId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (rootMessageId == null) {
    writeSecondaryPaneClose(params, 'thread');
  } else {
    writeSecondaryPaneOpen(params, 'thread', rootMessageId);
  }
  return serializeQuery(pathname, params);
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
 *  - `open === true` → open `threads` (a `replace` pane): set `?threads=1` and
 *    clear every other secondary pane + `?fullscreen`.
 *  - Unrelated query params (anything outside the secondary family, e.g.
 *    `?utm_source`) are preserved verbatim; the other secondary panes
 *    (`?task`, …) are same-family and cleared by the rule above.
 */
export function withThreadsQuery(
  pathname: string,
  search: string,
  open: boolean,
): string {
  const params = new URLSearchParams(search);
  if (!open) {
    writeSecondaryPaneClose(params, 'threads');
  } else {
    writeSecondaryPaneOpen(params, 'threads', '1');
  }
  return serializeQuery(pathname, params);
}

/**
 * Build a URL with `?files` written or cleared. The Attachments panel is an
 * OVERLAY (`mode: 'overlay'` in {@link SECONDARY_PANES}), not a
 * mutually-exclusive conversation-context peer.
 *
 * Rules:
 *  - `open === false` → strip `?files` AND `?fullscreen`. Any `?thread` /
 *    `?threads` that were PRESERVED when the panel opened survive, so the
 *    covered conversation pane comes back — the URL is the restore stack, no
 *    memory needed.
 *  - `open === true` → open `files`: set `?files=1`; strip `?side` and the
 *    other overlays (`?agent` / `?task`) + `?fullscreen`, but PRESERVE
 *    `?thread` / `?threads`. `?side` is cleared for correctness (a covered
 *    secondary CONVERSATION still feeds `useSecondaryPaneModel`'s
 *    visible/focused set → notification/read bugs); the other overlays are
 *    cleared because the right pane holds one overlay at a time.
 *  - Unrelated query params (anything outside the secondary family, e.g.
 *    `?utm_source`) are preserved verbatim; the other secondary panes
 *    (`?task`, …) are same-family and cleared by the rule above.
 */
export function withFilesQuery(
  pathname: string,
  search: string,
  open: boolean,
): string {
  const params = new URLSearchParams(search);
  if (!open) {
    writeSecondaryPaneClose(params, 'files');
  } else {
    writeSecondaryPaneOpen(params, 'files', '1');
  }
  return serializeQuery(pathname, params);
}


/**
 * Build a URL with `?agent` written or cleared (#task:1189). An OVERLAY pane
 * (`mode: 'overlay'` in {@link SECONDARY_PANES}).
 *
 * Rules:
 *  - `agentId == null` → strip `?agent` AND `?fullscreen` (closing the panel
 *    removes the secondary pane). Any `?thread` / `?threads` PRESERVED when the
 *    panel opened survive, so the covered thread pane comes back (#task:1433).
 *  - `agentId !== null` → open `agent`: set `?agent=<id>`; strip `?side` and
 *    the other overlays (`?files` / `?task`) + `?fullscreen`, but PRESERVE
 *    `?thread` / `?threads`. App's secondary-pane precedence renders the panel
 *    ahead of the thread / threads-list pane; those params survive so closing
 *    restores whatever was open. `?side` is cleared for correctness (a covered
 *    secondary CONVERSATION still feeds `useSecondaryPaneModel`'s
 *    visible/focused set → notification/read bugs).
 *  - Unrelated query params (anything outside the secondary family, e.g.
 *    `?utm_source`) are preserved verbatim; the other secondary panes
 *    (`?task`, …) are same-family and cleared by the rule above.
 */
export function withAgentQuery(
  pathname: string,
  search: string,
  agentId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (agentId == null) {
    writeSecondaryPaneClose(params, 'agent');
  } else {
    writeSecondaryPaneOpen(params, 'agent', agentId);
  }
  return serializeQuery(pathname, params);
}

/**
 * Build the URL written by `openAgentPanel(agentId)`. Thin wrapper over
 * `withAgentQuery` for call-site symmetry with `buildSideOpenUrl`.
 */
export function buildAgentPanelOpenUrl(
  pathname: string,
  search: string,
  agentId: string,
): string {
  return withAgentQuery(pathname, search, agentId);
}

/**
 * Typed navigation helpers. All call sites that previously did
 * `setSelectedX` go through these — keeps URL construction in one
 * place and gives the call sites a self-documenting API.
 */
export function useNav(): {
  go: (to: string, opts?: { replace?: boolean }) => void;
  toChat: () => void;
  toChatSearch: (query?: string) => void;
  toChatSaved: () => void;
  toChatArchived: () => void;
  toActivity: () => void;
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
  /** Open the channel Attachments panel in the right pane (`?files=1`).
   *  An OVERLAY: clears `?side` (correctness) + the other overlays
   *  (`?agent`/`?task`) + `?fullscreen`, but PRESERVES `?thread`/`?threads`
   *  as the restore stack. */
  openFilesList: () => void;
  /** Close the channel Attachments panel. Strips `?files` (and any residual
   *  `?fullscreen`); the preserved `?thread`/`?threads` resurfaces. */
  closeFilesList: () => void;
  /** Toggle the channel Attachments panel — drives the header Paperclip
   *  icon's click-to-toggle behaviour, mirroring `toggleThreadsList`. */
  toggleFilesList: () => void;
  /** Open a task's detail by writing `?task=<task_id>` (an OVERLAY pane).
   *  Every entrance (chat chip, Tasks pane card, drawer card) goes through
   *  this one writer, so there is a single task-detail state. In a
   *  conversation the host renders it as an overlay side pane; from the drawer
   *  / board as a modal. `replace` so re-clicking chips doesn't pile history.
   *  Clears `?side` + other overlays, preserves `?thread`/`?threads`. */
  openTask: (taskId: string) => void;
  /** Close the task detail by clearing `?task` (and `?fullscreen`). The
   *  preserved `?thread`/`?threads` resurfaces; the tasks drawer keeps its own
   *  open state, so closing a detail opened from a drawer card returns to the
   *  drawer. */
  closeTask: () => void;
  /** Open agent `agentId` as the chat-section right-pane panel
   *  (`?agent=<id>`, #task:1189) so a channel + the agent's Activity show
   *  side-by-side. Clears any conversation-based secondary; `replace` so it
   *  doesn't pile history entries. The base channel path is preserved. */
  openAgentPanel: (agentId: string) => void;
  /** Close the agent side panel. Strips `?agent` (and `?fullscreen`). */
  closeAgentPanel: () => void;
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
  const openFilesList = useCallback(() => {
    const next = withFilesQuery(location.pathname, location.search, true);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const closeFilesList = useCallback(() => {
    const next = withFilesQuery(location.pathname, location.search, false);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const toggleFilesList = useCallback(() => {
    const open = new URLSearchParams(location.search).get('files') === '1';
    const next = withFilesQuery(location.pathname, location.search, !open);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const openTask = useCallback(
    (taskId: string) => {
      const next = buildTaskOpenUrl(
        location.pathname,
        location.search,
        taskId,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeTask = useCallback(() => {
    const next = withTaskQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const openAgentPanel = useCallback(
    (agentId: string) => {
      const next = buildAgentPanelOpenUrl(
        location.pathname,
        location.search,
        agentId,
      );
      navigate(next, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );
  const closeAgentPanel = useCallback(() => {
    const next = withAgentQuery(location.pathname, location.search, null);
    navigate(next, { replace: true });
  }, [navigate, location.pathname, location.search]);
  const toChat = useCallback(() => go(routes.chat()), [go]);
  const toChatSearch = useCallback(
    (query?: string) => go(routes.chatSearch(query)),
    [go],
  );
  const toChatSaved = useCallback(() => go(routes.chatSaved()), [go]);
  const toChatArchived = useCallback(() => go(routes.chatArchived()), [go]);
  const toActivity = useCallback(() => go(routes.activity()), [go]);
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
    toActivity,
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
    openFilesList,
    closeFilesList,
    toggleFilesList,
    openTask,
    closeTask,
    openAgentPanel,
    closeAgentPanel,
  }), [
    go,
    toChat,
    toChatSearch,
    toChatSaved,
    toChatArchived,
    toActivity,
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
    openFilesList,
    closeFilesList,
    toggleFilesList,
    openTask,
    closeTask,
    openAgentPanel,
    closeAgentPanel,
  ]);
}
