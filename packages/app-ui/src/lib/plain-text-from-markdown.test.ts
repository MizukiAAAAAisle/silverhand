import { describe, expect, it } from "vitest";
import { plainTextFromMarkdown } from "./plain-text-from-markdown";

describe("plainTextFromMarkdown", () => {
  it("reads references and locators as the names a message shows", () => {
    expect(
      plainTextFromMarkdown("<silverhand://human/shiki> done, cc <silverhand://agent/Alice>"),
    ).toBe("@shiki done, cc @Alice");
    expect(plainTextFromMarkdown("see <silverhand://workspace/silverhand/ui%20polish>")).toBe(
      "see #ui polish",
    );
    expect(plainTextFromMarkdown("in <silverhand://workspace/silverhand>")).toBe("in silverhand");
    expect(plainTextFromMarkdown("<silverhand://dm/Cindy/shiki/abc>")).toBe("@Cindy, @shiki");
  });

  it("drops emphasis and code marks", () => {
    expect(plainTextFromMarkdown("commit **`266ab4837`** landed")).toBe("commit 266ab4837 landed");
  });

  it("leaves a reference cut off by the length cap as written", () => {
    expect(plainTextFromMarkdown("hi <silverhand://hum")).toBe("hi <silverhand://hum");
  });
});
