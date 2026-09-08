import { describe, expect, it } from "vitest";
import { parseRouteState } from "@/router";
import { resolveTaskDetailSurface } from "./task-detail-surface";

function parseRoute(path: string) {
  const url = new URL(path, "https://example.test");
  return parseRouteState(url.pathname, url.search);
}

describe("task detail surface", () => {
  it("uses a dialog only on the Tasks page", () => {
    expect(resolveTaskDetailSurface(parseRoute("/tasks?task=t"))).toBe("dialog");
    expect(resolveTaskDetailSurface(parseRoute("/tasks"))).toBeNull();
  });

  it("uses a pane in chat and activity conversations", () => {
    expect(resolveTaskDetailSurface(parseRoute("/chat/w/w/c/c?task=t"))).toBe("pane");
    expect(resolveTaskDetailSurface(parseRoute("/chat/d/d?task=t"))).toBe("pane");
    expect(resolveTaskDetailSurface(parseRoute("/activity/w/w/c/c?task=t"))).toBe("pane");
  });

  it("does not invent a modal for other pages or an empty conversation", () => {
    for (const path of [
      "/members?task=t",
      "/settings?task=t",
      "/chat?task=t",
      "/chat/saved?task=t",
      "/activity?task=t",
    ]) {
      expect(resolveTaskDetailSurface(parseRoute(path))).toBeNull();
    }
  });
});
