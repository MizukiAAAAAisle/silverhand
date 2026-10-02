import { describe, expect, it } from "vitest";
import type { MessageAuthorDto } from "@silverhand/shared";
import {
  authorGroupKey,
  authorStateLabel,
  classifyRowAuthor,
  collectAuthorAvatarSources,
  isSameAuthorGroup,
  presentAuthor,
} from "./author-presentation";

const activeAgent: MessageAuthorDto = {
  kind: "agent",
  status: "active",
  id: "agent-1",
  name: "norman",
  display_name: "Norman",
  avatar_url: "/api/agents/agent-1/avatar?v=2",
  runtime: "claude",
};
const activeUser: MessageAuthorDto = {
  kind: "user",
  status: "active",
  id: "user-1",
  name: "shiki",
  display_name: "Shiki",
  avatar_url: null,
  runtime: null,
};
const deletedAgent: MessageAuthorDto = {
  kind: "agent",
  status: "deleted",
  id: "agent-gone",
  name: "luna",
  display_name: "Luna",
  avatar_url: null,
};
const unresolvedAgent: MessageAuthorDto = {
  kind: "agent",
  status: "unresolved",
  id: null,
  name: null,
  display_name: null,
  avatar_url: null,
};
const unresolvedUser: MessageAuthorDto = {
  kind: "user",
  status: "unresolved",
  id: null,
  name: null,
  display_name: null,
  avatar_url: null,
};

describe("presentAuthor", () => {
  it("active agent → runtime avatar + navigable, no deleted marker", () => {
    const p = presentAuthor(activeAgent);
    expect(p).toMatchObject({
      label: "Norman",
      kind: "agent",
      status: "active",
      isDeleted: false,
      navigableId: "agent-1",
      avatar: { variant: "agent", id: "agent-1", runtime: "claude" },
    });
  });

  it("active user → user avatar + navigable", () => {
    const p = presentAuthor(activeUser);
    expect(p).toMatchObject({
      label: "Shiki",
      kind: "user",
      status: "active",
      isDeleted: false,
      navigableId: "user-1",
      avatar: { variant: "user", id: "user-1" },
    });
  });

  it("falls back to name when display_name is blank", () => {
    expect(presentAuthor({ ...activeAgent, display_name: "   " }).label).toBe("norman");
  });

  it("deleted agent → snapshot name, deleted marker, neutral avatar, NOT navigable", () => {
    const p = presentAuthor(deletedAgent);
    expect(p).toMatchObject({
      label: "Luna",
      kind: "agent",
      status: "deleted",
      isDeleted: true,
      navigableId: null,
      avatar: { variant: "neutral-agent" },
    });
  });

  it('unresolved agent → "Unknown agent", NO deleted marker, neutral avatar, NOT navigable', () => {
    const p = presentAuthor(unresolvedAgent);
    expect(p).toMatchObject({
      label: "Unknown agent",
      kind: "agent",
      status: "unresolved",
      isDeleted: false,
      navigableId: null,
      avatar: { variant: "neutral-agent" },
    });
  });

  it('unresolved user → "Unknown user"', () => {
    expect(presentAuthor(unresolvedUser).label).toBe("Unknown user");
  });
});

describe("authorGroupKey / isSameAuthorGroup", () => {
  it("same active author groups", () => {
    expect(isSameAuthorGroup(activeAgent, { ...activeAgent })).toBe(true);
  });

  it("deleted author groups by stable snapshot id", () => {
    expect(isSameAuthorGroup(deletedAgent, { ...deletedAgent })).toBe(true);
  });

  it("two unresolved authors NEVER group (distinct lost actors, not one)", () => {
    expect(authorGroupKey(unresolvedAgent)).toBeNull();
    expect(isSameAuthorGroup(unresolvedAgent, unresolvedAgent)).toBe(false);
    expect(isSameAuthorGroup(unresolvedAgent, unresolvedUser)).toBe(false);
  });

  it("system row (null author) never groups", () => {
    expect(authorGroupKey(null)).toBeNull();
    expect(isSameAuthorGroup(null, null)).toBe(false);
  });

  it("different actors / kinds do not group", () => {
    expect(isSameAuthorGroup(activeAgent, activeUser)).toBe(false);
    expect(isSameAuthorGroup(activeAgent, deletedAgent)).toBe(false);
  });
});

