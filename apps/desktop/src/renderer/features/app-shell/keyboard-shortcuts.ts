import { useEffect, useRef } from 'react';
import type { AppSection } from '@/components/layout/NavRail';
import type { RouteState } from '@/router';

/**
 * App-wide keyboard shortcuts. Deliberately a SMALL, fixed set —
 * not a remappable registry or command palette (out of scope per shiki):
 *
 *   • ⌘1–⌘5  — jump to a nav-rail section. Renderer-owned (a plain `window`
 *     keydown), NOT a native-menu accelerator: ⌘+digit is never a typing key,
 *     so it stays global even with an input focused, and no default macOS menu
 *     item claims ⌘1–5, so the renderer reliably receives it.
 *   • ⌘W     — contextual close: peel the top-most in-app panel, and only fall
 *     through to backgrounding the app (macOS Hide) when there is nothing left
 *     to peel. ⌘W is a native-menu accelerator (main is the single interception
 *     owner — a menu accelerator fires before any renderer keydown), so the
 *     renderer never listens for ⌘W directly. Instead main sends a per-keypress
 *     request and the renderer answers with the authoritative outcome below;
 *     main hides the app ONLY on `background-app`, fail-closed otherwise.
 *     See the responder hook + the main-side menu wiring.
 */


// ── ⌘1–5 nav-rail sections ──────────────────────────────────────────────────

/** The five primary nav-rail sections, in rail order. `settings` is a bottom
 *  utility button, deliberately NOT bound to a digit. */
export type NavShortcutSection = Exclude<AppSection, 'settings'>;

/** The nav-section subset of `useNav()` this feature drives. Structural so the
 *  hook doesn't couple to the full (large) nav API shape. */
export interface NavSectionApi {
  toChat: () => void;
  toActivity: () => void;
  toTasks: () => void;
  toMembers: (agentId?: string) => void;
  toComputers: () => void;
}

/** ⌘<digit> → section, keyed on `event.code` (physical digit row) so the
 *  binding is layout-stable. Order matches the nav rail top-to-bottom. */
export const NAV_SECTION_SHORTCUTS: ReadonlyArray<{
  digit: number;
  code: string;
  section: NavShortcutSection;
}> = [
  { digit: 1, code: 'Digit1', section: 'chat' },
  { digit: 2, code: 'Digit2', section: 'activity' },
  { digit: 3, code: 'Digit3', section: 'tasks' },
  { digit: 4, code: 'Digit4', section: 'members' },
  { digit: 5, code: 'Digit5', section: 'computers' },
];

/** Route a section to its nav call. Pure (no event / DOM) so the mapping is
 *  unit-testable without a keyboard harness. */
export function dispatchNavSection(
  nav: NavSectionApi,
  section: NavShortcutSection,
): void {
  switch (section) {
    case 'chat':
      nav.toChat();
      return;
    case 'activity':
      nav.toActivity();
      return;
    case 'tasks':
      nav.toTasks();
      return;
    case 'members':
      nav.toMembers();
      return;
    case 'computers':
      nav.toComputers();
      return;
  }
}

/**
 * Global ⌘1–5 → nav-rail section switch. Ignores any combo mixing in
 * ctrl/alt/shift so it never hijacks another chord (mirrors the Cmd+\ handler).
 * `nav` is read through a ref so the always-current callbacks fire without the
 * listener re-subscribing every render.
 */
