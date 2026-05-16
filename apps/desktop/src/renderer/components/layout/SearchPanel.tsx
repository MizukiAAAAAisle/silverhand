import { useMemo, useState, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import dayjs from 'dayjs';
import {
  Bot,
  Check,
  ChevronDown,
  Clock,
  Hash,
  MessageSquareText,
  Search as SearchIcon,
  User,
  X,
} from 'lucide-react';
import type { AgentDto, SearchResultDto } from '@silverhand/shared';
import { Input, Label } from '@/components/ui/input';
import { useAgents } from '@/features/agents/hooks';
import { useMessageSearch } from '@/features/search/hooks';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
import { formatUserDisplayName, getCurrentUserId } from '@/lib/current-user';
import { cn } from '@/lib/cn';

interface SearchPanelProps {
  workspaces: WorkspaceListItem[];
  onJumpMessage: (params: {
    workspaceId?: string;
    channelId: string;
    threadId?: string | null;
    messageId: string;
  }) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenConversation: (
    workspaceId: string,
    channelId: string,
    threadId?: string | null,
  ) => void;
}

type WorkspaceFilter = 'all' | 'scope:dm' | 'scope:regular' | `workspace:${string}`;
type SenderFilter = 'all' | `user:${string}` | `agent:${string}`;
type TimeRange = 'all' | 'today' | 'week1' | 'week2' | 'month';

interface ResultGroup {
  key: string;
  label: string;
  icon: JSX.Element;
  results: SearchResultDto[];
}

const SELECT_TRIGGER_CLASS =
  'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg-floating px-2.5 text-xs text-text-primary outline-none transition-colors hover:border-accent focus:border-border-focus focus:ring-2 focus:ring-border-focus data-[placeholder]:text-text-muted';

const SELECT_CONTENT_CLASS =
  'z-[60] max-h-[42vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-lg';

const SELECT_ITEM_CLASS =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-7 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary';

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
  onJumpMessage,
  onOpenWorkspace,
  onOpenConversation,
}: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>('all');
  const [senderFilter, setSenderFilter] = useState<SenderFilter>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const { data: agents = [] } = useAgents();

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
  const agentsById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent])),
    [agents],
  );
  const resultGroups = useMemo(() => groupResults(results), [results]);

  const resetFilters = (): void => {
    setQuery('');
    setWorkspaceFilter('all');
    setSenderFilter('all');
    setTimeRange('all');
  };

  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
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
          <span className="ml-auto text-xs text-text-muted">搜索中…</span>
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
            className="h-10 pl-9 pr-20"
          />
          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasIntent}
            className="absolute right-1.5 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1 rounded-md px-2 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
          >
            <X className="size-3.5" />
            Reset
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <FilterBlock label="Workspace" className="w-full sm:w-72">
            <WorkspaceFilterSelect
              value={workspaceFilter}
              workspaces={workspaces}
              onChange={setWorkspaceFilter}
            />
          </FilterBlock>

          <FilterBlock label="Sender" className="w-full sm:w-60">
            <SenderFilterSelect
              value={senderFilter}
              agents={agents}
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
            text="输入关键词开始搜索"
          />
        ) : isLoading ? (
          <EmptyState
            icon={<SearchIcon className="size-5 animate-pulse" />}
            text="搜索中…"
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<SearchIcon className="size-5" />}
            text="没有匹配结果"
          />
        ) : (
          <div className="space-y-5">
            {resultGroups.map(group => (
              <section key={group.key}>
                <header className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  {group.icon}
                  <span>{group.label}</span>
                  <span className="text-text-muted/70">{group.results.length}</span>
                </header>
                <ul className="space-y-2">
                  {group.results.map(result => (
                    <SearchResultRow
                      key={resultKey(result)}
                      result={result}
                      query={query}
                      agentsById={agentsById}
                      onClick={() => {
                        if (result.type === 'workspace') {
                          onOpenWorkspace(result.workspace.id);
                        } else if (result.type === 'conversation') {
                          onOpenConversation(
                            result.workspace.id,
                            result.conversation.channel_id,
                            result.conversation.thread_id,
                          );
                        } else {
                          onJumpMessage({
                            workspaceId: result.workspace.id,
                            channelId: result.conversation.channel_id,
                            threadId: result.conversation.thread_id,
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

function FilterBlock({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('block min-w-0', className)}>
      <Label className="mb-1 block">{label}</Label>
      {children}
    </div>
  );
}

function WorkspaceFilterSelect({
  value,
  workspaces,
  onChange,
}: {
  value: WorkspaceFilter;
  workspaces: WorkspaceListItem[];
  onChange: (value: WorkspaceFilter) => void;
}): JSX.Element {
  const dms = workspaces.filter(workspace => workspace.kind === 'dm');
  const regular = workspaces.filter(workspace => workspace.kind === 'regular');
  const selected = workspaceFilterLabel(value, workspaces);

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
          className={SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <SelectItem value="all" icon={<SearchIcon className="size-3.5" />}>
              All locations
            </SelectItem>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                DM
              </Select.Label>
              <SelectItem
                value="scope:dm"
                icon={<User className="size-3.5" />}
              >
                All DMs
              </SelectItem>
              {dms.map(workspace => (
                <SelectItem
                  key={workspace.id}
                  value={`workspace:${workspace.id}`}
                  icon={<User className="size-3.5" />}
                >
                  {formatWorkspaceName(workspace)}
                </SelectItem>
              ))}
            </Select.Group>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Channels
              </Select.Label>
              <SelectItem
                value="scope:regular"
                icon={<WorkspaceGlyph />}
              >
                All channels
              </SelectItem>
              {regular.map(workspace => (
                <SelectItem
                  key={workspace.id}
                  value={`workspace:${workspace.id}`}
                  icon={<WorkspaceGlyph />}
                >
                  {formatWorkspaceName(workspace)}
                </SelectItem>
              ))}
            </Select.Group>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function SenderFilterSelect({
  value,
  agents,
  onChange,
}: {
  value: SenderFilter;
  agents: AgentDto[];
  onChange: (value: SenderFilter) => void;
}): JSX.Element {
  const selected = senderFilterLabel(value, agents);

  return (
    <Select.Root value={value} onValueChange={v => onChange(v as SenderFilter)}>
      <Select.Trigger aria-label="Sender filter" className={SELECT_TRIGGER_CLASS}>
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
          className={SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <SelectItem value="all" icon={<SearchIcon className="size-3.5" />}>
              All senders
            </SelectItem>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Human
              </Select.Label>
              <SelectItem
                value={`user:${getCurrentUserId() ?? 'self'}`}
                icon={<User className="size-3.5" />}
              >
                {formatUserDisplayName(getCurrentUserId())}
              </SelectItem>
            </Select.Group>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Agents
              </Select.Label>
              {agents.length === 0 ? (
                <div className="px-2 py-1.5 text-xs italic text-text-muted">
                  没有 agent
                </div>
              ) : (
                agents.map(agent => (
                  <SelectItem
                    key={agent.id}
                    value={`agent:${agent.id}`}
                    icon={<Bot className="size-3.5" />}
                    suffix={agent.runtime}
                  >
                    @{agent.display_name?.trim() || agent.name}
                  </SelectItem>
                ))
              )}
            </Select.Group>
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

function SelectItem({
  value,
  icon,
  suffix,
  children,
}: {
  value: string;
  icon: JSX.Element;
  suffix?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Select.Item value={value} className={SELECT_ITEM_CLASS}>
      <span className="shrink-0 text-text-muted">{icon}</span>
      <Select.ItemText>
        <span className="truncate">{children}</span>
      </Select.ItemText>
      {suffix ? (
        <span className="ml-auto text-[10px] text-text-muted">{suffix}</span>
      ) : null}
      <Select.ItemIndicator className="absolute right-2 inline-flex items-center">
        <Check className="size-3.5 text-accent" />
      </Select.ItemIndicator>
    </Select.Item>
  );
}

function SearchResultRow({
  result,
  query,
  agentsById,
  onClick,
}: {
  result: SearchResultDto;
  query: string;
  agentsById: Map<string, AgentDto>;
  onClick: () => void;
}): JSX.Element {
  const icon = resultIcon(result);
  const meta = resultMeta(result, agentsById);
  const title = resultTitle(result);
  const excerpt = resultExcerpt(result, query);

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full min-w-0 items-start gap-3 rounded-md border-2 border-border bg-bg-floating px-3 py-3 text-left transition-colors hover:border-accent hover:bg-bg-hover"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-bg-base text-text-muted">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            {meta.map(item => (
              <span key={item} className="min-w-0 truncate">
                {item}
              </span>
            ))}
          </span>
          <span className="block truncate text-sm font-medium text-text-primary">
            {highlightText(title, query)}
          </span>
          {excerpt ? (
            <span className="mt-1 block max-h-10 overflow-hidden text-sm leading-5 text-text-secondary">
              {highlightText(excerpt, query)}
            </span>
          ) : null}
        </span>
      </button>
    </li>
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
      key: 'dms',
      label: 'DMs',
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
    return result.workspace.kind === 'dm' ? (
      <User className="size-4" />
    ) : (
      <WorkspaceGlyph size={4} />
    );
  }
  if (result.type === 'conversation') {
    return result.conversation.kind === 'thread' ? (
      <MessageSquareText className="size-4" />
    ) : (
      <Hash className="size-4" />
    );
  }
  return <MessageSquareText className="size-4" />;
}

function resultMeta(
  result: SearchResultDto,
  agentsById: Map<string, AgentDto>,
): string[] {
  if (result.type === 'workspace') {
    return [result.workspace.kind === 'dm' ? 'DM' : 'Workspace'];
  }
  if (result.type === 'conversation') {
    return [
      result.conversation.kind === 'thread' ? 'Thread' : 'Channel',
      formatWorkspaceName(result.workspace),
      dayjs(result.conversation.created_at).format('YYYY-MM-DD HH:mm'),
    ];
  }
  const sender = result.message.from_kind === 'agent'
    ? formatAgentName(result.message.from_agent_id, result.agent_name, agentsById)
    : result.message.from_kind === 'user'
      ? formatUserDisplayName(result.message.from_user_id)
      : 'system';
  return [
    result.workspace.kind === 'dm' ? 'DM message' : 'Message',
    formatWorkspaceName(result.workspace),
    result.conversation.title,
    sender,
    dayjs(result.message.created_at).format('YYYY-MM-DD HH:mm'),
  ];
}

function resultTitle(result: SearchResultDto): string {
  if (result.type === 'workspace') return formatWorkspaceName(result.workspace);
  if (result.type === 'conversation') return result.conversation.title;
  return result.conversation.title;
}

function resultExcerpt(result: SearchResultDto, query: string): string | null {
  if (result.type === 'workspace') return result.workspace.description;
  if (result.type === 'conversation') return formatWorkspaceName(result.workspace);
  return buildExcerpt(result.message.content, query);
}

function resultKey(result: SearchResultDto): string {
  if (result.type === 'workspace') return `workspace:${result.workspace.id}`;
  if (result.type === 'conversation') {
    return `conversation:${result.conversation.id}`;
  }
  return `message:${result.message.id}`;
}

function formatAgentName(
  agentId: string | null,
  fallback: string | null,
  agentsById: Map<string, AgentDto>,
): string {
  if (!agentId) return '@agent';
  const agent = agentsById.get(agentId);
  return `@${agent?.display_name?.trim() || fallback || agentId}`;
}

function formatWorkspaceName(workspace: {
  name: string;
  kind: 'regular' | 'dm';
}): string {
  if (workspace.kind !== 'dm') return workspace.name;
  return workspace.name.startsWith('dm-')
    ? `@${workspace.name.slice(3)}`
    : workspace.name;
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
  if (value === 'scope:dm') return { scope: 'dm' };
  if (value === 'scope:regular') return { scope: 'regular' };
  if (value.startsWith('workspace:')) {
    return { scope: 'all', workspaceId: value.slice('workspace:'.length) };
  }
  return { scope: 'all' };
}

function parseSenderFilter(value: SenderFilter): {
  userId?: string;
  agentId?: string;
} {
  if (value.startsWith('user:')) return { userId: value.slice('user:'.length) };
  if (value.startsWith('agent:')) return { agentId: value.slice('agent:'.length) };
  return {};
}

function workspaceFilterLabel(
  value: WorkspaceFilter,
  workspaces: WorkspaceListItem[],
): { label: string; icon: JSX.Element } {
  if (value === 'scope:dm') {
    return { label: 'All DMs', icon: <User className="size-3.5" /> };
  }
  if (value === 'scope:regular') {
    return { label: 'All channels', icon: <WorkspaceGlyph /> };
  }
  if (value.startsWith('workspace:')) {
    const workspaceId = value.slice('workspace:'.length);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (workspace) {
      return {
        label: formatWorkspaceName(workspace),
        icon:
          workspace.kind === 'dm' ? (
            <User className="size-3.5" />
          ) : (
            <WorkspaceGlyph />
          ),
      };
    }
  }
  return { label: 'All locations', icon: <SearchIcon className="size-3.5" /> };
}

function senderFilterLabel(
  value: SenderFilter,
  agents: AgentDto[],
): { label: string; icon: JSX.Element } {
  if (value.startsWith('user:')) {
    return {
      label: formatUserDisplayName(value.slice('user:'.length)),
      icon: <User className="size-3.5" />,
    };
  }
  if (value.startsWith('agent:')) {
    const agentId = value.slice('agent:'.length);
    const agent = agents.find(a => a.id === agentId);
    return {
      label: `@${agent?.display_name?.trim() || agent?.name || agentId}`,
      icon: <Bot className="size-3.5" />,
    };
  }
  return { label: 'All senders', icon: <SearchIcon className="size-3.5" /> };
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
