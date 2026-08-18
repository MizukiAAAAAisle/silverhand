import { useMemo, useState, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import dayjs from 'dayjs';
import {
  ChevronDown,
  Clock,
  Hash,
  MessageSquareText,
  Search as SearchIcon,
  User,
  X,
} from 'lucide-react';
import type { AgentDto, SearchResultDto } from '@silverhand/shared';
import { Input } from '@/components/ui/input';
import { CollectionItemCard } from '@/components/layout/collection-item-card';
import {
  FilterBlock,
  FilterSelectItem as SelectItem,
  FILTER_SELECT_TRIGGER_CLASS as SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS as SELECT_CONTENT_CLASS,
} from '@/components/ui/filter-select';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { ChannelIcon } from '@/components/ChannelIcon';
import { AVATAR_PX } from '@/components/avatar-scale';
import { AuthorAvatarView, AuthorName } from '@/components/chat/author-avatar-view';
import { presentAuthor } from '@/components/chat/author-presentation';
import { useAuthorAvatarObjectUrls } from '@/components/chat/author-avatar-hooks';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useMessageSearch } from '@/features/search/hooks';
import { useUsers, useUsersById, makeUserNameResolver } from '@/features/users/hooks';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
import {
  SenderFilterSelect,
  parseSenderFilter,
  type SenderFilterValue,
} from '@/components/ui/sender-filter-select';
import { workspaceDisplayName } from '@/lib/workspace-name';
import { ListRowsSkeleton } from './ListRowsSkeleton';
import { paneChrome } from './pane-chrome';

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
  onOpenConversation: (
    workspaceId: string,
    channelId: string,
  ) => void;
}

type WorkspaceFilter = 'all' | `workspace:${string}`;
type TimeRange = 'all' | 'today' | 'week1' | 'week2' | 'month';

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
  workspace: 'all',
  sender: 'all',
  time: 'all',
};

interface ResultGroup {
  key: string;
  label: string;
  icon: JSX.Element;
  results: SearchResultDto[];
}

/** Workspace glyph — a serif "W" matching the icon column width. Used
 *  wherever a workspace (regular kind) needs a marker; mirrors the
 *  WorkspacesPanel sidebar. Sizes line up with Lucide `size-3/3.5/4`. */
function WorkspaceGlyph({ size = 3.5 }: { size?: 3 | 3.5 | 4 }): JSX.Element {
  const px = size * 4;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center font-serif font-semibold leading-none"
      style={{ width: `${px}px`, height: `${px}px`, fontSize: `${px}px` }}
    >
      W
    </span>
  );
}

