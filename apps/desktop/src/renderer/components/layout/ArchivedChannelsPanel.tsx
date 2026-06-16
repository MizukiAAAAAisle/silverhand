import { useMemo, useState, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import dayjs from 'dayjs';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Clock,
  Hash,
  User,
} from 'lucide-react';
import type { AgentDto, ArchivedChannelListItemDto } from '@silverhand/shared';
import {
  useArchiveChannel,
  useArchivedChannelsIndex,
  type WorkspaceListItem,
} from '@/features/workspaces/hooks';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { cn } from '@/lib/cn';
import { dmWorkspaceLabel, workspaceDisplayName } from '@/lib/workspace-name';

type WorkspaceFilter = 'all' | `workspace:${string}`;
type ArchiveDateFilter = 'all' | '30d' | '14d' | '7d';

interface ArchivedChannelsPanelProps {
  workspaces: WorkspaceListItem[];
  onOpenChannel: (workspaceId: string, channelId: string) => void;
}

const SELECT_TRIGGER_CLASS =
  'flex h-8 w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-2.5 text-xs text-text-primary outline-none transition-colors hover:border-[color:var(--border-control-hover)] focus:border-border-focus data-[placeholder]:text-text-muted';

const SELECT_CONTENT_CLASS =
  'z-[60] max-h-[42vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-lg';

const SELECT_ITEM_CLASS =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-7 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary';

const DATE_OPTIONS: Array<{ value: ArchiveDateFilter; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: '14d', label: 'Last 2 weeks' },
  { value: '7d', label: 'Last 1 week' },
];

