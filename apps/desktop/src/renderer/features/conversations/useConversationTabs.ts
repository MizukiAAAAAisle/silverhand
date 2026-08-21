import { useCallback, useState } from 'react';
import {
  addTab,
  firstTabKey,
  removeTab,
  reorderTabs,
  resolveActiveTabKey,
  tabKey,
  type Tab,
} from '@/lib/conversation-tabs';
import {
  getConversationTabs,
  recordConversationTabs,
} from '@/lib/place-memory';

/**
 * Renderer state layer over the per-conversation tab order (#task:2121).
 *
 * The persisted order lives in `place-memory.ts` as an identity-bound module
 * singleton (hydrated at import, wiped on logout). That store is not React
 * state, so this hook mirrors it into component state and writes through on
 * every mutation — the store stays the durable source of truth, this drives the
 * re-render.
 *
 * The ACTIVE tab is component-local and NOT persisted (shiki 2026-08-21):
 * opening a conversation enters the FIRST tab in its persisted order. Switching
 * conversations resets both the order and the active tab in render (the
 * store-previous-prop pattern) so the swap never flashes the old conversation's
 * tabs.
 *
 * `activeKey` is always resolved against the tabs that actually exist
 * ({@link resolveActiveTabKey}) so a stale target — a removed custom tab, or a
 * tab hidden by a display gate — falls back to the first tab, never a blank pane.
 */
export interface ConversationTabsController {
  /** The conversation's ordered tabs (builtins guaranteed present). */
  tabs: Tab[];
  /** The active tab's key, resolved to a present tab. */
  activeKey: string;
  /** Make a present tab active. A key naming no current tab is ignored by
   *  {@link resolveActiveTabKey} at read time. */
  setActive: (key: string) => void;
  /** Open a custom tab, or focus it if already open (#task:2122). Always makes
   *  the tab active — an already-open attachment re-clicked just refocuses. */
  openTab: (tab: Tab) => void;
  /** Remove a custom tab (builtins are non-removable). Non-destructive: only the
   *  tab leaves this conversation's layout. Active falls back to the first tab
   *  when the removed tab was active. */
  closeTab: (key: string) => void;
  /** Move the tab at `fromIndex` to `toIndex` — drag-to-reorder over the WHOLE
   *  list, builtins included. */
  reorder: (fromIndex: number, toIndex: number) => void;
}

export function useConversationTabs(
  conversationId: string,
): ConversationTabsController {
  const [tabs, setTabs] = useState<Tab[]>(() =>
    getConversationTabs(conversationId),
  );
  const [activeKey, setActiveKey] = useState<string>(() =>
    firstTabKey(getConversationTabs(conversationId)),
  );

  // Reset order + active when the conversation changes — the
  // adjust-state-during-render pattern (React's documented "store previous
  // value" form). The previous id is STATE, not a ref, on purpose: a concurrent
  // render can be started and thrown away (this hook feeds the primary pane,
  // whose `conversation.id` comes through `useDeferredValue`, so interrupted
  // renders are routine). A ref advanced during a discarded render would STICK
  // while the paired `setTabs`/`setActiveKey` were rolled back — leaving the new
  // conversation showing the old one's tabs forever. Keeping the previous id in
  // state makes the comparison transactional with the resets: discard one,
  // discard all, and the next render re-detects the change.
  const [prevId, setPrevId] = useState(conversationId);
  if (prevId !== conversationId) {
    setPrevId(conversationId);
    const next = getConversationTabs(conversationId);
    setTabs(next);
    setActiveKey(firstTabKey(next));
  }

  const setActive = useCallback((key: string) => setActiveKey(key), []);

  const openTab = useCallback(
    (tab: Tab) => {
      setTabs(prev => {
        const next = addTab(prev, tab);
        // addTab returns the SAME ref when the tab is already open (focus, no
        // duplicate); only persist a genuine append.
        if (next !== prev) recordConversationTabs(conversationId, next);
        return next;
      });
      setActiveKey(tabKey(tab));
    },
    [conversationId],
  );

  const closeTab = useCallback(
    (key: string) => {
      setTabs(prev => {
        const next = removeTab(prev, key);
        if (next === prev) return prev;
        recordConversationTabs(conversationId, next);
        // Land on the first tab when the active tab was the one removed;
        // otherwise keep the current selection (still present in `next`).
        setActiveKey(cur => resolveActiveTabKey(next, cur === key ? null : cur));
        return next;
      });
    },
    [conversationId],
  );

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      setTabs(prev => {
        const next = reorderTabs(prev, fromIndex, toIndex);
        if (next === prev) return prev;
        recordConversationTabs(conversationId, next);
        return next;
      });
    },
    [conversationId],
  );

  return {
    tabs,
    activeKey: resolveActiveTabKey(tabs, activeKey),
    setActive,
    openTab,
    closeTab,
    reorder,
  };
}
