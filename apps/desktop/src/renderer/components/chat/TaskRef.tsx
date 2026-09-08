import { taskChannelLabel } from "../../features/task-shell/model/task-place.js";
import { useState } from "react";
import { useTaskByNumber } from "@/features/task-shell/hooks/use-task-by-number";
import { useTaskRefContext } from "@/features/task-shell/components/task-ref-context";
import { useUpdateTaskStatus } from "@/features/task-shell/hooks/hooks";
import { TaskStatusBadge } from "@/features/task-shell/components/task-status-badge";
import { HoverPopover } from "./HoverPopover";
import { useRelativeTime } from "./useRelativeTime";
import type { TaskSummaryDto, TaskStatus } from "@silverhand/shared";

interface TaskRefProps {
  /** Raw `<n>` from the `#task:<n>` sigil — already validated as a
   *  positive integer by the markdown tokenizer. */
  taskNumber: number;
  /** Bare `#<n>` origin (no `#task:` sigil). When true, the non-resolved
   *  states (no context / loading / resolved-missing) render the literal
   *  `#<n>` text with NO chip — a bare number that isn't a task must not
   *  sprout chrome. Only a resolved-present task yields a chip, identical
   *  to the explicit sigil. Default (false) keeps the explicit `#task:<n>`
   *  behaviour, which differs only in the transient states: no-context and
   *  loading show a muted pill (bare stays raw there). An unresolvable ref
   *  (authoritative miss or request error) renders raw in BOTH modes, and a
   *  resolved one yields the chip. */
  bare?: boolean;
}

export interface StaticTaskRefSummary {
  task_number: number;
  title: string;
}

/**
 * Static, non-interactive `#task:<n>` chip for surfaces that must not
 * mount the live `TaskRef` hook/query stack (PNG export, screenshot
 * contracts). It carries the same `[data-task-ref]` chrome hook AND the
 * same `data-task-ref-state` as the live chip, so every theme paints it
 * identically to the interactive row — the export is a snapshot, not a
 * second styling axis.
 *
 * A RESOLVED ref mirrors the live `interactiveChip` (below) byte for byte
 * on the visual axis: `data-task-ref-state='resolved'` + a borderless
 * `text-accent` link with NO fill and NO `px-1.5 -mx-0.5` padding. Both the
 * shared base (`.markdown-body [data-task-ref][data-task-ref-state='resolved']`,
 * global.css — accent link) and forza6's override (ink text + gold 记号笔,
 * forza6-components.css) key EXACTLY on `state='resolved'`; the old
 * `static-resolved` matched neither, so the export fell back to bare
 * `text-accent` and rendered forza6's task-ref as festive pink instead of the
 * live ink+marker (#task:1803). Keeping the state in lockstep closes that
 * drift structurally — a future task-ref restyle propagates to the export for
 * free. The only live bits dropped are interaction-only (role / tabIndex /
 * handlers / cursor / focus ring), which paint nothing in a static image.
 *
 * An UNRESOLVED ref stays the muted `bg-bg-elevated` pill (state `static`).
 * The export pre-resolves refs, so a null here means "not resolvable at
 * snapshot time" — an unknown, not a definitive miss. It therefore mirrors the
 * live no-context / loading pill (the states that still carry a fill), NOT the
 * live unresolvable ref (miss or request error), which demotes to raw prose
 * text (see `TaskRef`).
 */
export function TaskRefStaticChip({
  taskNumber,
  task,
}: TaskRefProps & { task?: StaticTaskRefSummary | null }): JSX.Element {
  const inertLabel = `#task:${taskNumber}`;
  if (!task) {
    return (
      <span
        className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="static"
      >
        <span className="truncate">{inertLabel}</span>
      </span>
    );
  }
  // Same silhouette as the live `interactiveChip`: borderless accent link, no
  // fill, no dead side padding. forza6 repaints it to ink + gold marker via the
  // shared `state='resolved'` hook — no export-specific styling exists.
  return (
    <span
      className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) font-medium text-accent"
      title={`Task #${task.task_number} · ${task.title}`}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
    >
      <span className="truncate">
        <span data-task-ref-num>#{task.task_number}</span> {task.title}
      </span>
    </span>
  );
}

