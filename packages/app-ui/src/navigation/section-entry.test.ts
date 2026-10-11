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
vi.mock("./page-stack", () => ({ usePageLive: () => true }));
import { useNav } from "@/router";

const tabs: Exclude<MainTab, "me">[] = ["chat", "activity", "tasks"];
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

it("mobile Tab restoration returns each Tab's own stack, pushed pages included", () => {
  const store = new NavigationStore("/chat/d/conversation");
  harness.store = store;
  store.selectTab("tasks");
  store.go("/tasks?task=task");
  const nav = useNav();
  nav.navigate({ kind: "tab", tab: "me" });
  store.go("/members");
  store.go("/members/u/person");
  nav.navigate({ kind: "tab", tab: "chat" });
  expect(url(store)).toBe("/chat/d/conversation");
  nav.navigate({ kind: "tab", tab: "tasks" });
  expect(url(store)).toBe("/tasks?task=task");
  nav.navigate({ kind: "tab", tab: "me" });
  expect(url(store)).toBe("/members/u/person");
  store.back();
  store.back();
  expect(url(store)).toBe("/me");
  expect(store.getSnapshot().canBack).toBe(false);
});

it("selecting the current Tab on its root publishes nothing", () => {
  const store = new NavigationStore("/me");
  const listener = vi.fn();
  store.subscribe(listener);
  store.selectTab("me");
  expect(listener).not.toHaveBeenCalled();
});

it("selecting the current Tab again pops its stack to the root", () => {
  const store = new NavigationStore("/me");
  store.go("/members");
  store.go("/members/u/person");
  store.selectTab("me");
  expect(url(store)).toBe("/me");
  expect(store.getSnapshot().canBack).toBe(false);
});

it("a deep link with no stack beneath it still returns to the Tab root", () => {
  const store = new NavigationStore("/computers?computer=host");
  store.selectTab("me");
  expect(url(store)).toBe("/me");
});

it("a Members, Computers or Settings deep link opens in Me with Me as its parent", () => {
  for (const utility of utilities) {
    const store = new NavigationStore(utility);
    expect(store.getSnapshot().tab).toBe("me");
    expect(store.getSnapshot().canBack).toBe(true);
    store.back();
    expect(url(store)).toBe("/me");
  }
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

it("desktop utility entry lands in the Me history, so folding to phone width keeps Me", () => {
  const store = new NavigationStore("/chat/d/conversation");
  const listener = vi.fn();
  store.subscribe(listener);
  store.openSection("me", "/members");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().tab).toBe("me");
  expect(url(store)).toBe("/members");
  store.openSection("chat");
  expect(url(store)).toBe("/chat");
  store.openSection("me", "/settings");
  expect(url(store)).toBe("/settings");
  store.back();
  expect(url(store)).toBe("/members");
});
