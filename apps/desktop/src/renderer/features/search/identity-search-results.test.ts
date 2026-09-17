import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentDto, DirectPairListItem, UserDto } from "@silverhand/shared";
import { identitySearchGroups } from "./identity-results";
import { IdentitySearchResults } from "./identity-search-results";

const state = vi.hoisted(() => ({
  pairs: [] as DirectPairListItem[],
  clicks: [] as (() => void)[],
  direct: vi.fn(),
  draft: vi.fn(),
}));
vi.mock("@/router", () => ({
  useNav: () => ({ toDirect: state.direct, toDirectDraft: state.draft }),
}));
vi.mock("@/features/direct-pairs/hooks", () => ({ useDirectPairs: () => state.pairs }));
vi.mock("@/features/agent-shell/hooks/avatar-hooks", () => ({
  useAgentAvatarObjectUrls: () => new Map(),
}));
vi.mock("@/components/layout/collection-item-card", () => ({
  CollectionItemCard: ({ onClick, children }: { onClick: () => void; children: ReactNode }) => {
    state.clicks.push(onClick);
    return createElement("button", null, children);
  },
}));
const human: UserDto = {
  id: "same",
  name: "alice",
  display_name: "Alice",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
};
const agent = { ...human, session_scope: "agent", runtime: "codex" } as AgentDto;
const groups = () => identitySearchGroups("alice", [human], [agent], "self");
beforeEach(() => {
  state.pairs = [];
  state.clicks = [];
  vi.clearAllMocks();
});

it("opens typed drafts without a create/send mutation", () => {
  const html = renderToStaticMarkup(createElement(IdentitySearchResults, { groups: groups() }));
  expect(html).toContain("Humans");
  expect(html).toContain("Agents");
  state.clicks[0]!();
  state.clicks[1]!();
  expect(state.draft.mock.calls).toEqual([
    [{ kind: "human", id: "same" }],
    [{ kind: "agent", id: "same" }],
  ]);
  expect(state.direct).not.toHaveBeenCalled();
});
it("reuses the exact typed pair rather than a colliding ID", () => {
  state.pairs = [
    {
      conversation_id: "human-pair",
      counterpart: { ...human, kind: "human", status: "active", runtime: null },
      created_at: 0,
      unread_count: 0,
      read_only: false,
    },
  ];
  renderToStaticMarkup(createElement(IdentitySearchResults, { groups: groups() }));
  state.clicks[0]!();
  state.clicks[1]!();
  expect(state.direct).toHaveBeenCalledWith("human-pair");
  expect(state.draft).toHaveBeenCalledWith({ kind: "agent", id: "same" });
});
it("makes category truncation explicit", () => {
  const result = identitySearchGroups(
    "alice",
    Array.from({ length: 25 }, (_, i) => ({ ...human, id: `u${i}` })),
    [],
    "self",
  );
  const html = renderToStaticMarkup(createElement(IdentitySearchResults, { groups: result }));
  expect(html).toContain("Showing 20 of 25. Refine the name to find more.");
  expect(state.clicks).toHaveLength(20);
});
