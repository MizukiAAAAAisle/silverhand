import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useTaskByNumber } from '@/features/tasks/useTaskByNumber';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';
import { useUpdateTaskStatus } from '@/features/tasks/hooks';
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge';
import { HoverPopover } from './HoverPopover';
import { useRelativeTime } from './useRelativeTime';
import type { TaskSummaryDto, TaskStatus } from '@silverhand/shared';

interface TaskRefProps {
  /** Raw `<n>` from the `#task:<n>` sigil — already validated as a
   *  positive integer by the markdown tokenizer. */
  taskNumber: number;
  /** Bare `#<n>` origin (no `#task:` sigil). When true, the non-resolved
   *  states (no context / loading / resolved-missing) render the literal
   *  `#<n>` text with NO chip — a bare number that isn't a task must not
   *  sprout chrome. Only a resolved-present task yields a chip, identical
   *  to the explicit sigil. Default (false) keeps the explicit `#task:<n>`
   *  behaviour: a muted chip in every state. */
  bare?: boolean;
}

export interface StaticTaskRefSummary {
  task_number: number;
  title: string;
}

/**
 * Static, non-interactive `#task:<n>` chip for surfaces that must not
 * mount the live `TaskRef` hook/query stack (PNG export, screenshot
 * contracts). It intentionally carries the same `[data-task-ref]` chrome
 * hook as live chips so theme styling stays consistent.
 */
export function TaskRefStaticChip({
  taskNumber,
  task,
}: TaskRefProps & { task?: StaticTaskRefSummary | null }): JSX.Element {
  const inertLabel = `#task:${taskNumber}`;
  const label = task ? `#${task.task_number} · ${task.title}` : inertLabel;
  return (
    <span
      className={
        'inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] px-1.5 -mx-0.5 font-medium' +
        (task
          ? ' bg-accent-soft text-accent'
          : ' bg-bg-elevated text-text-muted')
      }
      title={`Task ${label}`}
      data-task-ref={String(taskNumber)}
      data-task-ref-state={task ? 'static-resolved' : 'static'}
    >
      <ClipboardCheck className="size-3 shrink-0 self-center" />
      {task ? (
        <span className="truncate">
          <span className="font-mono">#{task.task_number}</span>
          {' · '}
          {task.title}
        </span>
      ) : (
        <span className="truncate font-mono">{inertLabel}</span>
      )}
    </span>
  );
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
 *  - Lookup loading → inert (no spinner / placeholder shimmer) on the
 *    chip itself. The hover popover shows a skeleton if the user
 *    hovers ≥500ms while the fetch is still in flight.
 *  - Resolved + missing → inert (the task was deleted or doesn't
 *    exist in this workspace). Surfacing a broken chip would be
 *    worse than a silent demote.
 *  - Resolved + present → clickable chip, label `#<n> · title`,
 *    icon `ClipboardCheck`. Click hands off to `onOpenTask` from
 *    context with the RESOLVED task id (not the `#<n>` the chip
 *    shows), which is wired to write `?task=<task_id>` and open the
 *    task's detail modal (#task:1715). The chip is only interactive in
 *    this state, so the id is always in hand at click time. Hover
 *    ≥500ms surfaces a popover with status / assignee / conversation
 *    context.
 */
export function TaskRef({ taskNumber, bare = false }: TaskRefProps): JSX.Element {
  const ctx = useTaskRefContext();
  const workspaceId = ctx?.workspaceId ?? null;
  const result = useTaskByNumber(workspaceId, taskNumber);
  const task = result.data ?? null;
  const onOpenTask = ctx?.onOpenTask;
  const inertLabel = `#task:${taskNumber}`;
  // Status-picker open state lifted here (not inside TaskPopoverBody) so
  // we can pin the hover-card open via `keepOpen` while the picker is
  // active — the picker portals outside the hover-card DOM, so without
  // this the pointer-leave close delay would unmount it mid-pick.
  const [pickerOpen, setPickerOpen] = useState(false);
  const updateStatus = useUpdateTaskStatus();

  // Bare `#<n>` with no resolved task → render the literal `#<n>` text,
  // no chip. One gate covers no-context (hook disabled → no data),
  // loading (data not yet settled), and resolved-missing (task deleted /
  // never existed). The explicit `#task:<n>` sigil keeps its muted chip
  // in these states instead; a bare number is too ambiguous to mark up
  // until it's confirmed to be a real task.
  if (bare && !task) {
    return <>{`#${taskNumber}`}</>;
  }

  // No-context (saved/preview surfaces) and resolved-missing (task
  // deleted or never existed in this workspace) render a tooltip-only
  // pill with no popover — there's nothing meaningful to surface on
  // hover for either case. Loading WITH workspace context goes through
  // HoverPopover with `isContentReady=false` so a hover ≥500ms while
  // the fetch is still in flight gets a skeleton (Cindy review of
  // commit 3 — previously the loading branch returned a bare span,
  // missing the 500ms→skeleton spec entirely).
  if (!workspaceId) {
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="no-context"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        {/* Whole label is ASCII (`#task:NNN`) → mono everywhere on the
            inert/loading/missing chips. See forza6 font split spec. */}
        <span className="truncate font-mono">{inertLabel}</span>
      </span>
    );
  }

  if (result.isLoading) {
    const loadingChip = (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        // Wrapped in HoverPopover below — use aria-label, not the
        // native `title` attribute. macOS browsers schedule the native
        // tooltip on a 2-3s cycle that competes with Radix HoverCard
        // (mouse "leaves" the trigger when the OS tooltip overlays
        // it, which closes the popover; then mouseenter reopens after
        // the 500ms grace, producing a periodic flicker — @shiki
        // report `NbcXUOnFDKfXYRxV`).
        aria-label={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="loading"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate font-mono">{inertLabel}</span>
      </span>
    );
    return (
      <HoverPopover
        trigger={loadingChip}
        content={null}
        isContentReady={false}
      />
    );
  }

  if (!task) {
    // Resolved-missing — tooltip only, no popover. A "task not found"
    // popover doesn't add information beyond the inert pill.
    return (
      <span
        className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="missing"
      >
        <ClipboardCheck className="size-3 shrink-0 self-center" />
        <span className="truncate font-mono">{inertLabel}</span>
      </span>
    );
  }

  const label = `#${task.task_number} · ${task.title}`;
  const tooltip = `Task ${label}`;
  // ASCII sigil (`#NNN`) renders in mono so numbers line up identically
  // across chips; title stays sans because it may contain CJK and mono
  // CJK fallback (PingFang etc.) looks uneven next to ASCII digits. See
  // forza6 font split spec (msg vWYNLYq_Wtw6P4rj).
  const chipContent = (
    <>
      <ClipboardCheck className="size-3 shrink-0 self-center" />
      <span className="truncate">
        <span className="font-mono">#{task.task_number}</span>
        {' · '}
        {task.title}
      </span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-[220px] items-center gap-0.5 rounded-[var(--chip-radius)] bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
      // Wrapped in HoverPopover below — `aria-label` instead of the
      // native `title` attribute (see loading branch comment above
      // for the flicker rationale).
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved-no-handler"
    >
      {chipContent}
    </span>
  );

  const interactiveChip = (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-[220px] cursor-pointer items-center gap-0.5 rounded-[var(--chip-radius)] bg-accent-soft px-1.5 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent hover:text-text-on-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(task.id);
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(task.id);
      }}
    >
      {chipContent}
    </span>
  );

  // Both interactive and inert resolved-state chips get the popover —
  // the popover is purely informational (status / assignee /
  // conversation), not a click affordance, so it makes sense even
  // when the click handler is unavailable (e.g. saved/preview
  // surfaces with workspace context but no drawer).
  return (
    <HoverPopover
      trigger={onOpenTask ? interactiveChip : inertChip}
      content={
        <TaskPopoverBody
          task={task}
          onStatusChange={next =>
            updateStatus.mutate({ taskId: task.id, status: next })
          }
          onPickerOpenChange={setPickerOpen}
        />
      }
      isContentReady={true}
      keepOpen={pickerOpen}
    />
  );
}

