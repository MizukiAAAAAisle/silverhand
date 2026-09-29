import { expect, it, vi } from "vitest";
import { NavigationStore } from "./store";
import type { MainTab } from "./history";

const harness = vi.hoisted(() => ({ store: null as NavigationStore | null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useLocation: () => harness.store!.getSnapshot().location,
}));
vi.mock("./provider", () => ({
  useNavigationDriver: () => harness.store!,
}));
import { useNav } from "@/router";

const tabs: MainTab[] = ["chat", "activity", "tasks"];
const utilities = ["/members", "/computers", "/settings"];
const url = (store: NavigationStore) => {
  const { location } = store.getSnapshot();
  return location.pathname + location.search;
};
const cases = tabs.flatMap((source) =>
  utilities.flatMap((utility) => tabs.map((target) => ({ source, utility, target }))),
);

it.each(cases)(
  "desktop $source → $utility → $target enters the requested section",
  ({ source, utility, target }) => {
    const store = new NavigationStore(`/${source}`);
    harness.store = store;
    // Reproduce all three histories being parked on utility pages.
    for (const tab of tabs) {
      store.selectTab(tab);
      store.go(utility);
    }
    store.selectTab(source);
    const observations: string[] = [];
    store.subscribe(() => observations.push(`${store.getSnapshot().tab}:${url(store)}`));
    const nav = useNav();
    const entries = { chat: nav.toChat, activity: nav.toActivity, tasks: nav.toTasks };
    entries[target]();
    expect(observations).toEqual([`${target}:/${target}`]);
    expect(store.getSnapshot().tab).toBe(target);
    expect(url(store)).toBe(`/${target}`);
    // Clicking the current root again adds no redundant entry/publication.
    entries[target]();
    expect(observations).toHaveLength(1);
  },
);

it("mobile Tab restoration and More Back retain the source history after desktop navigation", () => {
  const store = new NavigationStore("/chat/d/conversation");
  harness.store = store;
  store.go("/settings");
  store.selectTab("tasks");
  store.go("/tasks?task=task");
  store.go("/members");
  useNav().toActivity();
  const nav = useNav();
  nav.navigate({ kind: "tab", tab: "chat" });
  expect(url(store)).toBe("/settings");
  store.back();
  expect(url(store)).toBe("/chat/d/conversation");
  nav.navigate({ kind: "tab", tab: "tasks" });
  expect(url(store)).toBe("/members");
  store.back();
  expect(url(store)).toBe("/tasks?task=task");
});

it("same-root switches publish once, while disposed section callbacks do nothing", () => {
  const store = new NavigationStore("/chat");
  const listener = vi.fn();
  store.subscribe(listener);
  store.openSection("activity");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().tab).toBe("activity");
  store.dispose();
  store.openSection("tasks");
  expect(store.getSnapshot().tab).toBe("activity");
  expect(url(store)).toBe("/activity");
});
