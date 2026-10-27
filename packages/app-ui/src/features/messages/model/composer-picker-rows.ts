import type { ChannelSourceStatus, PickerItem } from "./composer-picker";
import { t } from "@/lib/i18n";

/** A candidate as both pickers show it; the face is the renderer's to draw. */
export interface PickerRowView {
  key: string;
  item: PickerItem;
  title: string;
  /** A handle, set in monospace. */
  handle?: string;
  detail?: string;
  /** A header that starts a section at this row. */
  section?: string;
  /** A candidate outside the conversation, drawn quieter. */
  dimmed: boolean;
}

export interface PickerView {
  rows: PickerRowView[];
  /** How many matches the cap left out. */
  more: string | null;
  /** The `#` source still loading, or partly unavailable. */
  status: { loading: boolean; label: string } | null;
}

export function rowKey(item: PickerItem): string {
  if (item.kind === "agent") return `a:${item.agent.id}`;
  if (item.kind === "human") return `h:${item.human.id}`;
  return `c:${item.channel.id}`;
}

/**
 * The picker's rows for the web menu and the native list alike.
 *
 * With `peopleSections`, people split into "In this channel" / "Other
 * channels" at the first candidate outside the conversation. Both headers need
 * a non-empty in-section: without one the whole list is "other" and a lone
 * header labels nothing, so the list stays flat. Channel rows carry no
 * membership and never start a section.
 */
export function pickerViewOf({
  items,
  hiddenCount,
  channelStatus,
  peopleSections,
  showChannelWorkspace,
}: {
  items: readonly PickerItem[];
  hiddenCount: number;
  channelStatus: ChannelSourceStatus;
  peopleSections: boolean;
  showChannelWorkspace: boolean;
}): PickerView {
  const hasInSection =
    peopleSections && items.some((item) => item.kind !== "channel" && item.inConversation);
  const boundary = hasInSection
    ? items.findIndex((item) => item.kind !== "channel" && !item.inConversation)
    : -1;

  const rows = items.map((item, i): PickerRowView => {
    const section =
      i === 0 && hasInSection
        ? t("messages.inThisChannel")
        : i === boundary
          ? t("messages.otherChannels")
          : undefined;
    const key = rowKey(item);
    if (item.kind === "channel") {
      return {
        key,
        item,
        title: item.channel.title,
        detail: showChannelWorkspace ? (item.workspaceName ?? undefined) : undefined,
        section,
        dimmed: false,
      };
    }

    const person = item.kind === "agent" ? item.agent : item.human;
    return {
      key,
      item,
      title: person.display_name?.trim() || person.name,
      handle: `@${person.name}`,
      detail: item.kind === "agent" ? item.agent.runtime : "human",
      section,
      dimmed: !item.inConversation,
    };
  });

  return {
    rows,
    more: hiddenCount > 0 ? `+${hiddenCount} more` : null,
    status:
      channelStatus === "loading"
        ? { loading: true, label: t("messages.loadingChannels") }
        : channelStatus === "partial_error"
          ? { loading: false, label: t("messages.someChannelsUnavailable") }
          : null,
  };
}

/** The picture a person row shows, from the pane's resolved avatar URLs. */
export function avatarUrlOf(
  item: PickerItem,
  agentAvatarUrls: Map<string, string | null>,
  humanAvatarUrls: Map<string, string | null>,
): string | null {
  if (item.kind === "agent") return agentAvatarUrls.get(item.agent.id) ?? null;
  if (item.kind === "human") return humanAvatarUrls.get(item.human.id) ?? null;
  return null;
}
