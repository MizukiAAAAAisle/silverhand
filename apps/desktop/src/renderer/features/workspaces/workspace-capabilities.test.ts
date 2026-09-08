/**
 * The container-ownership → UI capability derivation (#task:2066, re-axed off the
 * retired kind in #task:2078). These lock the three facts the two workspace
 * dialogs steer on, so the mapping cannot drift
 * while both dialogs still look correct: an Agent Space silently answering the
 * regular shape is exactly the failure that grows a member picker (and posts
 * `member_*_ids` / `visibility`) inside a space that has no members.
 */
import { describe, expect, it } from "vitest";
import { workspaceCapabilities } from "./workspace-capabilities";

describe("workspaceCapabilities", () => {
  it("an agent space has no settable name, no members and no lifecycle", () => {
    expect(workspaceCapabilities({ owner_agent_id: "a-1" })).toEqual({
      nameSettable: false,
      hasMembers: false,
      hasLifecycle: false,
    });
  });

  it("a regular workspace has all three", () => {
    expect(workspaceCapabilities({ owner_agent_id: null })).toEqual({
      nameSettable: true,
      hasMembers: true,
      hasLifecycle: true,
    });
  });

  it("no container answers the regular shape (not the agent-space one)", () => {
    // Deliberate: answering the agent-space shape would print "takes its name
    // from its agent" for a container that does not exist. Safe only because
    // every caller takes the workspace id from the same row (`App.tsx`), so an
    // unresolved row means no id and nothing actionable — not "regular
    // capabilities against a live target".
    expect(workspaceCapabilities(null)).toEqual(workspaceCapabilities({ owner_agent_id: null }));
    expect(workspaceCapabilities(undefined)).toEqual(
      workspaceCapabilities({ owner_agent_id: null }),
    );
  });
});
