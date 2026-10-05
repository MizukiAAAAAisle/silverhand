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
    // Park all three histories on utility pages, ending on the source.
    for (const tab of [...tabs.filter((tab) => tab !== source), source]) {
      store.selectTab(tab);
      store.go(utility);
    }
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

it("mobile Tab restoration lands on the Tab's own page, not a More page parked on it", () => {
  const store = new NavigationStore("/chat/d/conversation");
  harness.store = store;
  store.go("/settings");
  store.selectTab("tasks");
  store.go("/tasks?task=task");
  store.go("/members");
  useNav().toActivity();
  const nav = useNav();
  const observations: string[] = [];
  store.subscribe(() => observations.push(`${store.getSnapshot().tab}:${url(store)}`));
  nav.navigate({ kind: "tab", tab: "chat" });
  expect(observations).toEqual(["chat:/chat/d/conversation"]);
  nav.navigate({ kind: "tab", tab: "tasks" });
  expect(url(store)).toBe("/tasks?task=task");
});

it("selecting the current Tab from a More page returns to the Tab's page", () => {
  const store = new NavigationStore("/tasks?task=task");
  store.go("/members");
  store.selectTab("tasks");
  expect(url(store)).toBe("/tasks?task=task");
});

it("restoration leaves every stacked More page", () => {
  const store = new NavigationStore("/activity");
  store.go("/members");
  store.go("/members/u/person");
  store.selectTab("chat");
  store.selectTab("activity");
  expect(url(store)).toBe("/activity");
});

it("a Tab whose only entry is a More page restores to its root", () => {
  const store = new NavigationStore("/settings");
  store.selectTab("tasks");
  store.selectTab("chat");
  expect(url(store)).toBe("/chat");
  expect(store.getSnapshot().canBack).toBe(false);
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
