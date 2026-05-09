import { useMemo, useState } from 'react';
import { Calendar, RefreshCcw, X } from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type {
  ScheduleDto,
  ScheduleListStatusFilter,
  ScheduleStatus,
} from '@silverhand/shared';
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
 * User-facing surface for an agent's `mcp__chat__schedule` rows.
 *
 * This card is the primary audit/observability surface for schedules
 * — the agent creates them via the MCP tool but cannot show them to
 * the user except by chatting. The schedules table also doubles as
 * the recovery path when a fire is mis-rendered in the wake DM (see
 * task #184): even if the user misses the system message, the row
 * here still shows last_fired_at / fired_count.
 *
 * Cancel is the only mutation; creation is intentionally agent-only
 * to preserve the "agent owns its own wake plans" semantic.
 */
export function AgentSchedulesCard({ agentId }: AgentSchedulesCardProps): JSX.Element {
  const [filter, setFilter] = useState<ScheduleListStatusFilter>('active');
  const query = useAgentSchedules(agentId, filter);
  const cancel = useCancelAgentSchedule(agentId);

  const rows = useMemo(() => query.data ?? [], [query.data]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-floating p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-serif text-sm font-semibold text-text-primary">
            Schedules
          </h2>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Wakes the agent created for itself. Created via the
            <code className="mx-1 rounded bg-bg-base px-1 text-[10px]">schedule</code>
            MCP tool — only the agent can add new entries.
          </p>
        </div>
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
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-base text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Next fire</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Fired</th>
                <th className="px-3 py-2 font-medium">Message</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <ScheduleRow
                  key={row.id}
                  row={row}
                  cancelling={cancel.isPending && cancel.variables === row.id}
                  onCancel={() => cancel.mutate(row.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScheduleRow({
  row,
  cancelling,
  onCancel,
}: {
  row: ScheduleDto;
  cancelling: boolean;
  onCancel: () => void;
}): JSX.Element {
  const cancellable = row.status === 'pending' || row.status === 'firing';
  // `next_fire_at` only describes a real future fire while the row is
  // still live. For any terminal status (`done|cancelled|failed`) the
  // stored value is stale, so collapse the column to `—` and skip the
  // ISO tooltip — otherwise a `failed` row keeps showing "in 3
  // minutes" forever.
  const hasFutureFire = row.status === 'pending' || row.status === 'firing';
  return (
    <tr className="border-t border-border-subtle first:border-t-0 hover:bg-bg-hover">
      <td className="px-3 py-1.5">
        <KindCell row={row} />
      </td>
      <td
        className="px-3 py-1.5 font-mono text-text-muted"
        title={hasFutureFire ? dayjs(row.next_fire_at).toISOString() : undefined}
      >
        {hasFutureFire ? dayjs(row.next_fire_at).fromNow() : '—'}
      </td>
      <td className="px-3 py-1.5">
        <StatusPill status={row.status} />
      </td>
      <td className="px-3 py-1.5 font-mono text-text-muted">
        {row.fired_count}
        {row.max_occurrences ? ` / ${row.max_occurrences}` : null}
      </td>
      <td className="px-3 py-1.5 text-text-primary">
        <span className="line-clamp-1" title={row.message}>
          {row.message}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right">
        {cancellable ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-50"
            title="Cancel"
          >
            <X className="size-3" />
            Cancel
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function KindCell({ row }: { row: ScheduleDto }): JSX.Element {
  const detail = (() => {
    if (row.spec.kind === 'once') return 'one-shot';
    if (row.spec.kind === 'interval') return `every ${row.spec.every_seconds}s`;
    return `${row.spec.expression} (${row.spec.timezone})`;
  })();
  return (
    <div className="flex items-center gap-1.5">
      <Calendar className="size-3 text-text-muted" />
      <span className="text-text-primary">{row.spec.kind}</span>
      <span className="font-mono text-[10px] text-text-muted">{detail}</span>
    </div>
  );
}

function StatusPill({ status }: { status: ScheduleStatus }): JSX.Element {
  const cls =
    status === 'pending'
      ? 'bg-accent-soft text-accent'
      : status === 'firing'
        ? 'bg-warning/10 text-warning'
        : status === 'done'
          ? 'bg-success/10 text-success'
          : status === 'failed'
            ? 'bg-error/10 text-error'
            : 'bg-bg-base text-text-muted';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
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
          className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
            opt.value === value
              ? 'bg-bg-floating text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
