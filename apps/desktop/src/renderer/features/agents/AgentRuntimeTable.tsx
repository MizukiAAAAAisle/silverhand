import { ArrowRight, AtSign, Hash, MessageSquareText } from 'lucide-react';
import type {
  AgentRuntimeConversation,
  AgentRuntimeStateDto,
} from '@silverhand/shared';

interface AgentRuntimeTableProps {
  state: AgentRuntimeStateDto | undefined;
  /** Click handler — switch the main view to this channel/thread. */
  onOpenConversation?: (s: AgentRuntimeConversation) => void;
}

export function AgentRuntimeTable({
  state,
  onOpenConversation,
}: AgentRuntimeTableProps): JSX.Element {
  const rows = state?.conversation_agents ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-text-muted">
        Every channel or thread this agent participates in. Status is
        live — restart or hard-stop from the channel header.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted">
          Not in any conversation yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-base text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Thread</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">PID</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.conversation_id}
                  className="border-t border-border-subtle align-middle first:border-t-0 hover:bg-bg-hover"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <ConversationIcon
                        kind={row.conversation_kind}
                        workspaceKind={row.workspace_kind}
                      />
                      <span className="text-text-primary">
                        {row.workspace_kind === 'agent_home'
                          ? row.channel_title
                          : `${row.workspace_name} / ${row.channel_title}`}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-text-primary">
                    <span className="inline-flex items-center gap-1.5">
                      {row.closed_at !== null ? (
                        <span className="rounded bg-bg-base px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                          closed
                        </span>
                      ) : null}
                      <span>{row.thread_title ?? '—'}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusPill status={row.status} closed={row.closed_at !== null} />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-text-muted">
                    {row.pid ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {onOpenConversation ? (
                      <button
                        type="button"
                        onClick={() => onOpenConversation(row)}
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
    </div>
  );
}

function StatusPill({
  status,
  closed,
}: {
  status: AgentRuntimeConversation['status'];
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