export function SearchPanel({
  workspaces,
  initialQuery,
  filter,
  onFilterChange,
  onJumpMessage,
  onOpenWorkspace,
  onOpenConversation,
}: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? '');
  // Filters are App-owned (controlled) so they persist across pane switches
  // for the session (#task:1259). Query stays local (see SearchPanelProps).
  const { workspace: workspaceFilter, sender: senderFilter, time: timeRange } = filter;
  const setWorkspaceFilter = (next: WorkspaceFilter) =>
    onFilterChange({ ...filter, workspace: next });
  const setSenderFilter = (next: SenderFilterValue) =>
    onFilterChange({ ...filter, sender: next });
  const setTimeRange = (next: TimeRange) =>
    onFilterChange({ ...filter, time: next });
  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  // Resolver feeds formatUserDisplayName so message-meta lines and the
  // sender-filter label render the actual human display name instead of
  // the raw uuid (multi-human audit 2026-06-03 #task:857 P0.10).
  const usersById = useUsersById();
  const userResolver = useMemo(() => makeUserNameResolver(usersById), [usersById]);

  const channelQuery = useMemo(
    () => parseWorkspaceFilter(workspaceFilter),
    [workspaceFilter],
  );
  const senderQuery = useMemo(() => parseSenderFilter(senderFilter), [senderFilter]);
  const timeQuery = useMemo(() => timeRangeBounds(timeRange), [timeRange]);

  const filters = useMemo(
    () => ({
      q: query,
      scope: channelQuery.scope,
      workspace_id: channelQuery.workspaceId,
      user_id: senderQuery.userId,
      agent_id: senderQuery.agentId,
      from: timeQuery.from,
      to: timeQuery.to,
      limit: 100,
    }),
    [
      channelQuery.workspaceId,
      channelQuery.scope,
      query,
      senderQuery.agentId,
      senderQuery.userId,
      timeQuery.from,
      timeQuery.to,
    ],
  );

  const hasIntent =
    query.trim().length > 0 ||
    workspaceFilter !== 'all' ||
    senderFilter !== 'all' ||
    timeRange !== 'all';
  const { data, isFetching, isLoading } = useMessageSearch(filters);
  const results = data?.results ?? [];
  // The sender byline avatar's bytes come STRICTLY from each message hit's own
  // author DTO (#task:1792 B2) — never a directory join — so a match whose
  // author is deleted or outside the loaded directory still renders correctly.
  const messageAuthors = useMemo(
    () =>
      results.flatMap(r => (r.type === 'message' ? [r.message.author] : [])),
    [results],
  );
  const { agentAvatarUrls, humanAvatarUrls } =
    useAuthorAvatarObjectUrls(messageAuthors);
  const agentsById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent])),
    [agents],
  );
  const resultGroups = useMemo(() => groupResults(results), [results]);

  const resetFilters = (): void => {
    setQuery('');
    onFilterChange(SEARCH_FILTER_DEFAULT);
  };

  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col bg-bg-chat"
      style={{ ...paneChrome, overflow: 'hidden' }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <SearchIcon className="size-3.5 text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Search
        </span>
        {data ? (
          <span className="text-xs tabular-nums text-text-muted">
            {results.length}
          </span>
        ) : null}
        {isFetching ? (
          <span className="ml-auto text-xs text-text-muted">Searching…</span>
        ) : null}
      </header>

      <section className="shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && hasIntent) {
                e.preventDefault();
                resetFilters();
              }
            }}
            placeholder="Search messages, channels, threads"
            className="h-10 pl-9 pr-10"
          />
          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasIntent}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-outline disabled:pointer-events-none disabled:opacity-0"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!hasIntent ? (
          <EmptyState
            icon={<SearchIcon className="size-5" />}
            text="Type to search"
          />
        ) : isLoading ? (
          <ListRowsSkeleton withIcon />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<SearchIcon className="size-5" />}
            text="No matches"
          />
        ) : (
          <div className="space-y-5">
            {resultGroups.map(group => (
              <section key={group.key}>
                <header className="mb-2 flex items-center gap-2 px-1 text-[length:var(--text-meta)] font-medium uppercase leading-none tracking-wider text-text-muted">
                  {group.icon}
                  <span className="leading-none">{group.label}</span>
                  <span className="leading-none text-text-muted/70">
                    {group.results.length}
                  </span>
                </header>
                <ul className="space-y-2">
                  {group.results.map(result => (
                    <SearchResultRow
                      key={resultKey(result)}
                      result={result}
                      query={query}
                      agentAvatarUrls={agentAvatarUrls}
                      userAvatarUrls={humanAvatarUrls}
                      onClick={() => {
                        if (result.type === 'workspace') {
                          // Discovery arm: the workspace IS the hit and keeps a
                          // result-level `workspace` ref (#task:2053-C).
                          onOpenWorkspace(result.workspace.id);
                        } else if (result.type === 'conversation') {
                          // Branch BEFORE reading the workspace container: it now
                          // lives inside the placement-discriminated `conversation`
                          // ref, present only on the `workspace` arm (#task:2053-C).
                          // A `direct_pair` conversation hit is workspace-less; but
                          // pair titles are empty so a pair never surfaces as a
                          // conversation-discovery result — no nav path, no-op.
                          if (result.conversation.placement_kind === 'workspace') {
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
                              'direct_pair surfaced as a conversation-discovery result — needs a nav path',
                            );
                          }
                        } else if (result.conversation.placement_kind === 'workspace') {
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
    </main>
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
  const dms = workspaces.filter(workspace => workspace.kind === 'dm');
  const regular = workspaces.filter(workspace => workspace.kind === 'regular');
  const agentsById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent])),
    [agents],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const selected = workspaceFilterLabel(
    value,
    workspaces,
    agentsById,
    agentAvatarUrls,
  );

  return (
    <Select.Root value={value} onValueChange={v => onChange(v as WorkspaceFilter)}>
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
              All locations
            </SelectItem>
            {dms.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Agent Spaces
                </Select.Label>
                {dms.map(workspace => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        kind="dm"
                        dmAgentId={workspace.dm_agent_id}
                        agentsById={agentsById}
                        dmAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                  >
                    {workspaceDisplayName(workspace)}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null}
            {regular.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Workspaces
                </Select.Label>
                {regular.map(workspace => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        kind="regular"
                        dmAgentId={null}
                        dmAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                  >
                    {workspaceDisplayName(workspace)}
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
    <Select.Root value={value} onValueChange={v => onChange(v as TimeRange)}>
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
            {TIME_RANGE_OPTIONS.map(option => (
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
  agentAvatarUrls,
  userAvatarUrls,
  onClick,
}: {
  result: SearchResultDto;
  query: string;
  agentAvatarUrls: Map<string, string | null>;
  userAvatarUrls: Map<string, string | null>;
  onClick: () => void;
}): JSX.Element {
  const isMessage = result.type === 'message';
  const icon = resultIcon(result);
  const excerpt = resultExcerpt(result, query);

  return (
    <li>
      <CollectionItemCard
        as="button"
        type="button"
        onClick={onClick}
        className="flex w-full min-w-0 items-start gap-3 px-3 py-3 text-left"
      >
        <span
          data-collection-card-icon
          className="flex size-8 shrink-0 items-center justify-center self-center rounded-md border border-border-subtle bg-bg-base text-text-muted"
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          {isMessage ? (
            <MessageResultHeader
              result={result}
              agentAvatarUrls={agentAvatarUrls}
              userAvatarUrls={userAvatarUrls}
            />
          ) : (
            <>
              <span className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                {resultMeta(result).map((item, index) => (
                  <span key={`${index}:${item}`} className="min-w-0 truncate">
                    {item}
                  </span>
                ))}
              </span>
              <span className="block truncate text-sm font-medium text-text-primary">
                {highlightText(resultTitle(result), query)}
              </span>
            </>
          )}
          {excerpt ? (
            <span className="mt-1 block max-h-10 overflow-hidden text-sm leading-5 text-text-secondary">
              {highlightText(excerpt, query)}
            </span>
          ) : null}
        </span>
      </CollectionItemCard>
    </li>
  );
}

/**
 * Header for a message search result: workspace, channel, sender, time, each
 * named entity carrying its canonical icon/avatar (#task:1336). The type itself
 * is expressed by the left row icon, so no "Message" text label here. Reuses the
 * same name resolvers as the rest of the panel (no second metadata source) and
 * the shared avatar-url caches for the sender glyph.
 *
 * A `direct_pair` hit wears NO where segment (shiki #task:2060): a pair is not a
 * place, so nothing — least of all the counterpart's agent identity — stands in
 * the workspace slot; the row reads sender + time. The pair's own face stays with
 * the DM pane and the `#conv:` chip.
 *
 * No `·` separators between the segments (shiki 2026-07-27, matching the task
 * card meta row from #task:1579 and the saved-item header): each segment already
 * opens with its own identity glyph, so glyph + gap delimit the row and the
 * middots were pure ink. The timestamp is the only segment without an identity
 * glyph, so it gets a `Clock` at utility scale (14px, a notch under the 16px
 * identity glyphs).
 */
function MessageResultHeader({
  result,
  agentAvatarUrls,
  userAvatarUrls,
}: {
  result: Extract<SearchResultDto, { type: 'message' }>;
  agentAvatarUrls: Map<string, string | null>;
  userAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  // Author identity via the ONE shared seam (#task:1792): the server-
  // authoritative `MessageAuthorDto` → `presentAuthor`, never a live `from_*_id`
  // directory re-join. Deleted → snapshot name + neutral avatar; unresolved →
  // "Unknown …"; a matched system message (`author === null`) reads "System"
  // with a neutral person square (the left type icon already carries the kind).
  const presentation = result.message.author
    ? presentAuthor(result.message.author)
    : null;
  const senderName = presentation?.label ?? 'System';
  // The container lives inside the placement-discriminated ref, and only the
  // `workspace` arm has one to show — workspace + channel, both readable only
  // after that narrowing. The `direct_pair` arm renders no segment (#task:2060).
  const place = result.conversation;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
      {place.placement_kind === 'workspace' ? (
        <>
          <span className="flex min-w-0 items-center gap-1">
            <WorkspaceIcon
              kind={place.workspace.kind !== 'dm' ? 'regular' : 'dm'}
              dmAgentId={null}
            />
            <span className="truncate">
              {workspaceDisplayName(place.workspace)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1">
            {/* Same channel glyph the sidebar / saved / activity lists use, via
                the shared ChannelIcon primitive. `sticker` → the
                `data-channel-icon` hook lets each theme paint its `#` chip
                (forza6 poster sticker) so a channel reads identically everywhere.
                `sm` (12px) is intentional (shiki #task:1438): forza6's content-box
                chip (+2px pad +2px border) lands at 16px — matching the 16px
                workspace icon + sender avatar on this row (shiki #task:1336);
                warm / slack paint no chip, so their glyph is simply 12px. Not the
                chat-header hero (`data-conversation-hash-icon`, ~28px). */}
            <ChannelIcon variant="sticker" density="sm" />
            <span className="truncate">{place.title}</span>
          </span>
        </>
      ) : null}
      <span className="flex min-w-0 items-center gap-1">
        <AuthorAvatarView
          avatar={presentation?.avatar ?? { variant: 'neutral-user' }}
          size={AVATAR_PX.xs}
          label={senderName}
          agentAvatarUrls={agentAvatarUrls}
          humanAvatarUrls={userAvatarUrls}
        />
        {/* Author name carries its deleted state through the shared primitive
            (#task:1792 B3); a matched system message has no author DTO. */}
        {presentation ? (
          <AuthorName presentation={presentation} className="truncate" />
        ) : (
          <span className="truncate">{senderName}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 tabular-nums">
        <Clock aria-hidden className="size-3.5 shrink-0" />
        {dayjs(result.message.created_at).format('YYYY-MM-DD HH:mm')}
      </span>
    </span>
  );
}

function EmptyState({
  icon,
  text,
}: {
  icon: ReactNode;
  text: string;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded-md border border-dashed border-border text-sm text-text-muted">
      <div className="flex items-center gap-2">
        {icon}
        <span>{text}</span>
      </div>
    </div>
  );
}

function groupResults(results: SearchResultDto[]): ResultGroup[] {
  const workspaces = results.filter(
    result => result.type === 'workspace' && result.workspace.kind === 'regular',
  );
  const conversations = results.filter(result => result.type === 'conversation');
  const dms = results.filter(
    result => result.type === 'workspace' && result.workspace.kind === 'dm',
  );
  const messages = results.filter(result => result.type === 'message');

  return [
    {
      key: 'workspaces',
      label: 'Workspaces',
      icon: <WorkspaceGlyph size={3} />,
      results: workspaces,
    },
    {
      key: 'conversations',
      label: 'Channels / Threads',
      icon: <Hash className="size-3" />,
      results: conversations,
    },
    {
      // `key` stays `dms`: it is this group's internal identity, not its copy.
      key: 'dms',
      label: 'Agent Spaces',
      icon: <User className="size-3" />,
      results: dms,
    },
    {
      key: 'messages',
      label: 'Messages',
      icon: <MessageSquareText className="size-3" />,
      results: messages,
    },
  ].filter(group => group.results.length > 0);
}

function resultIcon(result: SearchResultDto): JSX.Element {
  if (result.type === 'workspace') {
    // Regular-workspace result rows wear the same `data-workspace-icon` badge
    // as the sidebar rail and the filter dropdown (one canonical workspace
    // glyph everywhere). DM workspaces keep the neutral person glyph here — the
    // result row has no agent-avatar context wired and DM-as-result is rare
    // (#task:1192).
    return result.workspace.kind === 'dm' ? (
      <User className="size-4" />
    ) : (
      <WorkspaceIcon kind="regular" dmAgentId={null} />
    );
  }
  if (result.type === 'conversation') {
    return <Hash className="size-4" />;
  }
  return <MessageSquareText className="size-4" />;
}

/** Metadata line for named-entity (workspace / conversation) result rows.
 *  Message rows render a richer icon+avatar header via `MessageResultHeader`
 *  instead, so they don't pass through here. */
function resultMeta(result: SearchResultDto): string[] {
  if (result.type === 'workspace') {
    return [result.workspace.kind === 'dm' ? 'Agent Space' : 'Workspace'];
  }
  if (result.type === 'conversation') {
    // Workspace name only on the `workspace` arm; a `direct_pair` conversation
    // hit is workspace-less (#task:2053-C) and reads as an Agent Space.
    return result.conversation.placement_kind === 'workspace'
      ? [
          'Channel',
          workspaceDisplayName(result.conversation.workspace),
          dayjs(result.conversation.created_at).format('YYYY-MM-DD HH:mm'),
        ]
      : [
          'Agent Space',
          dayjs(result.conversation.created_at).format('YYYY-MM-DD HH:mm'),
        ];
  }
  return [];
}

function resultTitle(result: SearchResultDto): string {
  if (result.type === 'workspace') return workspaceDisplayName(result.workspace);
  if (result.type === 'conversation') return result.conversation.title;
  // Message rows render through `MessageResultHeader` (which shows no title for a
  // pair at all, #task:2060), so this arm is unreachable and exists only for
  // type-exhaustiveness — do NOT wire it to a display path that would surface the
  // `direct_pair` title sentinel (Paul #task:2051 F1 aside).
  return result.conversation.title;
}

function resultExcerpt(result: SearchResultDto, query: string): string | null {
  if (result.type === 'workspace') return result.workspace.description;
  if (result.type === 'conversation') {
    // Excerpt line for a channel/thread hit is its workspace name; a workspace-
    // less `direct_pair` hit has none to show (#task:2053-C).
    return result.conversation.placement_kind === 'workspace'
      ? workspaceDisplayName(result.conversation.workspace)
      : null;
  }
  return buildExcerpt(result.message.content, query);
}

function resultKey(result: SearchResultDto): string {
  if (result.type === 'workspace') return `workspace:${result.workspace.id}`;
  if (result.type === 'conversation') {
    return `conversation:${result.conversation.id}`;
  }
  return `message:${result.message.id}`;
}

function buildExcerpt(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const needle = query.trim().toLowerCase();
  if (!needle) return flat.length > 260 ? `${flat.slice(0, 260)}…` : flat;
  const index = flat.toLowerCase().indexOf(needle);
  if (index < 0) return flat.length > 260 ? `${flat.slice(0, 260)}…` : flat;
  const start = Math.max(0, index - 80);
  const end = Math.min(flat.length, index + needle.length + 180);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function highlightText(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-accent-soft px-0.5 text-text-primary">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function parseWorkspaceFilter(value: WorkspaceFilter): {
  scope: 'all' | 'regular' | 'dm';
  workspaceId?: string;
} {
  if (value.startsWith('workspace:')) {
    return { scope: 'all', workspaceId: value.slice('workspace:'.length) };
  }
  return { scope: 'all' };
}

/** DM workspaces are 1:1 with an agent — show that agent's avatar so the
 *  DM group reads as "talking to @x" instead of a row of identical person
 *  glyphs. Falls back to the neutral person glyph when the agent can't be
 *  resolved (workspace not yet provisioned / agent list still loading). */
function workspaceFilterLabel(
  value: WorkspaceFilter,
  workspaces: WorkspaceListItem[],
  agentsById: Map<string, AgentDto>,
  agentAvatarUrls: Map<string, string | null>,
): { label: string; icon: JSX.Element } {
  if (value.startsWith('workspace:')) {
    const workspaceId = value.slice('workspace:'.length);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (workspace) {
      return {
        label: workspaceDisplayName(workspace),
        icon:
          workspace.kind === 'dm' ? (
            <WorkspaceIcon
              kind="dm"
              dmAgentId={workspace.dm_agent_id}
              agentsById={agentsById}
              dmAgentAvatarUrls={agentAvatarUrls}
            />
          ) : (
            <WorkspaceIcon
              kind="regular"
              dmAgentId={null}
              dmAgentAvatarUrls={agentAvatarUrls}
            />
          ),
      };
    }
  }
  return { label: 'All locations', icon: <SearchIcon className="size-3.5" /> };
}

const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'week1', label: 'Last 1 week' },
  { value: 'week2', label: 'Last 2 weeks' },
  { value: 'month', label: 'Last month' },
];

const TIME_RANGE_LABELS: Record<TimeRange, string> = Object.fromEntries(
  TIME_RANGE_OPTIONS.map(option => [option.value, option.label]),
) as Record<TimeRange, string>;

function timeRangeBounds(value: TimeRange): { from?: number; to?: number } {
  const now = Date.now();
  if (value === 'today') return { from: dayjs().startOf('day').valueOf(), to: now };
  if (value === 'week1') return { from: dayjs(now).subtract(1, 'week').valueOf(), to: now };
  if (value === 'week2') return { from: dayjs(now).subtract(2, 'week').valueOf(), to: now };
  if (value === 'month') return { from: dayjs(now).subtract(1, 'month').valueOf(), to: now };
  return {};
}
