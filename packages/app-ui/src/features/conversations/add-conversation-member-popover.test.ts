/**
 * Falsifiers for the add-member picker's authority mirror. `addConversationMember`
 * grades a roster write by TWO independent factors, and only the second one is
 * modelled here:
 *
 *  - the FLOOR (membership of this conversation) is target-independent and
 *    belongs to the call site's `gate.allowMutations` — which is why neither
 *    helper below takes it, and why owning an agent can never read as a way
 *    into a channel the viewer is not in.
 *  - the TARGET grades by kind + ownership (#task:1683): any member may add
 *    the agents they CREATED, in the workspace already or not; every human and
 *    everybody else's agent stays workspace-`admin` governance.
 *  - #task:1681 — ownership comes from `useAgents({ scope: 'owned' })`, the
 *    backend's authority for "mine", never from a client-side predicate.
 *  - #task:1600 — no pool is narrowed by the workspace's storage computer (the
 *    old `a.host_id === workspaceHostId` filter is gone), so a guest agent on
 *    another computer stays pickable.
 */
import { describe, expect, it } from "vitest";
import type { AgentDto } from "@silverhand/shared";
import {
  canAddForeignConversationMembers,
  computePickableAgents,
} from "./add-conversation-member-popover";

function agent(id: string, hostId: string): AgentDto {
  return { id, name: id, runtime: "claude", host_id: hostId } as AgentDto;
}

describe("canAddForeignConversationMembers", () => {
  it("is governance — owner/admin only", () => {
    expect(canAddForeignConversationMembers("owner")).toBe(true);
    expect(canAddForeignConversationMembers("admin")).toBe(true);
  });

  it("a plain member (and a viewer of unknown role) may not add humans or foreign agents", () => {
    expect(canAddForeignConversationMembers("member")).toBe(false);
    expect(canAddForeignConversationMembers(null)).toBe(false);
  });
});

describe("computePickableAgents", () => {
  // Workspace members, one of them created by someone else.
  const wsAgents = [agent("member-1", "host-home"), agent("foreign-member", "host-other-a")];
  const ownedAgents = [
    agent("member-1", "host-home"), // already a member — deduped
    agent("own-same-host", "host-home"),
    agent("own-guest", "host-other-b"),
  ];

  it("offers an admin the workspace agents plus their own non-member agents, deduped", () => {
    expect(computePickableAgents(wsAgents, ownedAgents, "admin").map((a) => a.id)).toEqual([
      "member-1",
      "foreign-member",
      "own-same-host",
      "own-guest",
    ]);
  });

  it("offers a plain member their OWN agents only — including ones not in the workspace yet", () => {
    // `foreign-member` is in the workspace, so adding it would enroll nothing,
    // and it is still refused: the server answers `agent_not_owned` on the
    // ownership axis, which no roster fact cancels (#task:1683).
    expect(computePickableAgents(wsAgents, ownedAgents, "member").map((a) => a.id)).toEqual([
      "member-1",
      "own-same-host",
      "own-guest",
    ]);
  });

  it("offers nothing to a viewer with no agents of their own", () => {
    expect(computePickableAgents(wsAgents, [], "member")).toEqual([]);
  });

  it("never asks the user to enroll first: an own agent outside the workspace stays pickable, whatever the role", () => {
    // Load-bearing product design (shiki, reaffirmed 2026-07-28): adding an
    // agent to a channel auto-enrolls it into the workspace when it is not a
    // member yet. So "not in the workspace" must NEVER be a reason to drop a
    // candidate — a picker that hid these would turn one action into two and
    // silently reintroduce a workspace step the backend removed.
    const outsiders = ["own-same-host", "own-guest"];
    for (const role of ["owner", "admin", "member"] as const) {
      const ids = computePickableAgents(wsAgents, ownedAgents, role).map((a) => a.id);
      for (const id of outsiders) expect(ids).toContain(id);
    }
  });

  it("never narrows on the host axis, whatever the role (#task:1600)", () => {
    for (const role of ["admin", "member"] as const) {
      const hosts = new Set(
        computePickableAgents(wsAgents, ownedAgents, role).map((a) => a.host_id),
      );
      expect(hosts.size).toBeGreaterThan(1);
    }
    // No workspace-host argument to filter by — and no conversation-membership
    // argument either: that floor is the call site's, not this pool's.
    expect(computePickableAgents.length).toBe(3);
  });
});