export function useNavSectionShortcuts(nav: NavSectionApi): void {
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const match = NAV_SECTION_SHORTCUTS.find(s => s.code === event.code);
      if (!match) return;
      event.preventDefault();
      dispatchNavSection(navRef.current, match.section);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

// ── ⌘W contextual close ──────────────────────────────────────────────────────

/**
 * The renderer's authoritative answer to a single ⌘W keypress. Wire contract
 * with the main process (mirror this union in `preload/api.d.ts`):
 *   • `closed-panel`   — the renderer peeled one in-app panel. Main does
 *                        nothing (the close already happened here).
 *   • `background-app` — nothing left to peel; main hides the app (macOS Hide)
 *                        it captured when the keypress fired. The window is
 *                        never destroyed — the session survives and ⌘Tab / the
 *                        dock bring it straight back.
 */
export type ContextualCloseOutcome = 'closed-panel' | 'background-app';

/** Which surface to peel this press, or none. */
type CloseTarget =
  | 'agent'
  | 'files'
  | 'side'
  | 'thread'
  | 'threads'
  | 'activity-channel'
  | null;

/** The authoritative slice of state the ⌘W ladder reads at keypress time. ⌘W
 *  acts purely on this explicit panel allowlist — a surface is closeable only
 *  if it appears here. */
export interface ContextualCloseState {
  /** Agent side-panel (`?agent`). The topmost overlay — the render layer draws
   *  it above every other pane (`agent > files > side > thread > threads`), so
   *  ⌘W peels it first; closing it reveals whatever pane it covered. */
  agentPanelId: string | null;
  filesListOpen: boolean;
  sideConversationId: string | null;
  threadRootId: string | null;
  threadsListOpen: boolean;
  /** A channel drilled into from the Activity list (`/activity/.../c/:id`) — a
   *  closeable detail that ⌘W (once every overlay above is peeled) pops back to
   *  the full-screen Activity list. The Chat section's main channel is NOT a
   *  peel target, so callers set this only for the Activity section. */
  activityChannelOpen: boolean;
}

export interface ContextualCloseResolution {
  outcome: ContextualCloseOutcome;
  target: CloseTarget;
}

/**
 * The ⌘W ladder — one layer peeled per press, top surface first. Pure so the
 * layer order is unit-testable without IPC/DOM.
 *
 * Layer 1  ?agent (Agent panel)    → close the agent side-panel (topmost overlay)
 * Layer 2  ?files (Attachments)    → close files
 * Layer 3  secondary pane          → close side / thread / threads-list, in the
 *          SAME priority the render layer resolves (`side > thread > threads`,
 *          see `layoutMemoryFromRoute`), so we peel whichever pane is actually
 *          visible when a malformed URL sets more than one.
 * Layer 4  Activity channel detail → pop back to the full-screen Activity list
 * Layer 5  nothing left            → background-app (main hides the app)
 *
 * The order mirrors the render-layer priority `agent > files > side > thread >
 * threads`, then the Activity channel underneath, so ⌘W always peels the
 * surface actually on top. The Chat section's main ChannelView is not a
 * target — when only it remains, ⌘W backgrounds the app.
 */
export function resolveContextualClose(
  state: ContextualCloseState,
): ContextualCloseResolution {
  if (state.agentPanelId != null) {
    return { outcome: 'closed-panel', target: 'agent' };
  }
  if (state.filesListOpen) return { outcome: 'closed-panel', target: 'files' };
  if (state.sideConversationId != null) {
    return { outcome: 'closed-panel', target: 'side' };
  }
  if (state.threadRootId != null) {
    return { outcome: 'closed-panel', target: 'thread' };
  }
  if (state.threadsListOpen) {
    return { outcome: 'closed-panel', target: 'threads' };
  }
  if (state.activityChannelOpen) {
    return { outcome: 'closed-panel', target: 'activity-channel' };
  }
  return { outcome: 'background-app', target: null };
}


/** The close half of `useNav()` this feature drives. Structural, as above. */
export interface ContextualCloseNav {
  closeAgentPanel: () => void;
  closeFilesList: () => void;
  closeSide: () => void;
  closeThread: () => void;
  closeThreadsList: () => void;
  /** Pop an Activity channel detail back to the full-screen Activity list. */
  toActivity: () => void;
}

type ContextualCloseRoute = Pick<
  RouteState,
  | 'section'
  | 'channelId'
  | 'agentPanelId'
  | 'filesListOpen'
  | 'sideConversationId'
  | 'threadRootId'
  | 'threadsListOpen'
>;

/**
 * Answer main's per-keypress ⌘W request with the authoritative outcome, peeling
 * the top-most panel in-place when the ladder says so. Route + nav are read
 * through a ref so every request resolves against the LATEST state (never a
 * stale closure) — this is the "authoritative per keypress" half of the
 * single-owner contract. No-ops safely until the main-side bridge exists
 * (`onContextualClose` absent), so the renderer can land ahead of main wiring.
 */
export function useContextualCloseResponder(
  route: ContextualCloseRoute,
  nav: ContextualCloseNav,
): void {
  const stateRef = useRef({ route, nav });
  stateRef.current = { route, nav };
  useEffect(() => {
    const api = window.silverhand;
    if (!api.onContextualClose || !api.respondContextualClose) return;
    return api.onContextualClose(reqId => {
      const { route, nav } = stateRef.current;
      const { outcome, target } = resolveContextualClose({
        agentPanelId: route.agentPanelId,
        filesListOpen: route.filesListOpen,
        sideConversationId: route.sideConversationId,
        threadRootId: route.threadRootId,
        threadsListOpen: route.threadsListOpen,
        // Only the Activity section's drilled-in channel is a peel target; the
        // Chat section's main channel is not (⌘W backgrounds the app there).
        activityChannelOpen:
          route.section === 'activity' && route.channelId != null,
      });
      switch (target) {
        case 'agent':
          nav.closeAgentPanel();
          break;
        case 'files':
          nav.closeFilesList();
          break;
        case 'side':
          nav.closeSide();
          break;
        case 'thread':
          nav.closeThread();
          break;
        case 'threads':
          nav.closeThreadsList();
          break;
        case 'activity-channel':
          // Base-view drill-in: navigate back to the list, NOT an overlay-param
          // clear — this is the one rung that changes the path.
          nav.toActivity();
          break;
        case null:
          break;
      }
      api.respondContextualClose(reqId, outcome);
    });
  }, []);
}
