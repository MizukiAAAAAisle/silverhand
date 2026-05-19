import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  ArrowRight,
  AtSign,
  Hash,
  MessageSquareText,
  MoreHorizontal,
} from 'lucide-react';
import dayjs from 'dayjs';
import type {
  AgentRuntimeConversation,
  AgentRuntimeStateDto,
  ConversationAgentStatus,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';

interface AgentConversationActivityListProps {
  state: AgentRuntimeStateDto | undefined;
  /** Click handler — switch the main view to this channel/thread. */
  onOpenConversation?: (s: AgentRuntimeConversation) => void;
}

/** Filter alias used by the FilterTabs at the top of the panel.
 *
 *  - `active`  → currently doing work (`starting` or `active`, not closed)
 *  - `idle`    → joined the conversation but not running (`idle`, not closed)
 *  - `crashed` → exited unexpectedly (`crashed`)
 *  - `closed`  → conversation itself has been closed (`closed_at !== null`),
 *               regardless of last status
 *  - `all`     → everything, no filter
 *
 * `active` is the default because that's what the user usually wants:
 * "where is my agent right now?" rather than "every conversation it
 * has ever joined". Pattern mirrors AgentSchedulesCard's filter aliases
 * (alias-as-filter, not as persisted status).
 */
type ActivityFilter = 'active' | 'all' | 'idle' | 'crashed' | 'closed';
export type { ActivityFilter };

const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'idle', label: 'Idle' },
  { value: 'crashed', label: 'Crashed' },
  { value: 'closed', label: 'Closed' },
];

/**
 * Card-based list of the conversations this agent participates in,
 * replacing the previous flat `<table>` (one row, six columns of small
 * text). The card layout puts the channel/thread name forward, dims
 * runtime telemetry (PID, etc.) into an overflow popover, and uses a
 * 4px left color bar to encode state at a glance.
 *
 * Strict field budget — every value rendered comes directly from
 * `AgentRuntimeConversation` (workspace/channel/thread/status/pid/closed_at).
 * We deliberately do NOT show last-snippet, started-at, or exit-code:
 * those aren't in the panel DTO, and synthesising them from sibling
 * data sources would advertise capability we don't have. PR-2 contract
 * (#task:396).
 */
