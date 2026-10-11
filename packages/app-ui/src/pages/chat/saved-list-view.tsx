import { useMemo } from "react";
import { BookmarkIcon, ClockIcon, LayersIcon } from "@/icons";
import dayjs from "dayjs";
import type { AgentDto, SavedMessageDto } from "@silverhand/shared";
import { Markdown } from "@/features/messages/components/markdown";
import { CollectionItemCard } from "@/components/layout/collection-item-card";
import { ChannelIcon } from "@/components/channel-icon";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { AuthorAvatarView, AuthorName } from "@/features/messages/components/author-avatar-view";
import { presentAuthor } from "@/features/messages/model/author-presentation";
import { useAuthorAvatarObjectUrls } from "@/features/messages/hooks/author-avatar-hooks";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useAgents } from "@/features/agents/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { useUsers, useUsersById, makeUserNameResolver } from "@/features/users/hooks";
import { useSavedMessages, useUnsaveMessage } from "@/features/messages/saved";
import type { WorkspaceListItem } from "@/features/workspaces/hooks";
import { FilterBlock } from "@/components/ui/filter-select";
import {
  FilterPanel,
  FilterToggle,
  filterBarAction,
  useFilterDisclosure,
} from "@/components/ui/responsive-filters";
import { SavedListSkeleton } from "./saved-list-skeleton";
import {
  WorkspaceFilterSelect,
  workspaceFilterId,
  type WorkspaceFilterValue,
} from "@/features/workspaces/workspace-filter-select";
import {
  SenderFilterSelect,
  parseSenderFilter,
  type SenderFilterValue,
} from "@/features/search/sender-filter-select";
import {
  DateFilterSelect,
  dateFilterSince,
  type DateFilterValue,
} from "@/components/ui/date-filter-select";
import { FloatingPaneChrome, PaneHeader, PaneShell } from "../../components/layout/pane-shell";

/** Saved-view filter selection. Lifted to App so it survives pane switches
 *  for the app session (shiki #task:1258 follow-up) — NOT persisted, so a
 *  restart clears it back to the default. */
export interface SavedFilterState {
  workspace: WorkspaceFilterValue;
  /** Sender axis, single-select (shiki #task:2059). Same value encoding and
   *  same control as Search — see `sender-filter-select.tsx`. */
  sender: SenderFilterValue;
  date: DateFilterValue;
}

export const SAVED_FILTER_DEFAULT: SavedFilterState = {
  workspace: "all",
  sender: "all",
  date: "all",
};

/** A Saved card navigates on click, but it wraps fully-interactive message
 *  content: a code-fence Copy button, inline links, and selectable text. The
 *  jump must fire only for a *bare* click — not when the click lands on a
 *  nested interactive control (button / link) or ends a text selection inside
 *  the card. Extracted + exported so the decision branch is unit-tested rather
 *  than presentation-locked (#task:1497). */
export function isBareCardClick(
  target: HTMLElement,
  card: HTMLElement,
  selection: Selection | null,
): boolean {
  if (target.closest("button, a")) return false;
  if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) {
    return false;
  }
  return true;
}

interface SavedListViewProps {
  workspaces: WorkspaceListItem[];
  /** Filter selection, owned by App so it persists across pane switches
   *  within the session (see SavedFilterState). */
  filter: SavedFilterState;
  onFilterChange: (next: SavedFilterState) => void;
  /** Called when the user clicks a saved entry. The parent owns view
   *  routing — flips back to channel view, selects the workspace +
   *  channel, and forwards the message id to the next ChannelView
   *  render so it can scroll + flash. */
  onJump: (params: {
    workspaceId?: string;
    channelId: string;
    threadRootId?: string | null;
    messageId: string;
  }) => void;
}

