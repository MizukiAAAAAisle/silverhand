import {
  forwardRef,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQueries } from "@tanstack/react-query";
import type { ChannelAttentionModeRowDto, DirectPairCounterpart } from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { AVATAR_PX } from "@/components/avatar-scale";
import { ChannelIcon } from "@/components/channel-icon";
import { StarIcon, ThreadIcon } from "@/icons";
import { MutedMarker, UnreadBadge } from "@/components/layout/sidebar-shared";
import { SidebarRowsSkeleton } from "@/components/layout/sidebar-skeleton";
import type { RowBadge } from "@/features/attention/attention-mode";
import { useAttentionModesAcrossWorkspaces } from "@/features/attention/hooks";
import { messageUnreadByConversationQuery } from "@/features/channels/message-unread";
import {
  useConversationLatest,
  type ConversationLatest,
} from "@/features/conversations/latest/use-conversation-latest";
import { useDirectPairsList } from "@/features/direct-pairs/hooks";
import { directLinePairVisibleInSidebar } from "@/features/direct-pairs/direct-line-rows";
import {
  collectCounterpartAvatarSources,
  presentCounterpart,
} from "@/features/direct-pairs/counterpart-presentation";
import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { AuthorAvatarView } from "@/features/messages/components/author-avatar-view";
import { presentAuthor } from "@/features/messages/model/author-presentation";
import {
  useArchiveChannel,
  useChannelsAcrossWorkspaces,
  useStarChannel,
} from "@/features/workspaces/hooks";
import { AppContextMenu } from "@/components/menus/app-context-menu";
import { useFavoritesList } from "@/features/workspaces/favorites";
import { useViewerUser } from "@/features/session/hooks";
import { channelNodeBadge, directRowBadge } from "../model/sidebar-row-badges";
import { orderRecentRows, recentPreviewText, recentTimeLabel } from "../model/recent-rows";
import { ChannelRowMenuItems } from "./channel-row-menu-items";
import type { WorkspaceItem } from "./workspaces-panel";

type RecentListRow =
  | {
      kind: "channel";
      id: string;
      createdAt: number;
      latest: ConversationLatest | null;
      title: string;
      workspaceId: string;
      workspaceName: string;
      visibility: "public" | "private" | undefined;
      rosterPolicy: "open" | "fixed";
      attention: ChannelAttentionModeRowDto | undefined;
      workspaceMuted: boolean | undefined;
      badge: RowBadge | null;
      muted: boolean;
    }
  | {
      kind: "direct";
      id: string;
      createdAt: number;
      latest: ConversationLatest | null;
      counterpart: DirectPairCounterpart;
      badge: RowBadge | null;
    };

/**
 * The Recent sidebar: every conversation the viewer is in, newest message first,
 * pinned (starred) rows on top. Rows come from the same lists as the tree, so
 * leaving a conversation removes its row the way it does there; the latest
 * summary only supplies the preview line and the order.
 */