export function ArchivedChannelsPanel({
  workspaces,
  onOpenChannel,
}: ArchivedChannelsPanelProps): JSX.Element {
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>('all');
  const [dateFilter, setDateFilter] = useState<ArchiveDateFilter>('all');
  // Both collections feed this recovery index (#task:1145): regular
  // workspaces' archived channels AND agent_home (DM) workspaces' archived
  // dm_channels. The backend aggregate is channel-like, so the panel offers
  // both as filter scopes and subscribes to both for live invalidation —
  // otherwise an archived DM would be unfindable/unrestorable from the
  // default Archived entry.
  const filterableWorkspaces = useMemo(
    () =>
      workspaces.filter(
        workspace => workspace.kind === 'regular' || workspace.kind === 'dm',
      ),
    [workspaces],
  );
  const workspaceScopeIds = useMemo(
    () => filterableWorkspaces.map(workspace => workspace.id),
    [filterableWorkspaces],
  );
  const workspaceId = workspaceFilter.startsWith('workspace:')
    ? workspaceFilter.slice('workspace:'.length)
    : null;
  const since = useMemo(() => archiveDateSince(dateFilter), [dateFilter]);
  const { data: channels = [], isFetching, isLoading } = useArchivedChannelsIndex({
    workspaceId,
    since,
    workspaceScopeIds,
  });
  const archiveChannel = useArchiveChannel(null);
  const hasFilters = workspaceFilter !== 'all' || dateFilter !== 'all';

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
        <Archive className="size-3.5 text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Archived Channels
        </span>
        <span className="text-xs tabular-nums text-text-muted">{channels.length}</span>
        {isFetching ? (
          <span className="ml-auto text-xs text-text-muted">刷新中…</span>
        ) : null}
      </header>

      <section className="shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterBlock label="Workspace" className="w-full sm:w-72">
            <WorkspaceArchiveSelect
              value={workspaceFilter}
              workspaces={filterableWorkspaces}
              onChange={setWorkspaceFilter}
            />
          </FilterBlock>
          <FilterBlock label="Archived date" className="w-full sm:w-48">
            <ArchiveDateSelect value={dateFilter} onChange={setDateFilter} />
          </FilterBlock>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <EmptyState text="加载 archived channels…" />
        ) : channels.length === 0 ? (
          <EmptyState
            text={
              hasFilters
                ? 'No archived channels match these filters'
                : 'No archived channels'
            }
          />
        ) : (
          <ul className="space-y-2">
            {channels.map(item => (
              <ArchivedChannelRow
                key={item.channel.id}
                item={item}
                restorePending={archiveChannel.isPending}
                onOpen={() => {
                  const target = archivedRowOpenTarget(item);
                  onOpenChannel(target.workspaceId, target.channelId);
                }}
                onRestore={() =>
                  archiveChannel.mutate({
                    channelId: item.channel.id,
                    archived: false,
                    workspaceId: item.workspace.id,
                  })
                }
              />
            ))}
          </ul>
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
    <label className={cn('block min-w-0', className)}>
      <span className="mb-1 block text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function WorkspaceArchiveSelect({
  value,
  workspaces,
  onChange,
}: {
  value: WorkspaceFilter;
  workspaces: WorkspaceListItem[];
  onChange: (value: WorkspaceFilter) => void;
}): JSX.Element {
  const { data: agents = [] } = useAgents();
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
            <SelectItem value="all" icon={<Archive className="size-3.5" />}>
              All workspaces
            </SelectItem>
            {/* DMs group leads, mirroring SearchPanel's WorkspaceFilterSelect
                order so the two workspace-filter dropdowns read the same. */}
            {dms.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  DMs
                </Select.Label>
                {dms.map(workspace => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={dmWorkspaceIcon(workspace, agentsById, agentAvatarUrls)}
                    suffix={
                      workspace.archived_at !== null ? 'archived workspace' : undefined
                    }
                  >
                    {workspaceDisplayName(workspace)}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null}
            {regular.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  Workspaces
                </Select.Label>
                {regular.map(workspace => (
                  <SelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={<WorkspaceGlyph />}
                    suffix={
                      workspace.archived_at !== null ? 'archived workspace' : undefined
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

function ArchiveDateSelect({
  value,
  onChange,
}: {
  value: ArchiveDateFilter;
  onChange: (value: ArchiveDateFilter) => void;
}): JSX.Element {
  const selected = DATE_OPTIONS.find(option => option.value === value)?.label ?? 'All time';
  return (
    <Select.Root value={value} onValueChange={v => onChange(v as ArchiveDateFilter)}>
      <Select.Trigger aria-label="Archived date filter" className={SELECT_TRIGGER_CLASS}>
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
            {DATE_OPTIONS.map(option => (
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

function ArchivedChannelRow({
  item,
  restorePending,
  onOpen,
  onRestore,
}: {
  item: ArchivedChannelListItemDto;
  restorePending: boolean;
  onOpen: () => void;
  onRestore: () => void;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  const archivedAt = item.channel.archived_at
    ? dayjs(item.channel.archived_at).format('YYYY-MM-DD HH:mm')
    : 'Unknown archive date';
  const threadCopy =
    item.thread_count === 1 ? '1 thread' : `${item.thread_count} threads`;

  return (
    <li>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-list-row
        className={cn(
          'sidebar-row-border flex min-w-0 items-stretch border bg-bg-floating transition-colors',
          hover ? 'border-accent bg-bg-hover' : 'border-border',
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
        >
          <span data-list-row-icon className="flex size-8 shrink-0 items-center justify-center text-text-muted">
            <Hash data-channel-icon className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span className="font-medium text-text-primary">
                {archivedRowWorkspaceLabel(item)}
              </span>
              {item.workspace.archived_at !== null ? (
                <>
                  <span>·</span>
                  <span>archived workspace</span>
                </>
              ) : null}
            </span>
            <span className="mt-1 block truncate text-sm font-medium text-text-primary">
              {item.channel.title}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span>Archived {archivedAt}</span>
              <span>·</span>
              <span>{threadCopy}</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onRestore();
          }}
          disabled={restorePending}
          className="m-3 ml-0 inline-flex shrink-0 items-center gap-1.5 self-center rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-[color:var(--border-control-hover)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Restore ${item.channel.title}`}
          title="Restore channel"
        >
          <ArchiveRestore className="size-3.5" />
          Restore
        </button>
      </div>
    </li>
  );
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
      {text}
    </div>
  );
}

function WorkspaceGlyph(): JSX.Element {
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center font-serif text-[14px] font-semibold leading-none">
      W
    </span>
  );
}

/**
 * Workspace label for an archived row's context (#task:1145, label converged
 * #task:1156). A regular `channel` row shows its bare workspace name; a
 * `dm_channel` row shows `@<agentName>` — the same handle the filter dropdown
 * and the rail use (one shared `dmWorkspaceLabel`, no per-surface variant).
 * The DM name arrives bare here (`insertAgentHome` sets `name = agent.name`);
 * `dmWorkspaceLabel` also strips the `dm-` UI prefix the dropdown shape carries,
 * so both normalize to the same handle.
 */
export function archivedRowWorkspaceLabel(
  item: ArchivedChannelListItemDto,
): string {
  return item.channel.kind === 'dm_channel'
    ? dmWorkspaceLabel(item.workspace.name)
    : item.workspace.name;
}

/** Nav target for opening an archived row. Always the channel's OWN
 *  workspace — for a DM row that's the agent_home workspace (the aggregate
 *  sets `workspace.id = conversation.workspace_id`), NOT whatever workspace
 *  is currently selected. The destination workspace then loads its archived
 *  channel-like list (`useArchivedChannelsForWorkspace`, now enabled for DM)
 *  so the row resolves to a real conversation instead of a blank pane
 *  (#task:1145). Pure so the "dm row → agent_home ws + dm_channel" contract
 *  is unit-testable without rendering. */
export function archivedRowOpenTarget(item: ArchivedChannelListItemDto): {
  workspaceId: string;
  channelId: string;
} {
  return { workspaceId: item.workspace.id, channelId: item.channel.id };
}

/** DM workspaces are 1:1 with an agent — show that agent's avatar so the DM
 *  group reads as "talking to @x" instead of a row of identical glyphs.
 *  Falls back to the neutral person glyph when the agent can't be resolved
 *  (workspace not yet provisioned / agent list still loading). Mirrors
 *  SearchPanel's `dmWorkspaceIcon` (#task:1145). NOTE: this is the dropdown
 *  *scope* icon only — archived rows themselves keep the uniform `#` channel
 *  glyph (DM is channel-like, per shiki). */
function dmWorkspaceIcon(
  workspace: WorkspaceListItem,
  agentsById: Map<string, AgentDto>,
  agentAvatarUrls: Map<string, string | null>,
): JSX.Element {
  const agent = workspace.dm_agent_id
    ? agentsById.get(workspace.dm_agent_id)
    : undefined;
  if (!agent) return <User className="size-3.5" />;
  return (
    <AgentAvatar
      runtime={agent.runtime}
      size={16}
      avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
      alt={agent.display_name?.trim() || agent.name}
    />
  );
}

function workspaceFilterLabel(
  value: WorkspaceFilter,
  workspaces: WorkspaceListItem[],
  agentsById: Map<string, AgentDto>,
  agentAvatarUrls: Map<string, string | null>,
): { label: string; icon: JSX.Element } {
  if (value === 'all') {
    return { label: 'All workspaces', icon: <Archive className="size-3.5" /> };
  }
  const id = value.slice('workspace:'.length);
  const workspace = workspaces.find(w => w.id === id);
  if (!workspace) {
    return { label: 'Workspace', icon: <WorkspaceGlyph /> };
  }
  return workspace.kind === 'dm'
    ? {
        label: workspaceDisplayName(workspace),
        icon: dmWorkspaceIcon(workspace, agentsById, agentAvatarUrls),
      }
    : { label: workspace.name, icon: <WorkspaceGlyph /> };
}

function archiveDateSince(value: ArchiveDateFilter): number | null {
  if (value === '30d') return dayjs().subtract(30, 'day').valueOf();
  if (value === '14d') return dayjs().subtract(14, 'day').valueOf();
  if (value === '7d') return dayjs().subtract(7, 'day').valueOf();
  return null;
}
