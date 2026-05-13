import { ClipboardCheck } from 'lucide-react';
import { useTaskByNumber } from '@/features/tasks/useTaskByNumber';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';

interface TaskRefProps {
  /** Raw `<n>` from the `#task:<n>` sigil — already validated as a
   *  positive integer by the markdown tokenizer. */
  taskNumber: number;
}

/**
 * Inline chip rendering of a `#task:<n>` reference.
 *
 * Mirrors the structural choices of `ConversationRef` but addresses
 * tasks by their workspace-scoped numeric id. Resolution context
 * (current workspace + click handler) flows through `TaskRefContext`
 * — no prop drilling from the many Markdown call sites.
 *
 * Rendering rules:
 *  - No context → inert `#task:<n>` text. Saved/preview surfaces that
 *    don't sit inside a conversation can't answer "which workspace?".
 *  - Lookup loading → inert (no spinner / placeholder shimmer). The
 *    chip just briefly looks like the unresolved fallback; popover
 *    skeleton lands in PR-4 commit 3.
 *  - Resolved + missing → inert (the task was deleted or doesn't
 *    exist in this workspace). Surfacing a broken chip would be
 *    worse than a silent demote.
 *  - Resolved + present → clickable chip, label `#<n> · title`,
 *    icon `ClipboardCheck`. Click hands off to `onOpenTask` from
 *    context, which is wired to write `?task=<n>` and open the
 *    Tasks drawer focused on that row.
 */
export function TaskRef({ taskNumber }: TaskRefProps): JSX.Element {
  const ctx = useTaskRefContext();
  const workspaceId = ctx?.workspaceId ?? null;
  const result = useTaskByNumber(workspaceId, taskNumber);
  const task = result.data ?? null;
  const onOpenTask = ctx?.onOpenTask;
  const inertLabel = `#task:${taskNumber}`;

  // Inert paths (no context, still loading, resolved-missing) all
  // render the same plain pill so layout doesn't reflow on resolution.
  if (!workspaceId || result.isLoading || !task) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state={
          !workspaceId
            ? 'no-context'
            : result.isLoading
              ? 'loading'
              : 'missing'
        }
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate">{inertLabel}</span>
      </span>
    );
  }

  const label = `#${task.task_number} · ${task.title}`;
  const tooltip = `Task ${label}`;
  const content = (
    <>
      <ClipboardCheck className="size-3 shrink-0 self-center" />
      <span className="truncate">{label}</span>
    </>
  );

  if (!onOpenTask) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={tooltip}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="resolved-no-handler"
      >
        {content}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      title={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpenTask(taskNumber);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpenTask(taskNumber);
      }}
    >
      {content}
    </span>
  );
}
