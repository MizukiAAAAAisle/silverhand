/**
 * Unit tests for the pure helpers used by `CreateChannelDialog`.
 *
 * `computeCreateChannelPayload` locks the WIRE contract so the request shape
 * cannot silently regress while the form UI still looks correct.
 */
import { describe, expect, it } from "vitest";
import {
  computeCreateChannelPayload,
  computeSelectableHumans,
  pruneSelectedHumanIds,
} from "./CreateChannelDialog";

describe("computeCreateChannelPayload", () => {
  const base = {
    hasMembers: true,
    title: "  fix the login bug  ",
    selectedAgents: ["agent-alice", "agent-bob"],
    selectedHumans: [] as string[],
  };

  it("a member-bearing workspace sends visibility=private and the explicit (empty) human list", () => {
    const payload = computeCreateChannelPayload({ ...base, visibility: "private" });
    expect(payload).toEqual({
      title: "fix the login bug", // trimmed
      member_agent_ids: ["agent-alice", "agent-bob"],
      member_user_ids: [],
      visibility: "private",
    });
  });

  it("a member-bearing workspace sends visibility=public", () => {
    const payload = computeCreateChannelPayload({
      ...base,
      visibility: "public",
      selectedHumans: ["user-x"],
    });
    expect(payload.visibility).toBe("public");
    expect(payload.member_user_ids).toEqual(["user-x"]);
  });

  it("a memberless container omits visibility entirely and carries no member selection", () => {
    const payload = computeCreateChannelPayload({
      ...base,
      hasMembers: false,
      visibility: "private",
    });
    // An agent space must not put `visibility` on the wire at all — omission,
    // not a value.
    expect("visibility" in payload).toBe(false);
    expect(payload.member_agent_ids).toEqual([]);
    expect(payload.member_user_ids).toBeUndefined();
  });
});

// The creator must never be a selectable human, and the viewer query can
// resolve AFTER the members query. These falsify that members-first /
// viewer-late race: viewer-unknown must not expose the creator, and a stale
// creator selection must not survive once identity lands.
describe("creator-selection race (viewer identity resolves after members)", () => {
  const humans = [{ id: "user-creator" }, { id: "user-other1" }, { id: "user-other2" }];

  it("offers NO human candidates while the viewer identity is unknown", () => {
    expect(computeSelectableHumans(humans, null)).toEqual([]);
  });

  it("excludes the creator once the viewer identity is known", () => {
    expect(computeSelectableHumans(humans, "user-creator")).toEqual([
      { id: "user-other1" },
      { id: "user-other2" },
    ]);
  });

  it("prunes an orphaned creator id left in the selection after identity lands", () => {
    // Simulate: selected while viewer unknown (candidates were open), then the
    // viewer resolves to user-creator so the creator is no longer a candidate.
    const staleSelection = ["user-creator", "user-other1"];
    const validAfterResolve = computeSelectableHumans(humans, "user-creator").map((u) => u.id);
    expect(pruneSelectedHumanIds(staleSelection, validAfterResolve)).toEqual(["user-other1"]);
  });

  it("keeps a valid selection untouched (prune only drops orphans)", () => {
    const valid = ["user-other1", "user-other2"];
    expect(pruneSelectedHumanIds(["user-other1"], valid)).toEqual(["user-other1"]);
  });
});
