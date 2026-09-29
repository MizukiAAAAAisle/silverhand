import { describe, expect, it } from "vitest";
import { parentUrl } from "./history";
import { resolveNavigationTarget } from "@/router";
describe("navigation targets", () => {
  it.each([
    ["/chat/w/w/c/c?thread=r&files=1", "/chat/w/w/c/c?thread=r"],
    ["/chat/w/w/c/c?thread=r", "/chat/w/w/c/c"],
    ["/chat/w/w/c/c?settings=c", "/chat/w/w/c/c"],
    ["/chat/w/w/c/c", "/chat"],
    ["/activity/d/c", "/activity"],
    ["/members/u/person", "/members"],
    ["/settings?settingsSection=connection", "/settings"],
    ["/computers?computer=host", "/computers"],
    ["/chat", null],
  ])("deep link %s has a safe parent", (url, parent) => expect(parentUrl(url!)).toBe(parent));
  it("one semantic target preserves the current activity placement", () => {
    expect(
      resolveNavigationTarget({ kind: "thread", rootMessageId: "r" }, "/activity/d/c", ""),
    ).toBe("/activity/d/c?thread=r");
    expect(resolveNavigationTarget({ kind: "attachments" }, "/chat/d/c", "?thread=r")).toBe(
      "/chat/d/c?thread=r&files=1",
    );
  });
});
