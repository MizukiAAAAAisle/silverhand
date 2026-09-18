import { IdentitySearchResults } from "@/features/search/identity-search-results";
import { SearchResultItem, type SearchItem } from "@/features/search/search-result-item";
import { useMemo, useState, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import dayjs from "dayjs";
import { ChevronDown, Clock, Hash, MessageSquareMore, Search as SearchIcon, X } from "lucide-react";
import type { AgentDto, SearchResultDto } from "@silverhand/shared";
import { Input } from "@/components/ui/input";
import {
  FilterBlock,
  FilterSelectItem as SelectItem,
  FILTER_SELECT_TRIGGER_CLASS as SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS as SELECT_CONTENT_CLASS,
} from "@/components/ui/filter-select";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { useAuthorAvatarObjectUrls } from "@/components/chat/author-avatar-hooks";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useMessageSearch } from "@/features/search/hooks";
import { useUsers, useUsersById, makeUserNameResolver } from "@/features/users/hooks";
import type { WorkspaceListItem } from "@/features/workspaces/hooks";
import { isAgentSpace } from "@/features/workspaces/workspace-ownership";
import {
  SenderFilterSelect,
  parseSenderFilter,
  type SenderFilterValue,
} from "@/components/ui/sender-filter-select";
import { ListRowsSkeleton } from "../../components/layout/list-rows-skeleton";
import { PaneHeader, PaneShell } from "../../components/layout/pane-shell";

interface SearchPanelProps {
  workspaces: WorkspaceListItem[];
  /** Seeds the query on mount when the inline header find hands off to
   *  advanced search (#task:1335). Read once — the panel remounts fresh per
   *  route, so a new `?q=` seeds a fresh useState. */
  initialQuery?: string;
  /** Filter selection (workspace / sender / time), owned by App so it
   *  survives pane switches for the app session (#task:1259). The free-text
   *  query stays panel-local — it's per-keystroke, so lifting it to the App
   *  root would re-render the whole tree on every character. */
  filter: SearchFilterState;
  onFilterChange: (next: SearchFilterState) => void;
  onJumpMessage: (params: {
    workspaceId?: string;
    channelId: string;
    threadRootId?: string | null;
    messageId: string;
  }) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenConversation: (workspaceId: string, channelId: string) => void;
}

type WorkspaceFilter = "all" | `workspace:${string}`;
type TimeRange = "all" | "today" | "week1" | "week2" | "month";

/** Search filter selection lifted to App-session state (#task:1259). Not
 *  persisted — a restart resets to the default. The query text is deliberately
 *  excluded (see SearchPanelProps). */
export interface SearchFilterState {
  workspace: WorkspaceFilter;
  /** Sender axis shares its value encoding + control with Saved (#task:2062);
   *  the union and the wire-param parse live in `sender-filter-select.tsx`. */
  sender: SenderFilterValue;
  time: TimeRange;
}

export const SEARCH_FILTER_DEFAULT: SearchFilterState = {
  workspace: "all",
  sender: "all",
  time: "all",
};

interface ResultGroup {
  key: string;
  label: string;
  icon: JSX.Element;
  results: SearchResultDto[];
}

/** Workspace glyph — a serif "W" matching the icon column width. Used
 *  wherever a people-owned workspace needs a marker; mirrors the
 *  WorkspacesPanel sidebar. Sizes line up with Lucide `size-3/3.5/4`. */
