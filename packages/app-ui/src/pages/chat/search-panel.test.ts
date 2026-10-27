import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { SearchIdentities } from "@silverhand/shared";
import { SearchPanel, SEARCH_FILTER_DEFAULT } from "./search-panel";
import { t } from "@/lib/i18n";

vi.mock("@/navigation/layout", () => ({ useCompactLayout: () => true }));
vi.mock("@/platform", () => ({ getPlatform: () => ({}) }));
vi.mock("@/navigation/page-stack", () => ({ usePageLive: () => true }));

const state = vi.hoisted(() => ({
  identities: undefined as SearchIdentities | undefined,
  error: false,
  loading: false,
  filters: {} as Record<string, unknown>,
}));
vi.mock("@/features/users/hooks", () => ({
  useUsers: () => ({ data: [] }),
  useUsersById: () => new Map(),
  makeUserNameResolver: () => () => null,
}));
vi.mock("@/features/agents/hooks/hooks", () => ({ useAgents: () => ({ data: [] }) }));
vi.mock("@/features/search/hooks", () => ({
  useMessageSearch: (filters: Record<string, unknown>) => {
    state.filters = filters;
    return {
      data: { results: [], identities: state.identities },
      isLoading: state.loading,
      isFetching: state.loading,
      isError: state.error,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/features/messages/hooks/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => ({ agentAvatarUrls: new Map(), humanAvatarUrls: new Map() }),
}));
vi.mock("@/features/agents/hooks/avatar-hooks", () => ({
  useAgentAvatarObjectUrls: () => new Map(),
}));
vi.mock("@/features/direct-pairs/hooks", () => ({ useDirectPairs: () => [] }));
vi.mock("@/router", () => ({ useNav: () => ({ toDirect: vi.fn(), toDirectDraft: vi.fn() }) }));
vi.mock("@/features/search/sender-filter-select", () => ({
  SenderFilterSelect: () => null,
  parseSenderFilter: () => ({}),
}));
const render = () =>
  renderToStaticMarkup(
    createElement(SearchPanel, {
      workspaces: [],
      initialQuery: "alice",
      filter: SEARCH_FILTER_DEFAULT,
      onFilterChange: vi.fn(),
      onJumpMessage: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenConversation: vi.fn(),
    }),
  );
beforeEach(() => {
  state.error = false;
  state.loading = false;
  state.identities = {
    status: "searched",
    humans: {
      results: [
        {
          kind: "human",
          id: "other",
          name: "alice",
          display_name: "Server Identity",
          avatar_url: null,
          runtime: null,
        },
      ],
      total: 1,
      truncated: false,
    },
    agents: { results: [], total: 0, truncated: false },
  };
});
it("requests identities and renders only the server identity without a directory join", () => {
  expect(render()).toContain("Server Identity");
  expect(state.filters.include_identities).toBe(true);
  expect(render()).not.toContain(t("chat.noMatches"));
});
it("uses the server's filtered state rather than applying a second frontend filter", () => {
  state.identities = {
    status: "filtered",
    humans: { results: [], total: 0, truncated: false },
    agents: { results: [], total: 0, truncated: false },
  };
  expect(render()).toContain(t("chat.clearProjectSenderAnd"));
});
it("does not turn query failure into empty identities or show retained identity data", () => {
  state.error = true;
  const html = render();
  expect(html).toContain(t("chat.searchFailed"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain("Server Identity");
  expect(html).not.toContain(t("chat.noMatches"));
});
it("has a real empty state when the server has no identity or content hits", () => {
  state.identities!.humans = { results: [], total: 0, truncated: false };
  expect(render()).toContain(t("chat.noMatches"));
});

it("keeps the search visible while compact filters start collapsed", () => {
  state.loading = true;
  const html = render();
  expect(html).toContain('aria-label="Show filters"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-label="Filters" hidden=""');
  expect(html).toContain('value="alice"');
  expect(state.filters.q).toBe("alice");
});
