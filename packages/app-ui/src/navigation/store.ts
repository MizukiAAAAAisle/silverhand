import {
  createMemoryHistory,
  parsePath,
  type Location,
  type MemoryHistory,
} from "@remix-run/router";
import { MAIN_TABS, mainTab, parentUrl, type MainTab } from "./history";

const urlOf = (location: Location) => location.pathname + location.search;

/** A page outlives replaces of its entry, so closing a pane keeps the page
 * mounted; a push starts a new page. `pages` lists the pages beneath it, so
 * Back can return to each as it was left. */
type EntryState = {
  page?: string;
  pages?: string[];
  parent?: { key: string; url: string; page: string };
};
const stateOf = (location: Location) => (location.state as EntryState | null) ?? {};
const pageOf = (location: Location) => stateOf(location).page ?? location.key;
const stackOf = (location: Location) => [...(stateOf(location).pages ?? []), pageOf(location)];

/** Pages kept per Tab, the one on top included. Deeper pages remount on Back. */
const KEPT_PER_TAB = 8;

/** Library histories own the entries; the Router and address bar project the active entry. */
export class NavigationStore {
  readonly session = crypto.randomUUID();
  get active() {
    return !this.disposed;
  }
  private histories: Record<MainTab, MemoryHistory>;
  private tab: MainTab;
  private listeners = new Set<() => void>();
  private revision = 0;
  private disposed = false;
  private snapshot!: ReturnType<NavigationStore["read"]>;
  constructor(url: string) {
    this.tab = mainTab(url) ?? "chat";
    this.histories = Object.fromEntries(
      MAIN_TABS.map((tab) => [
        tab,
        createMemoryHistory({
          initialEntries: [
            {
              ...parsePath(tab === this.tab ? url : `/${tab}`),
              key: crypto.randomUUID(),
              state: { page: crypto.randomUUID() },
            },
          ],
          v5Compat: true,
        }),
      ]),
    ) as Record<MainTab, MemoryHistory>;
    for (const history of Object.values(this.histories)) history.listen(() => this.publish());
    this.snapshot = this.read();
  }
  private get history() {
    return this.histories[this.tab];
  }
  private read() {
    const location = this.history.location;
    const fallback = parentUrl(urlOf(location));
    return {
      tab: this.tab,
      location,
      action: this.history.action,
      revision: this.revision,
      page: pageOf(location),
      keptPages: MAIN_TABS.flatMap((tab) =>
        stackOf(this.histories[tab].location).slice(-KEPT_PER_TAB),
      ),
      back: stateOf(location).parent,
      canBack: this.history.index > 0 || fallback !== null,
    };
  }
  private publish() {
    if (this.disposed) return;
    this.revision++;
    this.snapshot = this.read();
    this.listeners.forEach((listener) => listener());
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  go = (url: string, options?: { replace?: boolean }) => {
    if (this.disposed || url === urlOf(this.history.location)) return;
    const current = this.history.location;
    const parent = stateOf(current).parent;
    // Closing an overlay lands on the entry that opened it. Pop instead of
    // replacing, or the stack keeps a duplicate and Back shows on a root page.
    if (options?.replace && parent?.url === url && this.history.index > 0) {
      this.history.go(-1);
      return;
    }
    if (options?.replace) this.history.replace(url, current.state);
    else
      this.history.push(url, {
        page: crypto.randomUUID(),
        pages: stackOf(current).slice(1 - KEPT_PER_TAB),
        parent: { key: current.key, url: urlOf(current), page: pageOf(current) },
      } satisfies EntryState);
  };
  back = () => {
    if (this.disposed) return;
    if (this.history.index > 0) this.history.go(-1);
    else {
      const parent = parentUrl(urlOf(this.history.location));
      if (parent) this.history.replace(parent);
    }
  };
  traverse = (delta: number) => {
    if (this.disposed) return;
    if (delta === -1) this.back();
    else this.history.go(delta);
  };
  /** A Tab restores its own stack, including any page pushed on it.
   * Selecting the current Tab again returns to its root, as on iOS. Unfolded,
   * a Duo shows no back button, so this is how a pushed page is left there. */
  selectTab = (tab: MainTab) => {
    if (this.disposed) return;
    if (this.tab !== tab) {
      this.tab = tab;
      this.publish();
      return;
    }
    const root = `/${tab}`;
    if (urlOf(this.history.location) === root) return;
    if (this.history.index > 0) this.history.go(-this.history.index);
    if (urlOf(this.history.location) !== root) this.history.replace(root);
  };
  /** Desktop section entry is a destination, unlike restoring a mobile Tab.
   * Publish only the final entry so no saved utility page flashes in between.
   * Members, Computers and Settings enter the Me history, so folding a Duo
   * back to phone width shows them under the Me tab. */
  openSection = (tab: MainTab, root = `/${tab}`) => {
    if (this.disposed) return;
    const changedTab = this.tab !== tab;
    this.tab = tab;
    if (urlOf(this.history.location) !== root) this.go(root);
    else if (changedTab) this.publish();
  };
  external = (url: string) => {
    if (this.disposed) return;
    const tab = mainTab(url);
    if (tab) this.selectTab(tab);
    this.go(url);
  };
  activate = () => {
    this.disposed = false;
  };
  dispose = () => {
    this.disposed = true;
    this.listeners.clear();
  };
}
