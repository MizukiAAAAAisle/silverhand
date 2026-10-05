import {
  createMemoryHistory,
  parsePath,
  type Location,
  type MemoryHistory,
} from "@remix-run/router";
import { mainTab, parentUrl, type MainTab } from "./history";
import { isMoreDestination } from "./presentation";

const urlOf = (location: Location) => location.pathname + location.search;

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
      (["chat", "activity", "tasks"] as const).map((tab) => [
        tab,
        createMemoryHistory({
          initialEntries: [
            { ...parsePath(tab === this.tab ? url : `/${tab}`), key: crypto.randomUUID() },
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
      back: (location.state as { parent?: { key: string; url: string } } | null)?.parent,
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
    const parent = (current.state as { parent?: { url: string } } | null)?.parent;
    // Closing an overlay lands on the entry that opened it. Pop instead of
    // replacing, or the stack keeps a duplicate and Back shows on a root page.
    if (options?.replace && parent?.url === url && this.history.index > 0) {
      this.history.go(-1);
      return;
    }
    if (options?.replace) this.history.replace(url, current.state);
    else this.history.push(url, { parent: { key: current.key, url: urlOf(current) } });
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
  /** A Tab restores its own stack. A More page parked on top belongs to More,
   * not to the Tab, so restoring lands on the Tab's page beneath it. */
  selectTab = (tab: MainTab) => {
    if (this.disposed) return;
    const history = this.histories[tab];
    const onMore = isMoreDestination(history.location.pathname);
    if (this.tab === tab && !onMore) return;
    this.tab = tab;
    if (!onMore) {
      this.publish();
      return;
    }
    // More pages can stack (`/members` → `/members/u/…`); leave all of them.
    while (history.index > 0 && isMoreDestination(history.location.pathname)) history.go(-1);
    if (isMoreDestination(history.location.pathname)) history.replace(`/${tab}`);
  };
  /** Desktop section entry is a destination, unlike restoring a mobile Tab.
   * Publish only the final entry so no saved utility page flashes in between. */
  openSection = (tab: MainTab) => {
    if (this.disposed) return;
    const changedTab = this.tab !== tab;
    this.tab = tab;
    const root = `/${tab}`;
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