export function RecentList(props: {
  workspaces: readonly WorkspaceItem[];
  selectedConversationId: string | null;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onSelectDirectPair: (conversationId: string) => void;
  /** Opens a thread reply where it was written. */
  onOpenThread: (target: {
    workspaceId: string | null;
    conversationId: string;
    threadRootId: string;
    messageId: string;
  }) => void;
  /** Icon actions held at the end of the filter row; null where a native bar
   *  carries them. */
  actions: ReactNode;
}): JSX.Element {
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);

  const liveWorkspaces = useMemo(
    () => props.workspaces.filter((w) => !w.archived),
    [props.workspaces],
  );
  const workspaceIds = useMemo(() => liveWorkspaces.map((w) => w.id), [liveWorkspaces]);
  const workspaceNames = useMemo(
    () => new Map(liveWorkspaces.map((w) => [w.id, w.name])),
    [liveWorkspaces],
  );

  const channelLists = useChannelsAcrossWorkspaces(workspaceIds);
  const unreadLists = useQueries({
    queries: workspaceIds.map((id) => messageUnreadByConversationQuery(id)),
  });
  const { byChannel: attentionByChannel, mutedByWorkspace } =
    useAttentionModesAcrossWorkspaces(workspaceIds);
  const pairsQuery = useDirectPairsList();
  const favorites = useFavoritesList();
  const latest = useConversationLatest();
  const viewer = useViewerUser();

  const pinned = useMemo(
    () => new Set((favorites.data?.items ?? []).map((item) => item.entity_id)),
    [favorites.data],
  );

  const rows: RecentListRow[] = [];
  workspaceIds.forEach((workspaceId, index) => {
    const unread = unreadLists[index]?.data?.by_conversation ?? {};
    for (const channel of channelLists[index]?.data ?? []) {
      if (channel.is_member !== true || channel.archived_at !== null) {
        continue;
      }

      const attention: ChannelAttentionModeRowDto | undefined = attentionByChannel.get(channel.id);
      rows.push({
        kind: "channel",
        id: channel.id,
        createdAt: channel.created_at,
        latest: latest?.get(channel.id) ?? null,
        title: channel.title,
        workspaceId,
        workspaceName: workspaceNames.get(workspaceId) ?? "",
        visibility: channel.roster_policy === "open" ? channel.visibility : undefined,
        rosterPolicy: channel.roster_policy,
        attention,
        workspaceMuted: mutedByWorkspace.get(workspaceId),
        badge: channelNodeBadge(channel, attention, unread[channel.id] ?? 0),
        muted: attention?.mode === "mute" || mutedByWorkspace.get(workspaceId) === true,
      });
    }
  });
  for (const pair of pairsQuery.data?.direct_pairs ?? []) {
    if (!directLinePairVisibleInSidebar(pair)) {
      continue;
    }

    rows.push({
      kind: "direct",
      id: pair.conversation_id,
      createdAt: pair.created_at,
      latest: latest?.get(pair.conversation_id) ?? null,
      counterpart: pair.counterpart,
      badge: directRowBadge(pair.unread_count),
    });
  }

  const visible = orderRecentRows(
    workspaceFilter
      ? rows.filter((row) => row.kind === "channel" && row.workspaceId === workspaceFilter)
      : rows,
    pinned,
  );

  const directRows = visible.filter((row) => row.kind === "direct");
  const { agents, users } = collectCounterpartAvatarSources(directRows);
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);

  const viewerId = viewer.data && "id" in viewer.data ? viewer.data.id : null;
  const now = Date.now();
  const loading =
    rows.length === 0 && (pairsQuery.isLoading || channelLists.some((list) => list.isLoading));

  return (
    <>
      {/* Pinned while the list scrolls: the filter and the entries beside it are
          how the list is steered, so they stay in reach. */}
      {liveWorkspaces.length > 1 || props.actions ? (
        <div
          data-recent-filter
          className="sticky top-0 z-10 flex shrink-0 items-center gap-1 bg-(--pane-bg,var(--bg-base)) px-1 pb-2"
        >
          {liveWorkspaces.length > 1 ? (
            <div
              role="radiogroup"
              aria-label="Filter by workspace"
              className="scrollbar-hide flex min-w-0 flex-1 gap-1 overflow-x-auto mask-[linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] pr-4"
            >
              <FilterChip
                label="All"
                selected={workspaceFilter === null}
                onSelect={() => setWorkspaceFilter(null)}
              />
              {liveWorkspaces.map((w) => (
                <FilterChip
                  key={w.id}
                  label={w.name}
                  selected={workspaceFilter === w.id}
                  onSelect={() => setWorkspaceFilter(w.id)}
                />
              ))}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {props.actions}
        </div>
      ) : null}

      {loading ? <SidebarRowsSkeleton label="Loading conversations" /> : null}

      <ul className="flex flex-col">
        {visible.map((row, index) => (
          <li key={row.id}>
            <RecentRowMenu row={row} pinned={pinned.has(row.id)}>
              <RecentRow
                row={row}
                selected={row.id === props.selectedConversationId}
                pinned={pinned.has(row.id)}
                divider={
                  index < visible.length - 1 &&
                  row.id !== props.selectedConversationId &&
                  visible[index + 1]!.id !== props.selectedConversationId
                }
                viewerId={viewerId}
                now={now}
                agentAvatarUrls={agentAvatarUrls}
                humanAvatarUrls={humanAvatarUrls}
                onSelect={() => {
                  const workspaceId = row.kind === "channel" ? row.workspaceId : null;
                  if (row.latest?.thread_root_id) {
                    props.onOpenThread({
                      workspaceId,
                      conversationId: row.id,
                      threadRootId: row.latest.thread_root_id,
                      messageId: row.latest.message_id,
                    });
                    return;
                  }
                  if (row.kind === "channel") {
                    props.onSelectChannel(row.id, row.workspaceId);
                  } else {
                    props.onSelectDirectPair(row.id);
                  }
                }}
              />
            </RecentRowMenu>
          </li>
        ))}
      </ul>
    </>
  );
}

function FilterChip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-filter-chip
      onClick={onSelect}
      className={cn(
        "h-6 max-w-32 shrink-0 truncate rounded-(--chip-radius) border-(length:--control-border-width) px-2 text-xs font-medium transition-colors focus-outline",
        selected
          ? "border-(--border-row-selected) bg-(--bg-row-selected) text-text-on-selected"
          : "border-border-subtle text-text-secondary hover:border-(--border-control-hover) hover:text-text-primary",
      )}
    >
      {label}
    </button>
  );
}

