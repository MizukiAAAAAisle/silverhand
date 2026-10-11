import { expect, it } from "vitest";

import { NavigationStore } from "./store";
import { unmountedPages } from "./page-stack";

it("keeps the page on screen, every Tab's stack and a page sliding off", () => {
  expect(
    unmountedPages(["a", "b", "c", "d"], { page: "a", keptPages: ["b"], leaving: "c" }),
  ).toEqual(["d"]);
});

it("unmounts a page once Back leaves the stack and its slide ends", () => {
  const s = new NavigationStore("/chat/d/c");
  const channel = s.getSnapshot().page;
  s.go("/chat/d/c?settings=c");
  const settings = s.getSnapshot().page;
  s.back();
  const { page, keptPages } = s.getSnapshot();
  const mounted = [channel, settings];

  expect(unmountedPages(mounted, { page, keptPages, leaving: settings })).toEqual([]);
  expect(unmountedPages(mounted, { page, keptPages })).toEqual([settings]);
});

it("keeps another Tab's stack mounted across a Tab switch", () => {
  const s = new NavigationStore("/chat/d/c");
  const channel = s.getSnapshot().page;
  s.selectTab("tasks");
  const { page, keptPages } = s.getSnapshot();

  expect(unmountedPages([channel, page], { page, keptPages })).toEqual([]);
});
