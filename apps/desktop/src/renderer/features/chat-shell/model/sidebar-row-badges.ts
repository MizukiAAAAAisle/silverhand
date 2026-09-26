import type { ChannelAttentionModeRowDto, FavoriteRowDto } from "@silverhand/shared";
import { channelRowBadge } from "@/features/attention/attention-mode";

/** Reveal and paint from the same badge verdict, including directed unread under mute. */
export function favoriteRowBadge(
  item: Pick<FavoriteRowDto, "roster_policy" | "unread_count">,
  attention: ChannelAttentionModeRowDto | undefined,
) {
  return channelRowBadge({
    effectiveMode: item.roster_policy === "open" ? attention?.effective_mode : "all",
    positionalUnread: item.unread_count ?? 0,
    directedUnread: attention?.directed_unread_count ?? 0,
  });
}

export function directRowBadge(unread: number) {
  return channelRowBadge({ effectiveMode: "all", positionalUnread: unread, directedUnread: 0 });
}
