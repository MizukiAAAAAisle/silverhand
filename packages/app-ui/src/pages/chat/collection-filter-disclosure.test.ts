import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SavedListView, SAVED_FILTER_DEFAULT } from "./saved-list-view";
import { ArchivedChannelsPanel, ARCHIVED_FILTER_DEFAULT } from "./archived-channels-panel";
import { t } from "@/lib/i18n";

const state = vi.hoisted(() => ({ compact: true }));
vi.mock("@/navigation/layout", () => ({ useCompactLayout: () => state.compact }));
vi.mock("@/platform", () => ({ getPlatform: () => ({}) }));
vi.mock("@/navigation/page-stack", () => ({ usePageLive: () => true }));
vi.mock("@/features/users/hooks", () => ({
  useUsers: () => ({ data: [] }),
  useUsersById: () => new Map(),
  makeUserNameResolver: () => () => null,
}));
vi.mock("@/features/agents/hooks/hooks", () => ({ useAgents: () => ({ data: [] }) }));
vi.mock("@/features/agents/hooks/avatar-hooks", () => ({
  useAgentAvatarObjectUrls: () => new Map(),
}));
vi.mock("@/features/messages/hooks/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => ({ agentAvatarUrls: new Map(), humanAvatarUrls: new Map() }),
}));
vi.mock("@/features/messages/saved", () => ({
  useSavedMessages: () => ({ data: [], isLoading: false }),
  useUnsaveMessage: () => ({}),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useArchivedChannelsIndex: () => ({ data: [], isLoading: false, isFetching: true }),
  useArchiveChannel: () => ({}),
  useArchiveWorkspace: () => ({}),
}));

beforeEach(() => {
  state.compact = true;
});

function saved(active: boolean) {
  return renderToStaticMarkup(
    createElement(SavedListView, {
      workspaces: [],
      filter: { ...SAVED_FILTER_DEFAULT, workspace: active ? "workspace:missing" : "all" },
      onFilterChange: vi.fn(),
      onJump: vi.fn(),
    }),
  );
}

it("keeps the compact Saved filter action when active filters yield no results", () => {
  const html = saved(true);
  expect(html).toContain(t("chat.noMatches"));
  expect(html).toContain(`aria-label="${t("ui.filters.showActive")}"`);
  expect(html).toContain(`aria-label="${t("ui.filters.label")}" hidden=""`);
});

it("preserves Saved's original no-collection behavior and desktop visibility", () => {
  expect(saved(false)).not.toContain(`aria-label="${t("ui.filters.label")}"`);
  state.compact = false;
  const html = saved(true);
  expect(html).toContain(`aria-label="${t("ui.filters.label")}"`);
  expect(html).not.toContain(`aria-label="${t("ui.filters.label")}" hidden=`);
  expect(html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0]).not.toContain("aria-controls=");
});

it("starts Archived with its compact filters collapsed", () => {
  const html = renderToStaticMarkup(
    createElement(ArchivedChannelsPanel, {
      workspaces: [],
      filter: ARCHIVED_FILTER_DEFAULT,
      onFilterChange: vi.fn(),
      onOpenChannel: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenWorkspaceSettings: vi.fn(),
    }),
  );
  expect(html).toContain(`aria-label="${t("ui.filters.show")}"`);
  expect(html).toContain(`aria-label="${t("ui.filters.label")}" hidden=""`);
});