interface RecentRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  row: RecentListRow;
  selected: boolean;
  /** Starred rows lead the list out of time order; the star says why. */
  pinned: boolean;
  /** A hairline under the text column, as in a native chat list; dropped next to
   *  the selected row, whose fill already separates it. */
  divider: boolean;
  viewerId: string | null;
  now: number;
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  humanAvatarUrls: ReadonlyMap<string, string | null>;
  onSelect: () => void;
}

// Forwards the ref and the menu trigger's handlers to the button, which the
// context menu needs as its `asChild` trigger.
const RecentRow = forwardRef<HTMLButtonElement, RecentRowProps>(function RecentRow(
  {
    row,
    selected,
    pinned,
    divider,
    viewerId,
    now,
    agentAvatarUrls,
    humanAvatarUrls,
    onSelect,
    ...rest
  },
  ref,
) {
  const counterpart = row.kind === "direct" ? presentCounterpart(row.counterpart) : null;
  const title = row.kind === "channel" ? row.title : counterpart!.label;
  const latest = row.latest;
  const preview = latest ? recentPreviewText(latest) : "";
  const sender = latest ? presentAuthor(latest.sender) : null;
  // A DM's counterpart is implied by the row; only the viewer's own lines and
  // channel messages name who wrote them.
  const senderLabel =
    !sender || !latest
      ? null
      : sender.navigableId !== null && sender.navigableId === viewerId
        ? "You"
        : row.kind === "channel"
          ? sender.label
          : null;

  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      onClick={onSelect}
      data-row-selected={selected || undefined}
      className={cn(
        "sidebar-row-border flex h-14 w-full items-center gap-2.5 border px-2 text-left",
        selected
          ? "navigation-row border-accent bg-bg-nav-selected text-text-nav-selected"
          : "navigation-row border-transparent text-text-secondary hover:border-accent hover:bg-bg-nav-hover hover:text-text-primary",
      )}
    >
      <span data-recent-avatar className="flex size-9 shrink-0 items-center justify-center">
        {counterpart ? (
          <AuthorAvatarView
            avatar={counterpart.avatar}
            size={AVATAR_PX.lg}
            label={counterpart.label}
            agentAvatarUrls={agentAvatarUrls}
            humanAvatarUrls={humanAvatarUrls}
          />
        ) : (
          <ChannelAvatar id={row.id} title={title} />
        )}
      </span>

      <span
        className={cn(
          "flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-stretch border-b",
          divider ? "border-border-subtle" : "border-transparent",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {row.kind === "channel" ? (
            <ChannelIcon
              variant="utility"
              visibility={row.visibility}
              className="-mr-0.5 size-3 self-center text-text-muted"
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-[13px] leading-4",
              selected || row.badge ? "font-semibold text-text-primary" : "font-medium",
              selected && "text-text-nav-selected",
            )}
          >
            {title}
          </span>
          {row.kind === "channel" ? (
            <span className="min-w-0 shrink-[999] truncate text-(length:--text-meta) text-text-muted">
              {row.workspaceName}
            </span>
          ) : null}
          {pinned ? (
            <StarIcon
              role="img"
              aria-label="Starred"
              className="ml-auto size-3 shrink-0 self-center fill-current text-text-muted opacity-60"
            />
          ) : null}
          <span
            className={cn(
              "shrink-0 text-(length:--text-meta) tabular-nums text-text-muted",
              !pinned && "ml-auto",
            )}
          >
            {latest ? recentTimeLabel(latest.created_at, now) : ""}
          </span>
        </span>

        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs leading-4 text-text-muted">
            {latest?.thread_root_id ? (
              <ThreadIcon
                role="img"
                aria-label="In a thread"
                className="mr-1 inline size-3 align-[-2px]"
              />
            ) : null}
            {senderLabel ? <span className="text-text-secondary">{senderLabel}: </span> : null}
            {preview}
          </span>
          {row.kind === "channel" && row.muted ? <MutedMarker /> : null}
          {row.badge ? (
            <UnreadBadge count={row.badge.count} tier={row.badge.tier} inverted={selected} />
          ) : null}
        </span>
      </span>
    </button>
  );
});

/** Telegram's seven name tones. The hue is keyed on the conversation id, so a
 *  rename keeps a channel's colour. */
const CHANNEL_TONES = [
  "#e17076",
  "#faa774",
  "#a695e7",
  "#7bc862",
  "#6ec9cb",
  "#65aadd",
  "#ee7aae",
] as const;

function channelTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }

  return CHANNEL_TONES[Math.abs(hash) % CHANNEL_TONES.length]!;
}

