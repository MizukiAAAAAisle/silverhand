import { describe, expect, it } from "vitest";
import type { AgentDto, UserDto } from "@silverhand/shared";
import { candidateKey } from "@/features/workspaces/member-search";
import { identitySearchGroups, includesIdentityResults } from "./identity-results";

const human = (id: string, name = "alice"): UserDto => ({
  id,
  name,
  display_name: "Alice",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
});
const agent = (id: string, scope: "agent" | "conversation" = "agent") =>
  ({ ...human(id), runtime: "codex", session_scope: scope }) as AgentDto;
const rows = (groups: ReturnType<typeof identitySearchGroups>) =>
  groups.flatMap((group) => group.items.map(candidateKey));

describe("private-message identity discovery", () => {
  it("finds unrelated humans from the global directory without workspace or DM facts", () => {
    expect(
      rows(identitySearchGroups("@ALICE", [human("stranger"), human("self")], [], "self")),
    ).toEqual(["human:stranger"]);
  });
  it("matches display names and excludes conversation-scoped agents", () => {
    expect(
      rows(
        identitySearchGroups(
          "Alice",
          [],
          [agent("cross"), agent("channel", "conversation")],
          "self",
        ),
      ),
    ).toEqual(["agent:cross"]);
  });
  it("does not fabricate agents absent from the server-visible directory", () => {
    expect(rows(identitySearchGroups("alice", [], [], "self"))).toEqual([]);
  });
  it("keeps colliding human/agent IDs and names distinct", () => {
    expect(rows(identitySearchGroups("alice", [human("same")], [agent("same")], "self"))).toEqual([
      "human:same",
      "agent:same",
    ]);
  });
  it.each(["", "  ", "@"])("does not enumerate a directory for query %j", (q) => {
    expect(identitySearchGroups(q, [human("other")], [agent("cross")], "self")).toEqual([]);
  });
  it("does not expose self actions before viewer resolution", () => {
    expect(identitySearchGroups("alice", [human("self")], [], null)).toEqual([]);
  });
  it("bounds each category independently and reports complete match counts", () => {
    const users = Array.from({ length: 25 }, (_, i) => human(`u${i}`));
    const agents = Array.from({ length: 23 }, (_, i) => agent(`a${i}`));
    const groups = identitySearchGroups("alice", users, agents, "self");
    expect(groups.map((group) => [group.items.length, group.total])).toEqual([
      [20, 25],
      [20, 23],
    ]);
    expect(identitySearchGroups("alice", users.toReversed(), agents.toReversed(), "self")).toEqual(
      groups,
    );
  });
  it("only enables identity discovery without content filters", () => {
    const all = { workspace: "all", sender: "all", time: "all" };
    expect(includesIdentityResults(all)).toBe(true);
    for (const field of ["workspace", "sender", "time"] as const) {
      expect(includesIdentityResults({ ...all, [field]: "selected" })).toBe(false);
    }
  });
});