export function SavedListView({
  workspaces,
  filter,
  onFilterChange,
  onJump,
}: SavedListViewProps): JSX.Element {
  const unsave = useUnsaveMessage();
  const filterDisclosure = useFilterDisclosure();

  // Same filter form as ArchivedChannelsPanel (shiki #task:1258): Workspace +
  // Date, sharing that panel's WorkspaceFilterSelect (identical item design +
  // canonical workspace data source) and DateFilterSelect (same recency option
  // semantics). Sender joined in #task:2059 through the control Search already
  // used, so the two message-collection panes filter by sender identically.
  // State is App-owned (controlled) so switching panes and coming back keeps
  // the selection for the session.
  const { workspace, sender, date } = filter;
  const setWorkspace = (next: WorkspaceFilterValue) =>
    onFilterChange({ ...filter, workspace: next });
  const setSender = (next: SenderFilterValue) => onFilterChange({ ...filter, sender: next });
  const setDate = (next: DateFilterValue) => onFilterChange({ ...filter, date: next });
  const wsId = workspaceFilterId(workspace);
  const senderQuery = useMemo(() => parseSenderFilter(sender), [sender]);
  const since = useMemo(() => dateFilterSince(date), [date]);

  // The sender picker's OPTIONS come from the server directory read faces
  // (shiki 2026-08-18 "服务端"), never a distinct over the fetched rows — a
  // window-derived domain would offer only the senders inside the capped
  // `saved_at DESC LIMIT` page. A since-deleted sender is therefore not an
  // option (shiki's ruling); their rows stay findable by content, and the
  // absence gets no explanatory copy.
  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  const usersById = useUsersById();
  const userResolver = useMemo(() => makeUserNameResolver(usersById), [usersById]);

  // Filtering is SERVER-SIDE: the query carries workspace_id + since + the
  // sender param so the backend narrows the FULL saved set, not a client slice
  // of the LIMIT-200 window (which would silently drop older history).
  const { data, isLoading } = useSavedMessages({
    workspaceId: wsId,
    since,
    userId: senderQuery.userId,
    agentId: senderQuery.agentId,
  });
  const items = useMemo(() => data ?? [], [data]);
  const hasFilters = workspace !== "all" || sender !== "all" || date !== "all";
  // Keep the filter row visible whenever a filter is active, even if it yields
  // zero rows — else filtering to empty would hide the controls and trap the
  // user with no way to clear.
  const showFilters = hasFilters || items.length > 0;

  // Identity resolution for each row's meta line (shiki #task:1441). A
  // `workspace_channel` row shows the WORKSPACE's own icon + name (joined live
  // from the workspace list — the carrier embeds a bare `workspace_id`, never a
  // frozen name, #task:2055), the CHANNEL's `#` + `place.channel_name`, and the
  // SENDER's avatar. The carrier answers WHERE, never WHAT KIND (#task:2078):
  // container identity comes from the joined workspace itself, so a saved row
  // and a rail row cannot disagree about the same container — which is what a
  // second answer travelling with the pointer would have allowed.
  const workspacesById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  // A `direct_pair` row wears NO "where" segment at all (shiki #task:2060): a
  // pair is not a place, and standing its counterpart's agent identity in the
  // workspace slot reads as "this lives in that agent" — a place that does not
  // exist. The row's only identity is then its SENDER, which every row already
  // carries. So no pair join here: the counterpart face belongs to the DM pane
  // and the pair list, not to a cross-conversation row's meta line.
  // The agent directory serves two INDEPENDENT facets: the sender picker's
  // option domain above, and the WorkspaceIcon's owner avatar here (the agent that
  // owns the workspace — not the row's author, and not the row's sender).
  const agentsById = useMemo<ReadonlyMap<string, AgentDto>>(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const ownerAgentAvatarUrls = useAgentAvatarObjectUrls(agents);
  // The byline avatar's bytes come STRICTLY from each row's own author DTO
  // (#task:1792 B2) — never a directory join, so a saved message whose author is
  // outside the loaded directory (or deleted) still renders its own avatar.
  const authors = useMemo(() => items.map((i) => i.message.author), [items]);
  const { agentAvatarUrls: authorAgentAvatarUrls, humanAvatarUrls: authorHumanAvatarUrls } =
    useAuthorAvatarObjectUrls(authors);

  return (
    <PaneShell>
      <FloatingPaneChrome>
        <PaneHeader
          icon={<BookmarkIcon className="size-3.5 fill-current" />}
          title="Saved"
          count={data ? items.length : undefined}
          trailing={
            showFilters ? (
              <div className="ml-auto">
                <FilterToggle disclosure={filterDisclosure} active={hasFilters} />
              </div>
            ) : null
          }
          nativeActions={[showFilters ? filterBarAction(filterDisclosure, hasFilters) : null]}
        />

        {showFilters ? (
          <FilterPanel
            disclosure={filterDisclosure}
            className="shrink-0 border-b border-border-subtle px-4 py-3"
          >
            <div className="flex flex-wrap items-end gap-3">
              <FilterBlock label="Workspace" className="w-full sm:w-72">
                <WorkspaceFilterSelect
                  value={workspace}
                  workspaces={workspaces}
                  onChange={setWorkspace}
                  allIcon={<LayersIcon className="size-3.5" />}
                />
              </FilterBlock>
              <FilterBlock label="Sender" className="w-full sm:w-60">
                <SenderFilterSelect
                  value={sender}
                  agents={agents}
                  users={users}
                  userResolver={userResolver}
                  onChange={setSender}
                  ariaLabel="Saved sender filter"
                />
              </FilterBlock>
              <FilterBlock label="Saved date" className="w-full sm:w-48">
                <DateFilterSelect value={date} onChange={setDate} ariaLabel="Saved date filter" />
              </FilterBlock>
            </div>
          </FilterPanel>
        ) : null}
      </FloatingPaneChrome>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <SavedListSkeleton />
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
            {hasFilters ? "No matches" : "No saved messages"}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <SavedItem
                key={item.id}
                item={item}
                workspacesById={workspacesById}
                agentsById={agentsById}
                ownerAgentAvatarUrls={ownerAgentAvatarUrls}
                authorAgentAvatarUrls={authorAgentAvatarUrls}
                authorHumanAvatarUrls={authorHumanAvatarUrls}
                onJump={() =>
                  onJump(
                    item.place.kind === "workspace_channel"
                      ? {
                          workspaceId: item.place.workspace_id,
                          channelId: item.place.conversation_id,
                          // New reply-cluster: the saved message carries its own
                          // `thread_root_id`; the cluster pane opens to it.
                          threadRootId: item.message.thread_root_id,
                          messageId: item.message.id,
                        }
                      : {
                          // A direct-pair save has no workspace: the pane opens
                          // the pair straight from its conversation id.
                          channelId: item.place.conversation_id,
                          threadRootId: item.message.thread_root_id,
                          messageId: item.message.id,
                        },
                  )
                }
                onUnsave={() => unsave.mutate(item.message.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </PaneShell>
  );
}

function SavedItem({
  item,
  workspacesById,
  agentsById,
  ownerAgentAvatarUrls,
  authorAgentAvatarUrls,
  authorHumanAvatarUrls,
  onJump,
  onUnsave,
}: {
  item: SavedMessageDto;
  /** Workspace records joined by id — the `workspace_channel` arm reads its
   *  workspace out of this for the WorkspaceIcon's owner branch
   *  and the live display name. Empty in the brief window before the list
   *  resolves, which is why the whole where-segment is nullability-gated. */
  workspacesById: ReadonlyMap<string, WorkspaceListItem>;
  agentsById: ReadonlyMap<string, AgentDto>;
  /** Directory avatars, for the WorkspaceIcon's owning agent only (independent
   *  facet — NOT the row's author). */
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** Byline avatars derived from the row's own author DTO (#task:1792 B2). */
  authorAgentAvatarUrls: ReadonlyMap<string, string | null>;
  authorHumanAvatarUrls: ReadonlyMap<string, string | null>;
  onJump: () => void;
  onUnsave: () => void;
}): JSX.Element {
  // Author identity flows through the ONE shared seam (#task:1792): the
  // server-authoritative `MessageAuthorDto` → `presentAuthor`, so a deleted
  // author keeps its snapshot name + neutral avatar and an unresolved one
  // degrades to "Unknown …" here exactly as in the stream — never a live
  // directory re-join by `from_*_id`. A saved system message (`author === null`)
  // reads as "System" with a neutral person square.
  const presentation = item.message.author ? presentAuthor(item.message.author) : null;
  const sender = presentation?.label ?? "System";
  const when = useMemo(() => dayjs(item.saved_at).format("YYYY-MM-DD HH:mm"), [item.saved_at]);

  // The saved's "where" lives in its discriminated `place` (#task:2055): a
  // `workspace_channel` save is the workspace + channel it sits in, joined live
  // from the viewer's own list — the carrier freezes no workspace name. A
  // `direct_pair` save has no "where" to show (#task:2060), so this arm is the
  // only one that resolves one.
  const place = item.place;
  const workspace =
    place.kind === "workspace_channel" ? (workspacesById.get(place.workspace_id) ?? null) : null;

  return (
    <li>
      {/* The whole card navigates on click, but it wraps fully-interactive
          message content: a code-fence Copy button, inline links, the unsave
          button, and selectable text. Those must keep working, so `onJump`
          fires only for a bare click — suppressed when the click lands on a
          nested interactive control (button / link) or ends a text selection.
          The unsave button also stopPropagation's, so it never reaches here. */}
      <CollectionItemCard
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if (isBareCardClick(e.target as HTMLElement, e.currentTarget, window.getSelection())) {
            onJump();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onJump();
          }
        }}
        // Frame + hover come from the shell; each theme paints one
        // `[data-collection-card]:hover` (poster = ink border + poster shadow +
        // lift; warm/slack = bg veil + soft lift), so a row hover never flips to
        // the brand hue. Local layout only below.
        className="px-4 py-3"
      >
        {/* Meta line identity segments (shiki #task:1441). A workspace_channel
            save wears three: the WORKSPACE icon + name, the CHANNEL `#` +
            `place.channel_name`, and the SENDER avatar. A direct_pair save
            wears NO where segment at all (shiki #task:2060) — a pair is not a
            place, and its counterpart's agent identity must not stand in the
            workspace slot; the row reads sender + time. Canonical primitives
            throughout, so a row reads like every other identity row.

            No `·` separators (shiki 2026-07-27, the same call as the task card
            meta row in #task:1579): every segment already opens with its own
            glyph, so the glyph + `gap-2` delimit the row and the middots were
            pure ink. The timestamp is the one segment with no identity glyph, so
            it gets a `Clock` — utility scale (14px), a notch under the 16px
            identity glyphs beside it. */}
        <header className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          {place.kind === "workspace_channel" ? (
            <>
              {/* The workspace segment is drawn only when the join RESOLVED
                  (#task:2078). It used to render unconditionally, filling the
                  gaps with `kind ?? 'regular'` + `name ?? ''` — so an
                  unresolved workspace read as a confident serif "W" beside a
                  blank name, i.e. absence dressed as a people-owned workspace.
                  Glyph and name are one nullability branch: either the row
                  states where it is, or it says nothing and lets the channel +
                  sender segments carry it. */}
              {workspace ? (
                <span className="inline-flex items-center gap-1 font-medium text-text-primary">
                  <WorkspaceIcon
                    ownerAgentId={workspace.owner_agent_id}
                    agentsById={agentsById}
                    ownerAgentAvatarUrls={ownerAgentAvatarUrls}
                  />
                  {workspace.name}
                </span>
              ) : null}
              <span className="inline-flex min-w-0 items-center gap-1">
                <ChannelIcon variant="sticker" density="sm" />
                <span className="truncate">{place.channel_name}</span>
              </span>
            </>
          ) : null}
          <span className="inline-flex min-w-0 items-center gap-1">
            <AuthorAvatarView
              avatar={presentation?.avatar ?? { variant: "neutral-user" }}
              size={AVATAR_PX.xs}
              label={sender}
              agentAvatarUrls={authorAgentAvatarUrls}
              humanAvatarUrls={authorHumanAvatarUrls}
            />
            {/* Author name carries its deleted state through the ONE shared
                primitive (#task:1792 B3); a saved system row has no author DTO
                and reads "System". */}
            {presentation ? <AuthorName presentation={presentation} /> : <span>{sender}</span>}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1">
            <ClockIcon aria-hidden className="size-3.5 shrink-0" />
            {when}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUnsave();
            }}
            className="ml-auto text-accent hover:text-accent-hover"
            title="Remove from saved"
            aria-label="Remove from saved"
          >
            <BookmarkIcon className="size-3.5 fill-current" />
          </button>
        </header>

        <div className="text-sm text-text-primary">
          <Markdown content={item.message.content} taskReferences="raw" />
        </div>
      </CollectionItemCard>
    </li>
  );
}