describe("authorStateLabel", () => {
  it("appends the deleted suffix ONLY for a deleted author", () => {
    expect(authorStateLabel(presentAuthor(deletedAgent))).toBe("Luna (deleted account)");
  });

  it("leaves an active author as its plain label", () => {
    expect(authorStateLabel(presentAuthor(activeAgent))).toBe("Norman");
  });

  it('an unresolved author is "Unknown …", NEVER "(deleted account)"', () => {
    expect(authorStateLabel(presentAuthor(unresolvedAgent))).toBe("Unknown agent");
  });
});

describe("collectAuthorAvatarSources — the active-DTO-only avatar fence (#task:1792 B2)", () => {
  it("emits ONLY active authors, carrying each DTO's own avatar_url", () => {
    const { agents, users } = collectAuthorAvatarSources([activeAgent, activeUser]);
    // The bytes ride the DTO's avatar_url — never a directory join, so a
    // directory that has never loaded this author still resolves.
    expect(agents).toEqual([{ id: "agent-1", avatar_url: "/api/agents/agent-1/avatar?v=2" }]);
    expect(users).toEqual([{ id: "user-1", avatar_url: null }]);
  });

  it("excludes deleted, unresolved and system authors from the batch", () => {
    const { agents, users } = collectAuthorAvatarSources([
      deletedAgent,
      unresolvedAgent,
      unresolvedUser,
      null, // system row
    ]);
    expect(agents).toEqual([]);
    expect(users).toEqual([]);
  });

  it("de-dupes a repeated author id to one source", () => {
    const { agents } = collectAuthorAvatarSources([
      activeAgent,
      { ...activeAgent },
      { ...activeAgent, display_name: "Renamed" },
    ]);
    expect(agents).toEqual([{ id: "agent-1", avatar_url: "/api/agents/agent-1/avatar?v=2" }]);
  });
});

// The actor-row precondition fence (#task:1792, Alice + Cindy). These pin the
// invariant that `author:null` (system, no identity) and `unresolved` (a lost
// actor) are DISTINCT and never conflated — the exact violation the removed
// `?? unresolvedAuthorFor` fabrication in MessageItem committed.
describe("classifyRowAuthor", () => {
  it("classifies a system row (author null) as system, NEVER an actor", () => {
    const row = classifyRowAuthor("system", null);
    expect(row).toEqual({ kind: "system" });
    // Prove it is not coerced into an actor identity of any status.
    expect(row).not.toHaveProperty("author");
  });

  it("classifies a non-system row missing its author as missing, NOT unresolved", () => {
    for (const fromKind of ["agent", "user"] as const) {
      const row = classifyRowAuthor(fromKind, null);
      expect(row).toEqual({ kind: "missing", reason: "absent" });
      // A missing carrier must never manufacture an `unresolved` actor — that
      // would assert "unrecoverable" from "not loaded".
      expect(row).not.toHaveProperty("author");
    }
  });

  it("fails closed when raw from_kind disagrees with the DTO author.kind", () => {
    // The resolver derives author.kind from from_kind, so a mismatch is data
    // corruption, never a legal combination. It must not render as an actor
    // (viewer alignment + identity would come from two conflicting facts).
    expect(classifyRowAuthor("user", activeAgent)).toEqual({
      kind: "missing",
      reason: "kind-mismatch",
    });
    expect(classifyRowAuthor("agent", activeUser)).toEqual({
      kind: "missing",
      reason: "kind-mismatch",
    });
  });

  it("passes a resolved author whose kind matches straight through as an actor row", () => {
    for (const author of [activeAgent, activeUser, deletedAgent, unresolvedAgent]) {
      expect(classifyRowAuthor(author.kind, author)).toEqual({
        kind: "actor",
        author,
      });
    }
  });
});