/**
 * Inline chip rendering of a `#task:<n>` reference.
 *
 * Mirrors the structural choices of `ConversationRef` but addresses
 * tasks by their board-scoped numeric id. Resolution context
 * (the conversation the sigil sits in + click handler) flows through
 * `TaskRefContext` — no prop drilling from the many Markdown call sites.
 *
 * Rendering rules:
 *  - No context → inert `#task:<n>` text. Saved/preview surfaces that
 *    don't sit inside a conversation can't answer "which board?".
 *  - Lookup loading → inert (no spinner / placeholder shimmer) on the
 *    chip itself. The hover popover shows a skeleton if the user
 *    hovers ≥500ms while the fetch is still in flight.
 *  - Unresolvable (authoritative miss — deleted / never existed — or a
 *    request error that outlived its retries) → raw prose text. Surfacing a
 *    broken chip would be worse than a silent demote.
 *  - Resolved + present → clickable borderless accent link, label
 *    `#<n> title` (number and title read as one link, no `·` separator;
 *    no leading glyph — the `#` is the task's inline identity marker,
 *    like `#` for a channel, so the chip needs no CheckSquare in prose,
 *    #task:1765).
 *    The link form is the shared base across all themes — flat accent
 *    text at rest, hover underlines the label — each theme just paints
 *    it in its own `--accent` (#task:1725). Click hands off to
 *    `onOpenTask` from
 *    context with the RESOLVED task id (not the `#<n>` the chip
 *    shows), which is wired to write `?task=<task_id>` and open the
 *    task's detail modal (#task:1715). The chip is only interactive in
 *    this state, so the id is always in hand at click time. Hover
 *    ≥500ms surfaces a popover with status / assignee / conversation
 *    context.
 */
