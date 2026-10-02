import dayjs from "dayjs";
import { Clock } from "lucide-react";
import type { SearchResultDto } from "@silverhand/shared";

import { AVATAR_PX } from "@/components/avatar-scale";
import { ChannelIcon } from "@/components/channel-icon";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { AuthorAvatarView, AuthorName } from "@/features/messages/components/author-avatar-view";
import { presentAuthor } from "@/features/messages/model/author-presentation";

/**
 * Shared message-result meta line: workspace icon + channel sticker + sender +
 * time. A `direct_pair` hit is placeless, so it shows sender + time only
 * (#task:2060). Author identity flows through `presentAuthor` (#task:1792).
 */
export function MessageResultMeta({
  result,
  agentAvatarUrls,
  humanAvatarUrls,
}: {
  result: Extract<SearchResultDto, { type: "message" }>;
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  const presentation = result.message.author ? presentAuthor(result.message.author) : null;
  const senderName = presentation?.label ?? "System";
  const place = result.conversation;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
      {place.placement_kind === "workspace" ? (
        <>
          <span className="flex min-w-0 items-center gap-1">
            <WorkspaceIcon ownerAgentId={place.workspace.owner_agent_id} />
            <span className="truncate">{place.workspace.name}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1">
            <ChannelIcon variant="sticker" density="sm" />
            <span className="truncate">{place.title}</span>
          </span>
        </>
      ) : null}
      <span className="flex min-w-0 items-center gap-1">
        <AuthorAvatarView
          avatar={presentation?.avatar ?? { variant: "neutral-user" }}
          size={AVATAR_PX.xs}
          label={senderName}
          agentAvatarUrls={agentAvatarUrls}
          humanAvatarUrls={humanAvatarUrls}
        />
        {presentation ? (
          <AuthorName presentation={presentation} className="truncate" />
        ) : (
          <span className="truncate">{senderName}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 tabular-nums">
        <Clock aria-hidden className="size-3.5 shrink-0" />
        {dayjs(result.message.created_at).format("YYYY-MM-DD HH:mm")}
      </span>
    </span>
  );
}
