import { describe, expect, it } from "vitest";
import { locatorWorkspaceName, type LocatorWorkspaceRow } from "./locator-source";

/**
 * Fences the PRODUCER half of the locator-spellability rule: the pane owner may
 * mint a `<silverhand://workspace/<name>/...>` token ONLY for a regular
 * workspace. Both arms are load-bearing — a bare `formatPickInsertion(..., null)`
 * test proves the fallback path works but NOT that an Agent Space is actually
 * mapped to null, which is the case that would otherwise emit a permanently inert
 * locator (mirror of the resolver exclusion in `locator-target.ts`).
 */

function row(overrides: Partial<LocatorWorkspaceRow> = {}): LocatorWorkspaceRow {
  return { name: "silverhand", owner_agent_id: null, ...overrides };
}

describe("locatorWorkspaceName", () => {
  it("regular workspace → its spellable name", () => {
    expect(locatorWorkspaceName(row({ name: "silverhand", owner_agent_id: null }))).toBe(
      "silverhand",
    );
  });

  it("Agent Space → null (name is not one this grammar can spell)", () => {
    // The row HAS a name, but the resolver's fold indexes `owner_agent_id IS
    // NULL` only, so a locator minted from it would render inert — fall back.
    expect(locatorWorkspaceName(row({ name: "Alice", owner_agent_id: "agent-1" }))).toBeNull();
  });

  it("missing / unresolved row → null (workspace-less or not yet loaded)", () => {
    expect(locatorWorkspaceName(null)).toBeNull();
    expect(locatorWorkspaceName(undefined)).toBeNull();
  });
});
