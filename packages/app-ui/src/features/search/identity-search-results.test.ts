import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { DirectPairListItem, UserDto, SearchIdentities } from "@silverhand/shared";
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
vi.mock("@/features/agents/hooks/avatar-hooks", () => ({
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
const groups = (): SearchIdentities => ({
  status: "searched",
  humans: {
    results: [
      {
        kind: "human",
        id: human.id,
        name: human.name,
        display_name: human.display_name,
        avatar_url: null,
        runtime: null,
      },
    ],
    total: 1,
    truncated: false,
  },
  agents: {
    results: [
      {
        kind: "agent",
        id: human.id,
        name: human.name,
        display_name: human.display_name,
        avatar_url: null,
        runtime: "codex",
      },
    ],
    total: 1,
    truncated: false,
  },
});
beforeEach(() => {
  state.pairs = [];
  state.clicks = [];
  vi.clearAllMocks();
});

it("opens typed drafts without a create/send mutation", () => {
  const html = renderToStaticMarkup(createElement(IdentitySearchResults, { identities: groups() }));
  expect(html).toContain("Human &amp; Agents");
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
  renderToStaticMarkup(createElement(IdentitySearchResults, { identities: groups() }));
  state.clicks[0]!();
  state.clicks[1]!();
  expect(state.direct).toHaveBeenCalledWith("human-pair");
  expect(state.draft).toHaveBeenCalledWith({ kind: "agent", id: "same" });
});
it("makes category truncation explicit", () => {
  const result = groups();
  result.humans = {
    results: Array.from({ length: 20 }, (_, i) => ({ ...result.humans.results[0]!, id: `u${i}` })),
    total: 25,
    truncated: true,
  };
  result.agents = { results: [], total: 0, truncated: false };
  const html = renderToStaticMarkup(createElement(IdentitySearchResults, { identities: result }));
  expect(html).toContain("Showing 20 of 25. Refine the name to find more.");
  expect(state.clicks).toHaveLength(20);
});
