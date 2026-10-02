import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { SearchIdentities } from "@silverhand/shared";
import { TitlebarSearch } from "./titlebar-search";

const state = vi.hoisted(() => ({
  identities: undefined as SearchIdentities | undefined,
  error: false,
  filters: {} as Record<string, unknown>,
  clicks: [] as (() => void)[],
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (value: unknown) => actual.useState(value === "" ? "Discover" : value),
  };
});
vi.mock("@radix-ui/react-popover", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => children;
  return { Root: Wrapper, Trigger: Wrapper, Portal: Wrapper, Content: Wrapper };
});
vi.mock("@/features/search/hooks", () => ({
  useMessageSearch: (filters: Record<string, unknown>) => {
    state.filters = filters;
    return {
      data: { results: [], identities: state.identities },
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/features/agents/hooks/hooks", () => ({ useAgents: () => ({ data: [] }) }));
vi.mock("@/features/direct-pairs/hooks", () => ({ useDirectPairs: () => [] }));
vi.mock("@/features/agents/hooks/avatar-hooks", () => ({
  useAgentAvatarObjectUrls: () => new Map(),
}));
vi.mock("@/features/messages/hooks/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => ({ agentAvatarUrls: new Map(), humanAvatarUrls: new Map() }),
}));
vi.mock("@/components/layout/collection-item-card", () => ({
  CollectionItemCard: ({ onClick, children }: { onClick: () => void; children: ReactNode }) => {
    state.clicks.push(onClick);
    return createElement("button", null, children);
  },
}));
const nav = {
  onJumpMessage: vi.fn(),
  onOpenConversation: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onOpenDirectPair: vi.fn(),
  onOpenDirectDraft: vi.fn(),
  onOpenAdvanced: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  state.clicks = [];
  state.error = false;
  state.identities = {
    status: "searched",
    humans: {
      results: [
        {
          kind: "human",
          id: "same",
          name: "person",
          display_name: "Discover Human",
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
          id: "same",
          name: "agent",
          display_name: "Discover Agent",
          avatar_url: null,
          runtime: "codex",
        },
      ],
      total: 1,
      truncated: false,
    },
  };
});
it("uses server identities for titlebar rows and typed DM navigation with an empty directory", () => {
  const html = renderToStaticMarkup(createElement(TitlebarSearch, { nav }));
  expect(state.filters.include_identities).toBe(true);
  expect(html).toContain("Discover Human");
  expect(html).toContain("Discover Agent");
  state.clicks[0]!();
  state.clicks[1]!();
  expect(nav.onOpenDirectDraft.mock.calls).toEqual([
    [{ kind: "human", id: "same" }],
    [{ kind: "agent", id: "same" }],
  ]);
});
it("shows search failure instead of presenting stale identities or a false no-results state", () => {
  state.error = true;
  const html = renderToStaticMarkup(createElement(TitlebarSearch, { nav }));
  expect(html).toContain("Search failed");
  expect(html).not.toContain("Discover Human");
  expect(html).not.toContain("No results");
});
