import { useState, type ReactNode } from "react";
import { SearchIcon } from "@/icons";
import { SEARCH_FIELD_FRAME } from "@/components/common/control-ink-border";
import { ConversationMemberSearch } from "@/features/conversations/add-conversation-member-popover";
import {
  ChannelMembersContent,
  type ChannelMembersContentProps,
} from "./channel-view/channel-members-content";
import { t } from "@/lib/i18n";

/** One search filters the roster and offers additions through the existing candidate authority. */
export function ChannelMembersPage({
  workspaceId,
  autoFocus,
  actions,
  ...roster
}: Omit<ChannelMembersContentProps, "query"> & {
  workspaceId: string | null;
  autoFocus: boolean;
  actions: ReactNode;
}): JSX.Element {
  const [query, setQuery] = useState("");
  return (
    <div className="flex flex-col gap-4">
      {workspaceId ? (
        <ConversationMemberSearch
          workspaceId={workspaceId}
          conversationId={roster.channelId}
          autoFocus={autoFocus}
          mode="floating"
          onQueryChange={setQuery}
        />
      ) : (
        <label data-input="" className={SEARCH_FIELD_FRAME}>
          <SearchIcon className="size-3.5 shrink-0 text-text-muted" aria-hidden />
          <input
            autoFocus={autoFocus}
            aria-label={t("conversationShell.searchMembers")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("conversationShell.searchMembers")}
            className="w-full min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
      )}
      <ChannelMembersContent {...roster} query={query} />
      {actions}
    </div>
  );
}