export function SearchPanel({
  workspaces,
  initialQuery,
  filter,
  onFilterChange,
  onJumpMessage,
  onOpenWorkspace,
  onOpenConversation,
}: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? "");
  // Filters are App-owned (controlled) so they persist across pane switches
  // for the session (#task:1259). Query stays local (see SearchPanelProps).
  const { workspace: workspaceFilter, sender: senderFilter, time: timeRange } = filter;
  const setWorkspaceFilter = (next: WorkspaceFilter) =>
    onFilterChange({ ...filter, workspace: next });
  const setSenderFilter = (next: SenderFilterValue) => onFilterChange({ ...filter, sender: next });
  const setTimeRange = (next: TimeRange) => onFilterChange({ ...filter, time: next });
  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  // Resolver feeds formatUserDisplayName so message-meta lines and the
  // sender-filter label render the actual human display name instead of
  // the raw uuid (multi-human audit 2026-06-03 #task:857 P0.10).
  const usersById = useUsersById();
  const userResolver = useMemo(() => makeUserNameResolver(usersById), [usersById]);

  const workspaceIdFilter = workspaceIdFromFilter(workspaceFilter);
  const senderQuery = useMemo(() => parseSenderFilter(senderFilter), [senderFilter]);
  const timeQuery = useMemo(() => timeRangeBounds(timeRange), [timeRange]);

  const filters = useMemo(
    () => ({
      q: query,
      include_identities: true,
      workspace_id: workspaceIdFilter,
      user_id: senderQuery.userId,
      agent_id: senderQuery.agentId,
      from: timeQuery.from,
      to: timeQuery.to,
      limit: 100,
    }),
    [
      workspaceIdFilter,
      query,
      senderQuery.agentId,
      senderQuery.userId,
      timeQuery.from,
      timeQuery.to,
    ],
  );

  const hasIntent =
    query.trim().length > 0 ||
    workspaceFilter !== "all" ||
    senderFilter !== "all" ||
    timeRange !== "all";
  const { data, isFetching, isLoading, isError, refetch } = useMessageSearch(filters);
  const identities = isError ? undefined : data?.identities;
  const identityCount = identities
    ? identities.humans.results.length + identities.agents.results.length
    : 0;
  const results = data?.results ?? [];
  // The sender byline avatar's bytes come STRICTLY from each message hit's own
  // author DTO (#task:1792 B2) — never a directory join — so a match whose
  // author is deleted or outside the loaded directory still renders correctly.
  const messageAuthors = useMemo(
    () => results.flatMap((r) => (r.type === "message" ? [r.message.author] : [])),
    [results],
  );
  const { agentAvatarUrls, humanAvatarUrls } = useAuthorAvatarObjectUrls(messageAuthors);
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  // Owner avatars for workspace hits come from the DIRECTORY, not from the
  // result set — a workspace's owning agent is not one of the matched messages'
  // authors. Same wiring the filter dropdown already uses, so a workspace reads
  // identically in the trigger and in the rows below it.
  const ownerAgentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const resultGroups = useMemo(() => groupResults(results), [results]);

  const resetFilters = (): void => {
    setQuery("");
    onFilterChange(SEARCH_FILTER_DEFAULT);
  };

  return (
    <PaneShell>
      <PaneHeader
        icon={<SearchIcon className="size-3.5" />}
        title="Search"
        count={hasIntent ? results.length + identityCount : undefined}
        trailing={
          isFetching ? <span className="ml-auto text-xs text-text-muted">Searching…</span> : null
        }
      />

      <section className="shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && hasIntent) {
                e.preventDefault();
                resetFilters();
              }
            }}
            placeholder="Search people, agents, messages, channels"
            className="h-10 pl-9 pr-10"
          />
          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasIntent}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-(--control-radius) text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-outline disabled:pointer-events-none disabled:opacity-0"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <FilterBlock label="Workspace" className="w-full sm:w-72">
            <WorkspaceFilterSelect
              value={workspaceFilter}
              workspaces={workspaces}
              agents={agents}
              onChange={setWorkspaceFilter}
            />
          </FilterBlock>

          <FilterBlock label="Sender" className="w-full sm:w-60">
            <SenderFilterSelect
              value={senderFilter}
              agents={agents}
              users={users}
              userResolver={userResolver}
              onChange={setSenderFilter}
            />
          </FilterBlock>

          <FilterBlock label="Time" className="w-full sm:w-44">
            <TimeRangeSelect value={timeRange} onChange={setTimeRange} />
          </FilterBlock>
        </div>
      </section>

      <div className="search-list min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {hasIntent && identities?.status === "filtered" ? (
          <p className="mb-3 text-xs text-text-muted">
            Clear workspace, sender and time filters to search people and agents.
          </p>
        ) : null}
        {isError ? (
          <p role="alert" className="mb-3 text-xs text-text-muted">
            Search failed.{" "}
            <button
              type="button"
              className="underline focus-outline"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : null}
        {!hasIntent ? (
          <EmptyState icon={<SearchIcon className="size-5" />} text="Type to search" />
        ) : isLoading ? (
          <ListRowsSkeleton withIcon />
        ) : results.length === 0 && identityCount === 0 ? (
          !isError ? (
            <EmptyState icon={<SearchIcon className="size-5" />} text="No matches" />
          ) : null
        ) : (
          <div className="space-y-5">
            {identities && identityCount > 0 ? (
              <IdentitySearchResults identities={identities} />
            ) : null}
            {resultGroups.map((group) => (
              <section key={group.key}>
                <header className="mb-2 flex items-center gap-2 px-1 text-(length:--text-meta) font-medium uppercase leading-none tracking-wider text-text-muted">
                  {group.icon}
                  <span className="leading-none">{group.label}</span>
                  <span className="leading-none text-text-muted/70">{group.results.length}</span>
                </header>
                <ul className="space-y-2">
                  {group.results.map((result) => (
                    <SearchResultRow
                      key={resultKey(result)}
                      result={result}
                      query={query}
                      agentsById={agentsById}
                      ownerAgentAvatarUrls={ownerAgentAvatarUrls}
                      agentAvatarUrls={agentAvatarUrls}
                      userAvatarUrls={humanAvatarUrls}
                      onClick={() => {
                        if (result.type === "workspace") {
                          // Discovery arm: the workspace IS the hit and keeps a
                          // result-level `workspace` ref (#task:2053-C).
                          onOpenWorkspace(result.workspace.id);
                        } else if (result.type === "conversation") {
                          // Branch BEFORE reading the workspace container: it now
                          // lives inside the placement-discriminated `conversation`
                          // ref, present only on the `workspace` arm (#task:2053-C).
                          // A `direct_pair` conversation hit is workspace-less; but
                          // pair titles are empty so a pair never surfaces as a
                          // conversation-discovery result — no nav path, no-op.
                          if (result.conversation.placement_kind === "workspace") {
                            onOpenConversation(
                              result.conversation.workspace.id,
                              result.conversation.channel_id,
                            );
                          } else if (import.meta.env.DEV) {
                            // Premise (above): a pair can't reach the
                            // conversation-discovery arm, so this is dead. Assert
                            // rather than silently no-op — if a producer ever gives
                            // a pair a title, this fires in dev and forces the nav
                            // path to be built instead of the click dying quietly
                            // (Paul #task:2051 F3; a comment alone can't fail).
                            console.assert(
                              false,
                              "direct_pair surfaced as a conversation-discovery result — needs a nav path",
                            );
                          }
                        } else if (result.conversation.placement_kind === "workspace") {
                          onJumpMessage({
                            workspaceId: result.conversation.workspace.id,
                            channelId: result.conversation.channel_id,
                            // New reply-cluster: jump uses the message's own
                            // `thread_root_id`; the cluster pane opens to it.
                            threadRootId: result.message.thread_root_id,
                            messageId: result.message.id,
                          });
                        } else {
                          // `direct_pair`: a workspace-less human↔agent DM. Omit
                          // `workspaceId` so the App's jump handler resolves the
                          // pair through `directPairAuthority` → `toDirect`
                          // (branch-before-resolve, #task:2052); a pair has no
                          // workspace container to pass.
                          onJumpMessage({
                            channelId: result.conversation.channel_id,
                            threadRootId: result.message.thread_root_id,
                            messageId: result.message.id,
                          });
                        }
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </PaneShell>
  );
}

function WorkspaceFilterSelect({
  value,
  workspaces,
  agents,
  onChange,
}: {
  value: WorkspaceFilter;
  workspaces: WorkspaceListItem[];
  agents: AgentDto[];
  onChange: (value: WorkspaceFilter) => void;
}): JSX.Element {
  const agentSpaces = workspaces.filter((workspace) => isAgentSpace(workspace));
  const peopleOwned = workspaces.filter((workspace) => !isAgentSpace(workspace));
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const selected = workspaceFilterLabel(value, workspaces, agentsById, agentAvatarUrls);

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as WorkspaceFilter)}>
      <Select.Trigger aria-label="Workspace filter" className={SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          {selected.icon}
          <span className="truncate">{selected.label}</span>
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <SelectItem value="all" icon={<SearchIcon className="size-3.5" />}>
              All workspaces
            </SelectItem>
            {agentSpaces.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-muted">
                  Agent Spaces
                </Select.Label>
                {agentSpaces.map((workspace) => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        ownerAgentId={workspace.owner_agent_id}
                        agentsById={agentsById}
                        ownerAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                  >
                    {workspace.name}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null}
            {peopleOwned.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-(length:--text-badge) font-semibold uppercase tracking-wider text-text-muted">
                  Workspaces
                </Select.Label>
                {peopleOwned.map((workspace) => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        ownerAgentId={workspace.owner_agent_id}
                        ownerAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                  >
                    {workspace.name}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function TimeRangeSelect({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}): JSX.Element {
  const selected = TIME_RANGE_LABELS[value];

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as TimeRange)}>
      <Select.Trigger aria-label="Time filter" className={SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Clock className="size-3.5 text-text-muted" />
          <span className="truncate">{selected}</span>
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            {TIME_RANGE_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                icon={<Clock className="size-3.5" />}
              >
                {option.label}
              </SelectItem>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function SearchResultRow({
  result,
  query,
  agentsById,
  ownerAgentAvatarUrls,
  agentAvatarUrls,
  userAvatarUrls,
  onClick,
}: {
  result: SearchResultDto;
  query: string;
  /** Directory, for the workspace arm's OWNER identity. */
  agentsById: ReadonlyMap<string, AgentDto>;
  /** Owner-avatar bytes, keyed by agent id. Deliberately a SECOND map next to
   *  `agentAvatarUrls`: a message byline's bytes come strictly from that hit's
   *  own author DTO (#task:1792 B2), while a workspace's owner is not an author
   *  at all and must come from the directory. One shared map would make an owner
   *  avatar appear only when that agent happened to write a matching message. */
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
  agentAvatarUrls: Map<string, string | null>;
  userAvatarUrls: Map<string, string | null>;
  onClick: () => void;
}): JSX.Element {
  const item: SearchItem =
    result.type === "workspace"
      ? { kind: "workspace", result }
      : result.type === "conversation"
        ? { kind: "conversation", result }
        : { kind: "message", result };
  return (
    <li>
      <SearchResultItem
        item={item}
        query={query}
        agentsById={agentsById}
        ownerAgentAvatarUrls={ownerAgentAvatarUrls}
        agentAvatarUrls={agentAvatarUrls}
        userAvatarUrls={userAvatarUrls}
        onClick={onClick}
      />
    </li>
  );
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }): JSX.Element {
  return (
    <div className="flex h-full min-h-55 items-center justify-center rounded-(--row-radius) border border-dashed border-border text-sm text-text-muted">
      <div className="flex items-center gap-2">
        {icon}
        <span>{text}</span>
      </div>
    </div>
  );
}

/** Group results into Channels (workspace / channel / agent space) and Messages;
 *  the row's leading glyph carries the sub-kind. Identity hits group separately. */
function groupResults(results: SearchResultDto[]): ResultGroup[] {
  const channels = results.filter(
    (result) => result.type === "workspace" || result.type === "conversation",
  );
  const messages = results.filter((result) => result.type === "message");

  return [
    {
      key: "channels",
      label: "Channels",
      icon: <Hash className="size-3" />,
      results: channels,
    },
    {
      key: "messages",
      label: "Messages",
      icon: <MessageSquareMore className="size-3" />,
      results: messages,
    },
  ].filter((group) => group.results.length > 0);
}

function resultKey(result: SearchResultDto): string {
  if (result.type === "workspace") return `workspace:${result.workspace.id}`;
  if (result.type === "conversation") {
    return `conversation:${result.conversation.id}`;
  }
  return `message:${result.message.id}`;
}

function workspaceIdFromFilter(value: WorkspaceFilter): string | undefined {
  return value.startsWith("workspace:") ? value.slice("workspace:".length) : undefined;
}

/** The trigger's own label + identity for the selected filter. An agent space is
 *  1:1 with its owning agent, so its row reads as "talking to @x" rather than a
 *  column of identical container badges — but WHICH glyph that is belongs to
 *  `WorkspaceIcon` (ownership in, identity out), so this only hands it the row's
 *  `owner_agent_id` and the resolved avatar maps and never branches on the
 *  container itself (#task:2078). */
function workspaceFilterLabel(
  value: WorkspaceFilter,
  workspaces: WorkspaceListItem[],
  agentsById: Map<string, AgentDto>,
  agentAvatarUrls: Map<string, string | null>,
): { label: string; icon: JSX.Element } {
  if (value.startsWith("workspace:")) {
    const workspaceId = value.slice("workspace:".length);
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      return {
        label: workspace.name,
        icon: (
          <WorkspaceIcon
            ownerAgentId={workspace.owner_agent_id}
            agentsById={agentsById}
            ownerAgentAvatarUrls={agentAvatarUrls}
          />
        ),
      };
    }
  }
  return { label: "All workspaces", icon: <SearchIcon className="size-3.5" /> };
}

const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week1", label: "Last 1 week" },
  { value: "week2", label: "Last 2 weeks" },
  { value: "month", label: "Last month" },
];

const TIME_RANGE_LABELS: Record<TimeRange, string> = Object.fromEntries(
  TIME_RANGE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<TimeRange, string>;

function timeRangeBounds(value: TimeRange): { from?: number; to?: number } {
  const now = Date.now();
  if (value === "today") return { from: dayjs().startOf("day").valueOf(), to: now };
  if (value === "week1") return { from: dayjs(now).subtract(1, "week").valueOf(), to: now };
  if (value === "week2") return { from: dayjs(now).subtract(2, "week").valueOf(), to: now };
  if (value === "month") return { from: dayjs(now).subtract(1, "month").valueOf(), to: now };
  return {};
}