/**
 * Popover body — full title (no clamp) with a single inline meta row
 * for assignee · created · conversation. Earlier this was a `dl` with
 * three labelled rows; @shiki feedback (`WlIwDhmrbu6_azy1`) was that
 * the form-style layout felt heavy in such a small surface. Inline
 * meta keeps the popover scannable: title dominates, meta sits as one
 * subtle muted line that wraps if it has to.
 */
function TaskPopoverBody({
  task,
  onStatusChange,
  onPickerOpenChange,
}: {
  task: TaskSummaryDto;
  onStatusChange: (next: TaskStatus) => void;
  onPickerOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { relative, absolute } = useRelativeTime(task.created_at);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          data-tasks-num
          className="font-mono text-[10px] text-text-muted"
        >
          #{task.task_number}
        </span>
        {/* Same interactive chip as the task-pane card: click → "Move to"
            picker → POST /status. `onPickerOpenChange` pins the host
            hover-card open while the picker is up. */}
        <TaskStatusBadge
          status={task.status}
          onChange={onStatusChange}
          onOpenChange={onPickerOpenChange}
        />
      </div>
      <p className="break-words text-xs font-medium text-text-primary">
        {task.title}
      </p>
      <p className="flex items-baseline gap-1.5 text-[11px] text-text-muted">
        <span className="shrink-0 text-text-secondary">
          {task.assignee ? `@${task.assignee.name}` : <em>unassigned</em>}
        </span>
        <span aria-hidden className="shrink-0 text-text-muted/60">·</span>
        <span
          className="min-w-0 truncate text-text-secondary"
          title={task.conversation.title}
        >
          in {task.conversation.title}
        </span>
        <span aria-hidden className="shrink-0 text-text-muted/60">·</span>
        <span className="shrink-0" title={absolute}>{relative}</span>
      </p>
    </div>
  );
}
