import { HashIcon, MessageResultIcon } from "@/icons";
import dayjs from "dayjs";
import type { AgentDto, SearchIdentity, SearchResultDto } from "@silverhand/shared";

import { AVATAR_PX } from "@/components/avatar-scale";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { CollectionItemCard } from "@/components/layout/collection-item-card";
import { isAgentSpace } from "@/features/workspaces/workspace-ownership";

import { buildExcerpt, highlightText } from "@/features/search/highlight";
import { MessageResultMeta } from "@/features/search/message-result-meta";
import { t } from "@/lib/i18n";

/** Shared search-result row for both the advanced Search page and the titlebar
 *  popover. Each host maps its own data to `SearchItem`. */
export type SearchItem =
  | { kind: "workspace"; result: Extract<SearchResultDto, { type: "workspace" }> }
  | { kind: "conversation"; result: Extract<SearchResultDto, { type: "conversation" }> }
  | { kind: "message"; result: Extract<SearchResultDto, { type: "message" }> }
  | { kind: "identity"; candidate: SearchIdentity };

/**
 * The leading icon square is width-gated, not host-gated: `data-search-item-icon`
 * shows only when the `search-list` container is wide enough (see `chrome.css`).
 * Identity and agent-space rows are exempt — their avatar is identity, not type
 * chrome — so they stay visible at every width.
 */
export function SearchResultItem({
  item,
  query,
  active,
  agentsById,
  ownerAgentAvatarUrls,
  agentAvatarUrls,
  userAvatarUrls,
  identityAgentAvatars,
  identityHumanAvatars,
  onMouseEnter,
  onClick,
}: {
  item: SearchItem;
  query: string;
  active?: boolean;
  agentsById: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
  agentAvatarUrls: Map<string, string | null>;
  userAvatarUrls: Map<string, string | null>;
  /** Directory avatar bytes for an identity row's own face; distinct from the
   *  message-author maps. Defaults to those when a host shares one directory. */
  identityAgentAvatars?: Map<string, string | null>;
  identityHumanAvatars?: Map<string, string | null>;
  onMouseEnter?: () => void;
  onClick: () => void;
}): JSX.Element {
  return (
    <CollectionItemCard
      as="button"
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-active={active ? "" : undefined}
      className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left"
    >
      <SearchItemLeading
        item={item}
        agentsById={agentsById}
        ownerAgentAvatarUrls={ownerAgentAvatarUrls}
        identityAgentAvatars={identityAgentAvatars ?? agentAvatarUrls}
        identityHumanAvatars={identityHumanAvatars ?? userAvatarUrls}
      />
      <span className="min-w-0 flex-1">
        <SearchItemBody
          item={item}
          query={query}
          agentAvatarUrls={agentAvatarUrls}
          userAvatarUrls={userAvatarUrls}
        />
      </span>
    </CollectionItemCard>
  );
}

function SearchItemLeading({
  item,
  agentsById,
  ownerAgentAvatarUrls,
  identityAgentAvatars,
  identityHumanAvatars,
}: {
  item: SearchItem;
  agentsById: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
  identityAgentAvatars: Map<string, string | null>;
  identityHumanAvatars: Map<string, string | null>;
}): JSX.Element {
  if (item.kind === "identity") {
    const identity = item.candidate;
    return (
      <span className="flex shrink-0 self-center">
        {item.candidate.kind === "human" ? (
          <UserAvatar size={AVATAR_PX.md} avatarObjectUrl={identityHumanAvatars.get(identity.id)} />
        ) : (
          <AgentAvatar
            size={AVATAR_PX.md}
            runtime={item.candidate.runtime}
            avatarObjectUrl={identityAgentAvatars.get(identity.id)}
          />
        )}
      </span>
    );
  }
  // Agent space: owner avatar is identity, not type chrome, so always visible.
  if (item.kind === "workspace" && isAgentSpace(item.result.workspace)) {
    return (
      <span className="flex shrink-0 self-center">
        <WorkspaceIcon
          ownerAgentId={item.result.workspace.owner_agent_id}
          agentsById={agentsById}
          ownerAgentAvatarUrls={ownerAgentAvatarUrls}
          size={AVATAR_PX.md}
        />
      </span>
    );
  }
  return (
    <span
      data-search-item-icon
      data-collection-card-icon
      className="hidden size-8 shrink-0 items-center justify-center self-center rounded-(--chip-radius) bg-bg-base text-text-muted"
    >
      {item.kind === "workspace" ? (
        <WorkspaceIcon
          ownerAgentId={item.result.workspace.owner_agent_id}
          agentsById={agentsById}
          ownerAgentAvatarUrls={ownerAgentAvatarUrls}
          size={AVATAR_PX.md}
        />
      ) : item.kind === "conversation" ? (
        <HashIcon className="size-4" />
      ) : (
        <MessageResultIcon className="size-4" />
      )}
    </span>
  );
}

function SearchItemBody({
  item,
  query,
  agentAvatarUrls,
  userAvatarUrls,
}: {
  item: SearchItem;
  query: string;
  agentAvatarUrls: Map<string, string | null>;
  userAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  if (item.kind === "message") {
    const excerpt = buildExcerpt(item.result.message.content, query);
    return (
      <>
        <MessageResultMeta
          result={item.result}
          agentAvatarUrls={agentAvatarUrls}
          humanAvatarUrls={userAvatarUrls}
        />
        {excerpt ? (
          <span className="mt-0.5 block max-h-10 overflow-hidden text-sm leading-5 text-text-secondary">
            {highlightText(excerpt, query)}
          </span>
        ) : null}
      </>
    );
  }

  if (item.kind === "identity") {
    return (
      <>
        <span className="block truncate text-sm text-text-primary">
          {item.candidate.display_name}
        </span>
        <span className="block truncate text-xs text-text-muted">@{item.candidate.name}</span>
      </>
    );
  }

  const meta =
    item.kind === "workspace" ? workspaceMeta(item.result) : conversationMeta(item.result);
  const title =
    item.kind === "workspace" ? item.result.workspace.name : item.result.conversation.title;
  const archived =
    item.kind === "conversation"
      ? item.result.conversation.archived_at !== null
      : item.kind === "workspace"
        ? item.result.workspace.archived_at !== null
        : false;
  return (
    <>
      {meta.length > 0 || archived ? (
        <span className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          {meta.map((entry, index) => (
            <span key={`${index}:${entry}`} className="min-w-0 truncate">
              {entry}
            </span>
          ))}
          {archived ? (
            <span className="shrink-0 rounded-(--pill-radius) bg-bg-elevated px-1.5 py-0.5 text-(length:--text-badge) uppercase tracking-wider text-text-muted">
              {t("common.archived")}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="block truncate text-sm font-medium text-text-primary">
        {highlightText(title, query)}
      </span>
    </>
  );
}

function workspaceMeta(result: Extract<SearchResultDto, { type: "workspace" }>): string[] {
  return [isAgentSpace(result.workspace) ? t("search.agentSpace") : t("search.project")];
}

function conversationMeta(result: Extract<SearchResultDto, { type: "conversation" }>): string[] {
  // Type is carried by the leading `#` glyph, so meta is workspace name + time.
  const created = dayjs(result.conversation.created_at).format("YYYY-MM-DD HH:mm");
  return result.conversation.placement_kind === "workspace"
    ? [result.conversation.workspace.name, created]
    : [created];
}
