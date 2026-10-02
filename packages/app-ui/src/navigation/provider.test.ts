import { expect, it } from "vitest";
import { NavigationStore } from "./store";
const url = (s: NavigationStore) =>
  s.getSnapshot().location.pathname + s.getSnapshot().location.search;
it("restores independent tab histories after a new push in the previous tab", () => {
  const s = new NavigationStore("/chat");
  s.go("/chat/d/c");
  s.selectTab("tasks");
  s.go("/tasks?task=t");
  s.go("/chat/d/c");
  s.selectTab("chat");
  s.go("/chat/d/c?settings=c");
  s.selectTab("tasks");
  expect(url(s)).toBe("/chat/d/c");
  s.back();
  expect(url(s)).toBe("/tasks?task=t");
});
it("uses the same history for members, overview and conversation", () => {
  const s = new NavigationStore("/chat/d/c");
  s.go("/chat/d/c?settings=c");
  s.go("/chat/d/c?settings=c&settingsPage=members");
  s.back();
  expect(url(s)).toBe("/chat/d/c?settings=c");
  s.back();
  expect(url(s)).toBe("/chat/d/c");
});
it("Close replaces the current pane instead of going back to an earlier thread", () => {
  const s = new NavigationStore("/chat/d/c");
  s.go("/chat/d/c?thread=a");
  s.go("/chat/d/c?thread=b");
  s.go("/chat/d/c", { replace: true });
  expect(url(s)).toBe("/chat/d/c");
});
it("More belongs to its source tab and same URL tab switches publish state", () => {
  const s = new NavigationStore("/chat");
  s.selectTab("activity");
  s.go("/members");
  s.selectTab("chat");
  s.go("/members");
  s.selectTab("activity");
  expect(s.getSnapshot().tab).toBe("activity");
  s.back();
  expect(url(s)).toBe("/activity");
});
it("external links choose their tab, deep links have a parent, disposed sessions ignore callbacks", () => {
  const s = new NavigationStore("/chat/d/c?settings=c&settingsPage=members");
  s.back();
  expect(url(s)).toBe("/chat/d/c?settings=c");
  s.external("/tasks?task=t");
  expect(s.getSnapshot().tab).toBe("tasks");
  s.dispose();
  s.external("/chat/private");
  expect(url(s)).toBe("/tasks?task=t");
});
it("keeps library forward traversal within the active tab", () => {
  const s = new NavigationStore("/chat");
  s.go("/chat/d/c");
  s.go("/chat/d/c?settings=c");
  s.traverse(-1);
  expect(url(s)).toBe("/chat/d/c");
  s.traverse(1);
  expect(url(s)).toBe("/chat/d/c?settings=c");
  s.selectTab("tasks");
  s.traverse(1);
  expect(url(s)).toBe("/tasks");
});
it("Closing an overlay returns to the entry that opened it", () => {
  const s = new NavigationStore("/tasks");
  s.go("/tasks?task=t");
  s.go("/tasks", { replace: true });
  expect(url(s)).toBe("/tasks");
  expect(s.getSnapshot().canBack).toBe(false);
});
