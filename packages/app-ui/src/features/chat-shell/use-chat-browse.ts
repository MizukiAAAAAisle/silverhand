import { useEffect, useState } from "react";
import { useRouteState } from "@/router";
import { SAVED_FILTER_DEFAULT, type SavedFilterState } from "@/features/chat-shell/saved-list-view";
import { SEARCH_FILTER_DEFAULT, type SearchFilterState } from "@/features/chat-shell/search-panel";
import {
  ARCHIVED_FILTER_DEFAULT,
  type ArchivedFilterState,
} from "@/features/chat-shell/archived-channels-panel";
import { senderFilterFromParam } from "@/features/search/sender-filter-select";

/** Session filters survive presentation changes; URL seeds remain one-way. */
export function useChatBrowse() {
  const route = useRouteState();

  const [savedFilter, setSavedFilter] = useState<SavedFilterState>(SAVED_FILTER_DEFAULT);

  const [searchFilter, setSearchFilter] = useState<SearchFilterState>(SEARCH_FILTER_DEFAULT);

  const seedReset = route.searchFilterReset;

  const seedWorkspace = route.searchWorkspace;

  const seedSender = route.searchSender;

  useEffect(() => {
    if (route.chatView !== "search") {
      return;
    }
    if (!seedReset) {
      return;
    }
    const sender = senderFilterFromParam(seedSender);
    setSearchFilter({
      ...SEARCH_FILTER_DEFAULT,
      ...(seedWorkspace ? { workspace: `workspace:${seedWorkspace}` as const } : {}),
      ...(sender ? { sender } : {}),
    });
  }, [route.chatView, seedReset, seedWorkspace, seedSender]);

  const [archivedFilter, setArchivedFilter] =
    useState<ArchivedFilterState>(ARCHIVED_FILTER_DEFAULT);

  return {
    savedFilter,
    setSavedFilter,
    searchFilter,
    setSearchFilter,
    archivedFilter,
    setArchivedFilter,
  };
}
