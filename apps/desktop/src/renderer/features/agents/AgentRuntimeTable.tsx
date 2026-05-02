import { ArrowRight, MessageCircle, MessageSquare } from 'lucide-react';
import type {
  AgentRuntimeSession,
  AgentRuntimeStateDto,
} from '@silverhand/shared';

interface AgentRuntimeTableProps {
  state: AgentRuntimeStateDto | undefined;
  /** Click handler — switch the main view to this channel/session. */
  onOpenSession?: (s: AgentRuntimeSession) => void;
}

export function AgentRuntimeTable({
  state,
  onOpenSession,
}: AgentRuntimeTableProps): JSX.Element {
  const rows = state?.session_agents ?? [];
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-floating p-4">
      <header>
        <h2 className="font-serif text-sm font-semibold text-text-primary">
          Where this agent runs
        </h2>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Every (channel, session) pair this agent participates in.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted">
          Not in any session yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-base text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Session</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">PID</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={`${row.session_id}`}
                  className="border-t border-border-subtle first:border-t-0 hover:bg-bg-hover"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {row.channel_kind === 'dm' ? (
                        <MessageCircle className="size-3 text-text-muted" />
                      ) : (
                        <MessageSquare className="size-3 text-text-muted" />
                      )}
                      <span className="text-text-primary">
                        {row.channel_kind === 'dm'
                          ? row.channel_name.replace(/^dm-/, '')
                          : `#${row.channel_name}`}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-text-primary">
                    {row.session_title}
                    {row.closed_at !== null ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-text-muted">
                        closed
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusPill status={row.status} closed={row.closed_at !== null} />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-text-muted">
                    {row.pid ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {onOpenSession ? (
                      <button
                        type="button"
                        onClick={() => onOpenSession(row)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
                        title="Open"
                      >
                        Open
                        <ArrowRight className="size-3" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusPill({
  status,
  closed,
}: {
  status: AgentRuntimeSession['status'];
  closed: boolean;
}): JSX.Element {
  if (closed) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
        —
      </span>
    );
  }
  const cls =
    status === 'active'
      ? 'bg-success/10 text-success'
      : status === 'starting'
        ? 'bg-accent-soft text-accent'
        : status === 'crashed'
          ? 'bg-error/10 text-error'
          : 'bg-bg-base text-text-muted';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}
