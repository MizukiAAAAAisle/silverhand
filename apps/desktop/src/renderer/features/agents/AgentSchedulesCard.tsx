import { useMemo, useState } from 'react';
import {
  CalendarClock,
  Clock,
  RefreshCcw,
  Repeat,
  X,
} from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type {
  ScheduleDto,
  ScheduleListStatusFilter,
  ScheduleStatus,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { useAgentSchedules, useCancelAgentSchedule } from './hooks';

dayjs.extend(relativeTime);

interface AgentSchedulesCardProps {
  agentId: string;
}

const STATUS_FILTERS: Array<{ value: ScheduleListStatusFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
];

/**
 * User-facing surface for an agent's schedule rows.
 *
 * This card is the primary audit/observability surface for schedules
 * — the agent creates them via the MCP tool but cannot show them to
 * the user except by chatting. The list also doubles as the recovery
 * path when a fire is mis-rendered in the wake DM (see task #184):
 * even if the user misses the system message, the row here still
 * shows `fired_count` and the last status, which is why we keep both
 * audit counters visible even after switching from the old <table>.
 *
 * Cancel is the only mutation; creation is intentionally agent-only
 * to preserve the "agent owns its own wake plans" semantic.
 *
 * Layout: each schedule is a `ScheduleItem` card (kind icon chip +
 * message + meta strip + cancel/disclosure). Replaces the previous
 * 6-column <table>; the new shape leads with the message (the
 * user-meaningful field) and tucks counters/cron-spec into a muted
 * meta row underneath. PR-3 (#task:396).
 */
export function AgentSchedulesCard({ agentId }: AgentSchedulesCardProps): JSX.Element {
  const [filter, setFilter] = useState<ScheduleListStatusFilter>('active');
  const query = useAgentSchedules(agentId, filter);
  const cancel = useCancelAgentSchedule(agentId);

  const rows = useMemo(() => query.data ?? [], [query.data]);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-xs text-text-muted">
          Self-scheduled wakes. Read-only here, cancel only.
        </p>
        <div className="flex items-center gap-1">
          <FilterTabs value={filter} onChange={setFilter} />
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCcw
              className={`size-3 ${query.isFetching ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </header>

      {query.isError ? (
        <div className="rounded-md border border-dashed border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
          Failed to load schedules.
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted">
          {filter === 'active'
            ? 'No active schedules.'
            : `No schedules with status ${filter}.`}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(row => (
            <ScheduleItem
              key={row.id}
              row={row}
              cancelling={cancel.isPending && cancel.variables === row.id}
              onCancel={() => cancel.mutate(row.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleItem({
  row,
  cancelling,
  onCancel,
}: {
  row: ScheduleDto;
  cancelling: boolean;
  onCancel: () => void;
}): JSX.Element {
  const cancellable = row.status === 'pending' || row.status === 'firing';
  // `next_fire_at` is only meaningful while the row is still live. For
  // any terminal status the stored value is stale (e.g. a failed row
  // would otherwise keep saying "in 3 minutes" forever), so collapse
  // the countdown to em-dash and skip the ISO tooltip.
  const hasFutureFire = row.status === 'pending' || row.status === 'firing';
  const terminal = !cancellable;
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-md border border-border-subtle bg-bg-floating/50 px-4 py-3 transition-colors hover:bg-bg-hover/60',
        terminal ? 'opacity-70' : '',
      )}
    >
      <KindChip kind={row.spec.kind} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-medium text-text-primary"
          title={row.message}
        >
          {row.message}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
          <span
            className="font-medium text-text-secondary"
            title={hasFutureFire ? dayjs(row.next_fire_at).toISOString() : undefined}
          >
            {hasFutureFire ? dayjs(row.next_fire_at).fromNow() : '—'}
          </span>
          <StatusPill status={row.status} />
          <span className="font-mono">{kindSpecText(row)}</span>
          <span className="font-mono">
            {row.fired_count}
            {row.max_occurrences ? ` / ${row.max_occurrences}` : ' / ∞'} fired
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {cancellable ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-50"
            title="Cancel"
          >
            <X className="size-3" />
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Coloured square chip with the kind glyph. Three-token palette
 *  (once=accent / interval=success / cron=warning) — all themes
 *  expose these semantic tokens, so the chip adapts cleanly when the
 *  theme changes. We deliberately avoid `--accent-2`: warm-script
 *  aliases it to `--accent`, which would collapse to the once color
 *  and lose discriminability. */
function KindChip({
  kind,
}: {
  kind: ScheduleDto['spec']['kind'];
}): JSX.Element {
  const cls =
    kind === 'once'
      ? 'bg-accent-soft text-accent'
      : kind === 'interval'
        ? 'bg-success-soft text-success'
        : 'bg-warning-soft text-warning';
  const Icon =
    kind === 'once'
      ? Clock
      : kind === 'interval'
        ? Repeat
        : CalendarClock;
  return (
    <span
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-md',
        cls,
      )}
      title={kind}
      aria-label={`${kind} schedule`}
    >
      <Icon className="size-4" />
    </span>
  );
}

function kindSpecText(row: ScheduleDto): string {
  switch (row.spec.kind) {
    case 'once':
      return 'once';
    case 'interval':
      return `every ${row.spec.every_seconds}s`;
    case 'cron':
      return `cron ${row.spec.expression} · ${row.spec.timezone}`;
  }
}

function StatusPill({ status }: { status: ScheduleStatus }): JSX.Element {
  // Maps the persisted `ScheduleStatus` enum to the standard
  // soft-bg + on-color pill. Mirrors AgentConversationActivityList's
  // pill vocabulary so the two surfaces feel consistent.
  const cls =
    status === 'pending'
      ? 'bg-success-soft text-success'
      : status === 'firing'
        ? 'bg-accent-soft text-accent'
        : status === 'done'
          ? 'bg-bg-base text-text-muted'
          : status === 'cancelled'
            ? 'bg-bg-base text-text-secondary'
            : 'bg-error-soft text-error'; // failed
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        cls,
      )}
    >
      {status}
    </span>
  );
}

function FilterTabs({
  value,
  onChange,
}: {
  value: ScheduleListStatusFilter;
  onChange: (next: ScheduleListStatusFilter) => void;
}): JSX.Element {
  return (
    <div className="flex items-center rounded-md border border-border-subtle bg-bg-base p-0.5">
      {STATUS_FILTERS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] transition-colors',
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