export function AgentConversationActivityList({
  state,
  onOpenConversation,
}: AgentConversationActivityListProps): JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('active');
  const all = state?.conversation_agents ?? [];
  const rows = useMemo(() => applyFilter(all, filter), [all, filter]);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
          Every channel or thread this agent participates in. Status is
          live — restart or hard-stop from the channel header.
        </p>
        <FilterTabs value={filter} onChange={setFilter} />
      </header>

      {rows.length === 0 ? (
        <div className="rounded-sm border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted">
          {emptyMessage(filter, all.length)}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(row => (
            <ActivityCard
              key={row.conversation_id}
              row={row}
              onOpen={onOpenConversation}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Exported for the regression test that locks the filter contract.
 *  Not part of the public component API. */
export function applyFilter(
  rows: ReadonlyArray<AgentRuntimeConversation>,
  filter: ActivityFilter,
): AgentRuntimeConversation[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'active':
      // `closed` wins over status for filtering: a conversation that's
      // been closed isn't "active" even if the last recorded status
      // said `active` (which can happen if the agent crashed mid-task
      // and the row hasn't transitioned yet).
      return rows.filter(
        r =>
          r.closed_at === null &&
          (r.status === 'active' || r.status === 'starting'),
      );
    case 'idle':
      return rows.filter(r => r.closed_at === null && r.status === 'idle');
    case 'crashed':
      // Closed wins over status (mirror `active` / `idle`): a closed
      // conversation belongs only in `Closed` or `All`, never in the
      // live status filters. Without this guard, a long-dead crashed
      // row keeps showing up in `Crashed` forever.
      return rows.filter(r => r.closed_at === null && r.status === 'crashed');
    case 'closed':
      return rows.filter(r => r.closed_at !== null);
  }
}

function emptyMessage(filter: ActivityFilter, totalCount: number): string {
  if (totalCount === 0) return 'Not in any conversation yet.';
  switch (filter) {
    case 'active':
      return 'Nothing running right now.';
    case 'idle':
      return 'No idle conversations.';
    case 'crashed':
      return 'No crashed conversations.';
    case 'closed':
      return 'No closed conversations.';
    case 'all':
      return 'Not in any conversation yet.';
  }
}

/**
 * One conversation row. Layout:
 *
 *   ┃ [icon] workspace / channel  [thread pill]       [Open] [⋯]
 *   ┃        status pill  ·  closed HH:MM (closed only)
 *
 * The left bar is a 4px state accent absolutely positioned. PID,
 * startedAt-ish data, and any later secondary fields go in the `⋯`
 * popover so the row stays uncluttered. Closed rows render at reduced
 * opacity so the eye skips past them when scanning the active list.
 */
function ActivityCard({
  row,
  onOpen,
}: {
  row: AgentRuntimeConversation;
  onOpen?: (s: AgentRuntimeConversation) => void;
}): JSX.Element {
  const closed = row.closed_at !== null;
  const accent = stateAccentClass(row.status, closed);
  return (
    <li
      className={cn(
        'relative overflow-hidden rounded-sm border border-border-subtle bg-bg-floating/50 px-4 py-3 transition-colors hover:bg-bg-hover/60',
        closed ? 'opacity-70' : '',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-1', accent)}
      />

      <div className="flex items-start gap-3 pl-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <ConversationIcon
              kind={row.conversation_kind}
              workspaceKind={row.workspace_kind}
            />
            <span className="truncate text-text-muted">
              {row.workspace_kind === 'agent_home' ? '' : row.workspace_name}
              {row.workspace_kind === 'agent_home' ? '' : (
                <span className="mx-1 text-text-muted">/</span>
              )}
              <span className="font-medium text-text-primary">
                {row.channel_title}
              </span>
            </span>
            {row.thread_title ? (
              <span className="inline-flex items-center rounded-sm bg-bg-base px-2 py-0.5 text-[11px] text-text-secondary">
                {row.thread_title}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
            <StatusPill status={row.status} closed={closed} />
            {closed && row.closed_at !== null ? (
              <span title={dayjs(row.closed_at).format('YYYY-MM-DD HH:mm:ss')}>
                closed {dayjs(row.closed_at).format('HH:mm')}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
              title="Open"
            >
              Open
              <ArrowRight className="size-3" />
            </button>
          ) : null}
          <OverflowMenu row={row} />
        </div>
      </div>
    </li>
  );
}

/** Maps the four `ConversationAgentStatus` values (plus the closed
 *  derivation) to the standard semantic-token accent classes. Mirrors
 *  the chip palette used by ScheduleItem so the two surfaces read
 *  consistently. */
function stateAccentClass(
  status: ConversationAgentStatus,
  closed: boolean,
): string {
  if (closed) return 'bg-border';
  switch (status) {
    case 'active':
      return 'bg-success';
    case 'starting':
      return 'bg-warning';
    case 'crashed':
      return 'bg-error';
    case 'idle':
      return 'bg-text-muted/40';
  }
}

function StatusPill({
  status,
  closed,
}: {
  status: ConversationAgentStatus;
  closed: boolean;
}): JSX.Element {
  if (closed) {
    return (
      <span className="inline-flex items-center rounded-sm bg-bg-base px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        closed
      </span>
    );
  }
  const cls =
    status === 'active'
      ? 'bg-success text-text-on-success'
      : status === 'starting'
        ? 'bg-warning text-text-on-warning'
        : status === 'crashed'
          ? 'bg-error text-text-on-error'
          : 'bg-bg-surface text-text-secondary';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        cls,
      )}
    >
      {status}
    </span>
  );
}

/**
 * Secondary metadata for the row (PID for now, future-proofed for any
 * other low-frequency runtime detail). Click the `⋯` button to open;
 * keeps the row's main line uncluttered. No PID? Don't render — the
 * button still appears so the row width doesn't shift between rows.
 */
function OverflowMenu({
  row,
}: {
  row: AgentRuntimeConversation;
}): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-grid size-6 place-items-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary"
          title="Show runtime details"
          aria-label="Show runtime details"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[200px] rounded-sm border border-border bg-bg-floating p-3 text-xs shadow-popover"
        >
          <dl className="flex flex-col gap-1.5">
            <RuntimeDetail label="PID">
              {row.pid !== null ? (
                <span className="font-mono">{row.pid}</span>
              ) : (
                <span className="text-text-muted">—</span>
              )}
            </RuntimeDetail>
            <RuntimeDetail label="Conversation">
              <span className="font-mono text-text-muted">{row.conversation_id}</span>
            </RuntimeDetail>
            {row.thread_id !== null ? (
              <RuntimeDetail label="Thread">
                <span className="font-mono text-text-muted">{row.thread_id}</span>
              </RuntimeDetail>
            ) : null}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RuntimeDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}

/**
 * One unified glyph family at one size so the leading column doesn't
 * jitter between an `MessageCircle` (visually compact circle) and an
 * `MessageSquare` (visually larger filled rect). Mirrors the channel
 * sidebar's vocabulary: Hash for top-level channels, MessageSquareText
 * for threads, AtSign for DM-style surfaces (DM channel + agent home).
 */
function ConversationIcon({
  kind,
  workspaceKind,
}: {
  kind: AgentRuntimeConversation['conversation_kind'];
  workspaceKind: AgentRuntimeConversation['workspace_kind'];
}): JSX.Element {
  const cls = 'size-3.5 shrink-0 text-text-muted';
  if (kind === 'thread') return <MessageSquareText className={cls} />;
  if (kind === 'dm_channel' || workspaceKind === 'agent_home')
    return <AtSign className={cls} />;
  return <Hash className={cls} />;
}

function FilterTabs({
  value,
  onChange,
}: {
  value: ActivityFilter;
  onChange: (next: ActivityFilter) => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center rounded-sm border border-border-subtle bg-bg-base p-0.5">
      {FILTERS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-sm px-2 py-0.5 text-[11px] transition-colors',
            opt.value === value
              ? 'bg-bg-floating text-text-primary'
              : 'text-text-muted hover:text-text-primary',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
