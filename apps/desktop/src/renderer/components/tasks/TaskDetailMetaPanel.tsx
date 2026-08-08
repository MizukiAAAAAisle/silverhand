import type { TaskDetailDto, TaskStatus } from '@silverhand/shared';
import { useTaskMetaRows, type TaskMetaWriteProps } from '@/components/tasks/taskDetailShared';

export interface TaskDetailMetaPanelProps {
  /** The AUTHORITATIVE detail read. Never a board summary merged in per field: a
   *  nullable field (assignee, closed_at) merged field-by-field lets a stale
   *  summary value win over a freshly cleared one, and the terminal-status gate
   *  must not be judged from a possibly-stale status either. The dialog only
   *  mounts this column once the read resolves, so there is no such window
   *  (#task:1715). */
  view: TaskDetailDto;
  /** A dialog-local write occupies the single write slot — the title/content
   *  inline editor being OPEN counts, not just an in-flight request. Blocks
   *  every trigger here so one interaction can't start a second write whose
   *  response would land on top of the first (shiki 2026-07-29: "ui 上可以加状态
   *  来阻塞用户"). Not a concurrency protocol: remote writes stay last-write-wins,
   *  converging over `task_changed`. */
  busy: boolean;
  statusPending: boolean;
  statusFailed: boolean;
  onStatusChange: (status: TaskStatus) => void;
  assignPending: boolean;
  assignFailed: boolean;
  /** `null` clears the assignee. */
  onAssign: (agentId: string | null) => void;
}

/**
 * The task detail modal's metadata column — the sidebar half of the two-column
 * body (#task:1711, spec from #task:1710).
 *
 * It exists because the 800px modal (#task:1675) left a short task reading as a
 * horizontal bar, AND because assignee / creator / channel / created / closed
 * were not shown in the modal at all. So the column fills real gaps rather than
 * padding the layout: every row is a task fact the header couldn't carry.
 *
 * The ROWS themselves — which fields, in what order, with what value and write
 * wiring — come from the shared `useTaskMetaRows` SSOT, so the modal sidebar and
 * the conversation pane can never fork on the field set. What stays HERE is only
 * this surface's LAYOUT: a fixed 240px left-bordered sidebar with a 68px/1fr row
 * grid.
 */
export function TaskDetailMetaPanel(props: TaskDetailMetaPanelProps): JSX.Element {
  const rows = useTaskMetaRows(props satisfies TaskMetaWriteProps);
  return (
    <aside
      // Theme-neutral hook: names the DOM role only, so a theme can paint the
      // divider its own way (forza6 gets a 2px ink edge — `border-border-subtle`
      // is a hairline there, it does not thicken on its own).
      data-task-meta-panel
      aria-label="Task metadata"
      // 240px is MEASURED, not slack: label 68 + gap 8 + value ~132 + px-4 (32).
      // The value column has to hold `2026-07-28 16:45` in 11px mono and an
      // `@display_name` — don't compress it to add fields.
      //
      // No ground of its own: the column sits on the dialog's own
      // `bg-bg-floating` (shiki 2026-07-29), so the divider is the only
      // separator. A second fill here read as a panel bolted onto the modal.
      className="flex w-[240px] shrink-0 flex-col gap-y-3.5 overflow-y-auto border-l border-border-subtle px-4 py-4"
    >
      {rows.map((row) => (
        <MetaRow key={row.key} label={row.label} error={row.error}>
          {row.value}
        </MetaRow>
      ))}
    </aside>
  );
}

/** One metadata row: label left, value right, both LEFT-aligned — a
 *  right-aligned value column would make the right edge jitter with value
 *  length. Label uses the shared `.chrome-label` utility so forza6 gets its
 *  Rajdhani caps for free. */
function MetaRow({
  label,
  error,
  children,
}: {
  label: string;
  /** Inline write failure for THIS row — an 11px line under the value. No
   *  toast, no dialog: the failure belongs where the write was started. */
  error?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[68px_1fr] items-start gap-x-2">
      <span className="chrome-label text-[length:var(--text-badge)] font-medium leading-4 text-text-muted">
        {label}
      </span>
      <div className="min-w-0 text-xs leading-4 text-text-primary">
        {children}
        {error ? <p className="mt-0.5 text-[length:var(--text-meta)] text-error">{error}</p> : null}
      </div>
    </div>
  );
}