export function TaskRef({ taskNumber, bare = false }: TaskRefProps): JSX.Element {
  const ctx = useTaskRefContext();
  const conversationId = ctx?.conversationId ?? null;
  const result = useTaskByNumber(
    ctx ? { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId } : null,
    taskNumber,
  );
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
  // loading (data not yet settled), and every terminal non-resolution (miss
  // or request error). The explicit `#task:<n>` sigil keeps a muted chip only
  // in the transient no-context / loading states; an unresolvable ref demotes
  // to raw text in both modes (below). A bare number is too ambiguous to mark
  // up until it's confirmed to be a real task.
  if (bare && !task) {
    return <>{`#${taskNumber}`}</>;
  }

  // No-context (saved/preview surfaces with no board to resolve against)
  // renders a tooltip-only pill with no popover — there's nothing meaningful to
  // surface on hover. Loading WITH conversation context goes through
  // HoverPopover with `isContentReady=false` so a hover ≥500ms while the fetch
  // is still in flight gets a skeleton; an unresolvable ref (miss or request
  // error) instead demotes to raw text below.
  if (!conversationId) {
    return (
      <span
        className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
        title={`Task ${inertLabel}`}
        data-task-ref={String(taskNumber)}
        data-task-ref-state="no-context"
      >
        {/* No `font-mono` on the label — the number follows the chip's own
            typeface (`--appearance-prose-font`, sans by default). forza6's
            `--font-mono` resolves to Space Mono, whose digits read poorly
            (@shiki `sLh6CqwNw0uAtThk`, #task:1757). */}
        <span className="truncate">{inertLabel}</span>
      </span>
    );
  }

  if (result.isLoading) {
    const loadingChip = (
      <span
        className="inline-flex max-w-55 items-center gap-1 rounded-(--chip-radius) bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
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
        <span className="truncate">{inertLabel}</span>
      </span>
    );
    return <HoverPopover trigger={loadingChip} content={null} isContentReady={false} />;
  }

  if (!task) {
    // No entity resolved — either an authoritative miss (404: deleted / never
    // existed / not visible on this board) or a request error that outlived its
    // retries (backend unreachable / transport). Both demote to the raw authored
    // `#task:<n>`, fully inheriting prose style: no chip fill / border / hover /
    // cursor, not navigable. A ref that resolves to no openable task must not
    // masquerade as an openable chip. Only loading (pending) and no-context (no
    // board to resolve against) keep the muted pill — they are not terminal
    // (#task:2143).
    return <>{inertLabel}</>;
  }

  const label = `#${task.task_number} · ${task.title}`;
  const tooltip = `Task ${label}`;
  // The number sits in its own `data-task-ref-num` span so a theme can give
  // digits their own display face while the title keeps prose sans. By default
  // both inherit `--appearance-prose-font` (one sans run, no mono/sans seam —
  // never `font-mono`: forza6's `--font-mono` is Space Mono, whose digits read
  // poorly, @shiki `sLh6CqwNw0uAtThk`, #task:1757). forza6 alone routes the
  // number to `--font-display` (Rajdhani) — a deliberate "number is a number,
  // title is a title" hierarchy matching its board / popover stamp, not a seam
  // (#task:1760).
  const chipContent = (
    <>
      <span className="truncate">
        <span data-task-ref-num>#{task.task_number}</span> {task.title}
      </span>
    </>
  );

  const inertChip = (
    <span
      className="inline-flex max-w-55 items-center gap-0.5 rounded-(--chip-radius) bg-bg-elevated px-1.5 -mx-0.5 font-medium text-text-muted"
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

  // Borderless accent link — the shared base for every theme. Rest is flat
  // accent text (no fill / no border); hover underlines the label span (see
  // `.markdown-body [data-task-ref-state='resolved']:hover > span` in
  // global.css — text-decoration targets the label span directly). A filled
  // block reads as a slab in running prose regardless of
  // hue; a link reads as what it is (#task:1725). Each theme just supplies its
  // own `--accent`. focus-visible outline kept — the sole focus signal now that
  // the chip is borderless.
  //
  // No `px-1.5 -mx-0.5`: unlike the inert variants (which keep a
  // `bg-bg-elevated` fill that needs side padding), this chip has no fill, so
  // the padding was dead box drawn around a bare link. The `-mx-0.5` only
  // existed to pull that padded box back into the text flow; with the padding
  // gone it would instead pull the chip 2px into its neighbours. Dropping both
  // lets the link sit as plain inline text — the hover marker/underline rides
  // the label span, which already hugs the words (shiki, #task:1770).
  //
  // The one surface that DOES fill on hover — the non-forza6
  // system-activity-cluster (accent tile, global.css
  // `.system-activity-cluster [data-task-ref]:hover`) — reintroduces the
  // horizontal padding in CSS, not here: padding belongs to the filled
  // surface, not the shared component, so a fill-less surface never pays for
  // it. forza6's cluster is a bare marker and zeroes it back out (#task:1776).
  const interactiveChip = (
    <span
      role="button"
      tabIndex={0}
      className="inline-flex max-w-55 cursor-pointer items-center gap-1 rounded-(--chip-radius) font-medium text-accent focus-outline"
      aria-label={tooltip}
      data-task-ref={String(taskNumber)}
      data-task-ref-state="resolved"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenTask?.(task.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
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
  // surfaces with workspace context but no task-open host).
  return (
    <HoverPopover
      trigger={onOpenTask ? interactiveChip : inertChip}
      content={
        <TaskPopoverBody
          task={task}
          onStatusChange={(next) => updateStatus.mutate({ taskId: task.id, status: next })}
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
  const channelLabel = taskChannelLabel(task);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span data-tasks-num className="font-mono text-(length:--text-badge) text-text-muted">
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
      <p className="wrap-break-word text-xs font-medium text-text-primary">{task.title}</p>
      <p className="flex items-baseline gap-1.5 text-(length:--text-meta) text-text-muted">
        <span className="shrink-0 text-text-secondary">
          {task.assignee ? task.assignee.name : <em>unassigned</em>}
        </span>
        {channelLabel !== null ? (
          <>
            <span aria-hidden className="shrink-0 text-text-muted/60">
              ·
            </span>
            <span className="min-w-0 truncate text-text-secondary" title={channelLabel}>
              in {channelLabel}
            </span>
          </>
        ) : null}
        <span aria-hidden className="shrink-0 text-text-muted/60">
          ·
        </span>
        <span className="shrink-0" title={absolute}>
          {relative}
        </span>
      </p>
    </div>
  );
}
