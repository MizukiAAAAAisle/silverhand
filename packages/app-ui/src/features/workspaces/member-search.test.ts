/**
 * #task:1680 — the member picker advertises "search by name or @handle", and
 * `@alice` is how a handle is written everywhere else in the product. No
 * field stores the sigil, so these falsifiers pin that the advertised
 * spelling and the bare one behave identically, and that a lone `@` is read
 * as "no query yet" rather than "no matches".
 */
import { describe, expect, it } from "vitest";
import type { AgentDto, UserDto } from "@silverhand/shared";
import { matchesCandidate, normalizeMemberQuery, type MemberCandidate } from "./member-search";

const alice: MemberCandidate = {
  kind: "agent",
  agent: { id: "a1", name: "alice", display_name: "Alice" } as AgentDto,
};
const shiki: MemberCandidate = {
  kind: "human",
  user: { id: "u1", name: "shiki", display_name: "Shiki" } as UserDto,
};

function matches(candidate: MemberCandidate, typed: string): boolean {
  return matchesCandidate(candidate, normalizeMemberQuery(typed));
}

describe("normalizeMemberQuery", () => {
  it("strips exactly one leading @ and lowercases", () => {
    expect(normalizeMemberQuery("@Alice")).toBe("alice");
    expect(normalizeMemberQuery("  @alice  ")).toBe("alice");
    expect(normalizeMemberQuery("@@alice")).toBe("@alice");
  });

  it("reads a lone @ as no query", () => {
    expect(normalizeMemberQuery("@")).toBe("");
    expect(normalizeMemberQuery(" @ ")).toBe("");
  });
});

describe("matchesCandidate", () => {
  it("finds a handle whether or not the @ is typed", () => {
    expect(matches(alice, "alice")).toBe(true);
    expect(matches(alice, "@alice")).toBe(true);
    expect(matches(alice, "@ali")).toBe(true);
  });

  it("still matches display names", () => {
    expect(matches(shiki, "Shi")).toBe(true);
    expect(matches(shiki, "@shi")).toBe(true);
  });

  it("a lone @ keeps everyone visible", () => {
    expect(matches(alice, "@")).toBe(true);
    expect(matches(shiki, "@")).toBe(true);
  });

  it("a doubled sigil finds nothing — no handle can contain it", () => {
    expect(matches(alice, "@@alice")).toBe(false);
  });

  it("non-matching text is excluded", () => {
    expect(matches(alice, "shiki")).toBe(false);
    expect(matches(shiki, "@alice")).toBe(false);
  });
});