function ChannelAvatar(props: { id: string; title: string }): JSX.Element {
  const initial = Array.from(props.title.trim())[0]?.toUpperCase() ?? "#";

  return (
    <span
      className="flex shrink-0 items-center justify-center text-[15px] font-semibold text-white"
      style={{ width: AVATAR_PX.lg, height: AVATAR_PX.lg, backgroundColor: channelTone(props.id) }}
    >
      {initial}
    </span>
  );
}

/** The tree's channel menu (star, notifications, archive, copy name) on the same
 *  channel here. DM rows have no menu in the tree either. */
function RecentRowMenu(props: {
  row: RecentListRow;
  pinned: boolean;
  children: ReactElement;
}): JSX.Element {
  if (props.row.kind !== "channel") {
    return props.children;
  }

  return (
    <RecentChannelMenu row={props.row} pinned={props.pinned}>
      {props.children}
    </RecentChannelMenu>
  );
}

function RecentChannelMenu(props: {
  row: Extract<RecentListRow, { kind: "channel" }>;
  pinned: boolean;
  children: ReactElement;
}): JSX.Element {
  const { row, pinned } = props;
  const star = useStarChannel(row.workspaceId);
  const archive = useArchiveChannel(row.workspaceId);

  return (
    <AppContextMenu trigger={props.children}>
      <ChannelRowMenuItems
        channelId={row.id}
        title={row.title}
        rosterPolicy={row.rosterPolicy}
        isMember
        isArchived={false}
        starred={pinned}
        attention={row.attention}
        workspaceMuted={row.workspaceMuted}
        onStar={() => star.mutate({ channelId: row.id, starred: !pinned })}
        onArchive={() =>
          archive.mutate({ channelId: row.id, archived: true, workspaceId: row.workspaceId })
        }
        archivePending={archive.isPending}
      />
    </AppContextMenu>
  );
}
