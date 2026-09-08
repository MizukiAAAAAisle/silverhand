/**
 * #task:1156 collapsed four drifted workspace labels into one canonical helper;
 * #task:2066 then retired the `dm-` prefix that made the helper necessary, so
 * the label IS `workspace.name` and there is nothing left to pin — the tests
 * that pinned "both name shapes converge" are gone with the second shape.
 *
 * What survives is the one label that is NOT the workspace's name:
 * `agentSpaceRecognitionName`, read by the rail row AND the titlebar. The drift shiki
 * caught in #task:1768 was exactly those two disagreeing (rail showing the
 * display name, titlebar the handle), so its precedence stays fenced.
 */
import { describe, expect, it } from "vitest";
import { agentSpaceRecognitionName } from "./workspace-name";

describe("agentSpaceRecognitionName — precedence", () => {
  it("prefers the resolved agent display name", () => {
    expect(
      agentSpaceRecognitionName("Norman", { display_name: "Norman Osborn", name: "Norman" }),
    ).toBe("Norman Osborn");
  });

  it("falls back to the handle when the display name is blank", () => {
    // Whitespace-only counts as blank: a display name the user cleared must not
    // render as an empty titlebar.
    expect(agentSpaceRecognitionName("Norman", { display_name: "   ", name: "Norman" })).toBe(
      "Norman",
    );
  });

  it("falls back to the workspace name when the agent is unresolved", () => {
    // The workspace name IS the handle for an agent space, so an unresolved
    // agent degrades to the same word rather than to a blank.
    expect(agentSpaceRecognitionName("Norman", undefined)).toBe("Norman");
  });

  it("carries no `@` — that form is the direct pair's (#task:2044)", () => {
    expect(agentSpaceRecognitionName("Norman", { display_name: "Norman" })).not.toContain("@");
  });
});
