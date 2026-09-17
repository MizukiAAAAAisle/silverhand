import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentDto, UserDto } from "@silverhand/shared";
import { SearchPanel, SEARCH_FILTER_DEFAULT } from "./search-panel";

const state = vi.hoisted(() => ({
  users: [] as UserDto[],
  agents: [] as AgentDto[],
  humanError: false,
  agentError: false,
  humanLoading: false,
  messageLoading: false,
}));
vi.mock("@/features/users/hooks", () => ({
  useUsers: () => ({
    data: state.users,
    isLoading: state.humanLoading,
    isError: state.humanError,
    refetch: vi.fn(),
  }),
  useUsersById: () => new Map(),
  makeUserNameResolver: () => () => null,
}));
vi.mock("@/features/agent-shell/hooks/hooks", () => ({
  useAgents: () => ({
    data: state.agents,
    isLoading: false,
    isError: state.agentError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/session/current-user", () => ({ getCurrentUserId: () => "self" }));
vi.mock("@/features/search/hooks", () => ({
  useMessageSearch: () => ({
    data: { results: [] },
    isLoading: state.messageLoading,
    isFetching: state.messageLoading,
  }),
}));
vi.mock("@/components/chat/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => ({ agentAvatarUrls: new Map(), humanAvatarUrls: new Map() }),
}));
vi.mock("@/features/agent-shell/hooks/avatar-hooks", () => ({
  useAgentAvatarObjectUrls: () => new Map(),
}));
vi.mock("@/features/direct-pairs/hooks", () => ({ useDirectPairs: () => [] }));
vi.mock("@/router", () => ({ useNav: () => ({ toDirect: vi.fn(), toDirectDraft: vi.fn() }) }));
vi.mock("@/components/ui/sender-filter-select", () => ({
  SenderFilterSelect: () => null,
  parseSenderFilter: () => ({}),
}));
const user: UserDto = {
  id: "other",
  name: "alice",
  display_name: "Found human",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
};
const render = (filter = SEARCH_FILTER_DEFAULT) =>
  renderToStaticMarkup(
    createElement(SearchPanel, {
      workspaces: [],
      initialQuery: "alice",
      filter,
      onFilterChange: vi.fn(),
      onJumpMessage: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenConversation: vi.fn(),
    }),
  );
beforeEach(() => {
  state.users = [user];
  state.agents = [];
  state.humanError = false;
  state.agentError = false;
  state.humanLoading = false;
  state.messageLoading = false;
});

it("renders independent identity results even while content search is loading", () => {
  state.messageLoading = true;
  expect(render()).toContain("Found human");
});
it("does not show a global no-matches state when identities matched", () => {
  expect(render()).toContain("Found human");
  expect(render()).not.toContain("No matches");
});
it("shows an explicit directory error and suppresses retained stale results", () => {
  state.humanError = true;
  const html = render();
  expect(html).toContain("Could not load humans.");
  expect(html).toContain("Retry");
  expect(html).not.toContain("Found human");
  expect(html).not.toContain("No matches");
});
it("preserves successful identity groups when the other directory fails", () => {
  state.agentError = true;
  const html = render();
  expect(html).toContain("Found human");
  expect(html).toContain("Could not load agents.");
});
it("explains why content filters hide identity discovery", () => {
  const html = render({ ...SEARCH_FILTER_DEFAULT, time: "today" });
  expect(html).toContain("Clear workspace, sender and time filters");
  expect(html).not.toContain("Found human");
});
it("does not mistake a pending directory for an empty one", () => {
  state.users = [];
  state.humanLoading = true;
  expect(render()).toContain("Searching people and agents");
  expect(render()).not.toContain("No matches");
});
