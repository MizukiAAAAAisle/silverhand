import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { Clock, ExternalLink, Loader2, Pencil, type LucideIcon } from 'lucide-react';
import {
  TASK_CONTENT_MAX_LEN,
  type TaskDetailDto,
  type TaskSummaryDto,
} from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogCornerButtonClass,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge';
import { Markdown } from '@/components/chat/Markdown';
import { useEditTask, useTaskDetail } from '@/features/tasks/hooks';
import {
  resolveTaskJumpTarget,
  type TaskJumpTarget,
} from '@/features/tasks/taskDetail';
import { cn } from '@/lib/cn';

export type { TaskJumpTarget } from '@/features/tasks/taskDetail';

/** Which field is currently in inline-edit mode; `null` is the read view. Only
 *  one field edits at a time — the other field's pencil is hidden until the
 *  current edit finishes, so there is never a mid-edit switch. */
type EditingField = 'title' | 'content' | null;

export interface TaskDetailDialogProps {
  /** The clicked card's summary, or null when the modal is closed. Its
   *  `id` (the task identity) is the detail fetch key; navigation comes
   *  entirely from the viewer-resolved `nav` on the fetched detail. */
  task: TaskSummaryDto | null;
  onOpenChange: (open: boolean) => void;
  /** "View in conversation". The surface wires this to its own jump
   *  handler (the drawer additionally closes itself). The dialog closes
   *  itself after invoking it. */
  onJump: (target: TaskJumpTarget) => void;
}

/**
 * Task detail modal. Opened by clicking a task card on either board surface
 * (NavRail `TasksSection` + `WorkspaceTasksDrawer`) instead of jumping
 * straight to the source message. Reads the full body + edit-provenance
 * byline on demand.
 *
 * Editing is IN PLACE and PER FIELD: a pencil beside the title / description
 * turns just that region into an inline editor (no second modal, no global
 * edit mode). Each editor saves on blur and submits ONLY its own field as a
 * plain last-write-wins update — the omitted field stays untouched. While a
 * field is being edited the modal refuses close requests (an outside-click / ✕
 * only fires the blur-save; a validation/request failure keeps the draft in the
 * open editor) and the jump icon is hidden. "View in conversation" is the modal
 * close ✕'s TWIN — same corner-button skin (and forza6 poster-sticker), sitting
 * in the top-right action cluster just left of the close — consuming the
 * viewer-resolved `nav` discriminant (source → source message, else →
 * task-created event; hidden entirely when nav is `unavailable`).
 */
export function TaskDetailDialog({
  task,
  onOpenChange,
  onJump,
}: TaskDetailDialogProps): JSX.Element {
  const open = task !== null;
  const detailQuery = useTaskDetail(task?.id, { enabled: open });
  const detail = detailQuery.data;

  const [editingField, setEditingField] = useState<EditingField>(null);
  // Snap back to read mode whenever the modal opens onto a different task
  // (or closes) so a stale inline draft never bleeds across tasks. Note this
  // keys on `task.id`, NOT the live detail — a task_changed refetch of the
  // SAME task must not reset an open editor and wipe the unsubmitted draft.
  useEffect(() => {
    setEditingField(null);
  }, [task?.id]);

  // "View in conversation" — the close ✕'s twin in the corner cluster. Navigate
  // via the viewer-resolved `nav` discriminant: source → source message,
  // no-source → task-created event. Hidden when nav is `unavailable` OR the
  // detail hasn't resolved yet (disabled in that gap so timing never changes the
  // target), AND hidden while a field is being edited (a click would blur-save
  // then navigate away, unmounting the editor and losing the draft on failure).
  const jumpTarget = detail ? resolveTaskJumpTarget(detail) : null;
  const navUnavailable = Boolean(detail) && !jumpTarget;
  const showJump = open && editingField === null && !navUnavailable;

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Blur-save is async: an outside-click / ✕ blurs the field (firing the
        // save) AND asks the dialog to close. (Escape doesn't reach here — the
        // editor cancels it and preventDefaults, so Radix never gets it.)
        // Closing now would unmount before the write settles — a failure would
        // lose the inline error and the draft. So refuse close requests while a
        // field is being edited; the click still triggers blur-save, and
        // success drops `editingField` back to null, after which a second close
        // lands.
        if (!next && editingField !== null) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        // Widest dialog after workspace settings: the body carries prose
        // (description, edit fields) that reads badly in a 512px column.
        // Explicit px instead of a Tailwind step because 800 sits between
        // `max-w-2xl` and `max-w-3xl`.
        className="flex max-h-[80vh] max-w-[800px] flex-col gap-0 p-0"
        // This dialog owns its padding (`p-0` + a bordered header at `px-5
        // py-4`), so the cluster keeps hugging the corner: its band is the
        // metadata row, not a `p-6` title line.
        cornerBand="top"
        cornerActions={
          showJump ? (
            <button
              type="button"
              data-task-view-jump
              title="View in conversation"
              aria-label="View in conversation"
              disabled={!jumpTarget}
              onClick={() => {
                if (!jumpTarget) return;
                onJump(jumpTarget);
                onOpenChange(false);
              }}
              className={cn(
                dialogCornerButtonClass,
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              <ExternalLink className="size-4" aria-hidden />
            </button>
          ) : null
        }
      >
        {task ? (
          <TaskDetailBody
            task={task}
            detail={detail}
            loading={detailQuery.isLoading}
            failed={detailQuery.isError}
            editingField={editingField}
            onEditField={setEditingField}
            onStopEditing={() => setEditingField(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── Body ───────────────────────────────────────────────────────────

function TaskDetailBody({
  task,
  detail,
  loading,
  failed,
  editingField,
  onEditField,
  onStopEditing,
}: {
  task: TaskSummaryDto;
  detail: TaskDetailDto | undefined;
  loading: boolean;
  failed: boolean;
  editingField: EditingField;
  onEditField: (field: Exclude<EditingField, null>) => void;
  onStopEditing: () => void;
}): JSX.Element {
  const title = detail?.title ?? task.title;
  const status = detail?.status ?? task.status;
  const canEdit = Boolean(detail);

  // Byline reflects the last DEFINITION edit only (status/claim don't move it)
  // and renders only when the task has actually been edited. Absolute time to
  // the minute (a past edit never changes, so no ticking clock is needed).
  const editor = detail?.last_editor ?? null;
  const editedAt = detail?.last_edited_at ?? null;

  return (
    <>
      <DialogHeader className="gap-2 border-b border-border-subtle px-5 py-4">
        {/* Task-metadata row: number · status · edit provenance. The byline
            lives HERE (not under the title) because it reflects the last
            DEFINITION edit of the task — title OR content — so hanging it under
            the title mislabels it as a title-only timestamp. This row shares
            the corner cluster's top band, so `pr-20` reserves the cluster width
            (View + close ✕) HERE — correct, unlike padding the whole header,
            which would starve every title line. The byline truncates rather
            than sliding under the icons. */}
        <div className="flex items-center gap-2 pr-20">
          <span className="shrink-0 font-mono text-[11px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge status={status} className="shrink-0" />
          {editor && editedAt ? (
            <span className="flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
              <span className="truncate">Edited by {editor.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                <Clock className="size-3" aria-hidden />
                <time dateTime={new Date(editedAt).toISOString()}>
                  {dayjs(editedAt).format('YYYY-MM-DD HH:mm')}
                </time>
              </span>
            </span>
          ) : null}
        </div>

        {/* Title (+ its edit pencil) takes the FULL header width — reserving a
            right padding for the out-of-flow corner cluster (View + close ✕)
            wasted a dead strip down EVERY line, since the icons only occupy the
            top band. Instead a small top margin drops the title just below the
            icons so the trailing pencil breathes clear of them, without
            narrowing the title. */}
        <div className="mt-1.5">
          {editingField === 'title' && detail ? (
            <>
              {/* Radix needs a DialogTitle for a11y even while the visible title
                  is swapped for the inline editor. */}
              <DialogTitle className="sr-only">Edit task title</DialogTitle>
              <InlineFieldEditor
                taskId={detail.id}
                field="title"
                initial={detail.title}
                onDone={onStopEditing}
                onCancel={onStopEditing}
              />
            </>
          ) : (
            <div className="flex items-start gap-2">
              <DialogTitle className="flex-1 text-base leading-snug [overflow-wrap:anywhere]">
                {title}
              </DialogTitle>
              {canEdit && editingField === null ? (
                <MiniIconButton
                  icon={Pencil}
                  label="Edit title"
                  className="mt-0.5"
                  onClick={() => onEditField('title')}
                />
              ) : null}
            </div>
          )}
        </div>
        <DialogDescription className="sr-only">Task detail</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading…
          </div>
        ) : failed ? (
          <p className="text-sm text-error">Couldn’t load this task.</p>
        ) : editingField === 'content' && detail ? (
          <InlineFieldEditor
            taskId={detail.id}
            field="content"
            initial={detail.content}
            onDone={onStopEditing}
            onCancel={onStopEditing}
          />
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {detail && detail.content.trim() ? (
                <Markdown content={detail.content} />
              ) : (
                <p className="text-sm italic text-text-muted">No description.</p>
              )}
            </div>
            {canEdit && editingField === null ? (
              <MiniIconButton
                icon={Pencil}
                label="Edit description"
                className="mt-0.5"
                onClick={() => onEditField('content')}
              />
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

// ── Inline per-field editor ────────────────────────────────────────

/**
 * In-place editor for ONE field — both title and content are auto-growing
 * textareas. Mounted only while that field is active, so a task_changed
 * refetch of the same task never remounts it and the draft survives.
 *
 * Interaction is chat-composer-style: Enter saves, Shift+Enter inserts a
 * newline, and leaving the field (blur) also saves. The commit is deliberately
 * narrow —
 *   - only a real change is sent (an untouched blur just leaves edit mode);
 *   - the write carries ONLY this field (the omitted field stays unchanged — a
 *     title edit must never send `body`, and vice versa, or it clobbers it);
 *   - title is submitted VERBATIM: the single-line invariant (trim + internal
 *     whitespace collapse) is owned by `TaskTitleSchema`, and the read view
 *     refills from the canonical title in the success response — the renderer
 *     never runs a second normalization;
 *   - a validation/request failure keeps the editor open with an inline error,
 *     never silently dropping the draft;
 *   - an in-flight write dedups repeat blurs, a successful save latches so the
 *     focus-unmount blur (Enter commits while still focused) can't re-submit,
 *     and an explicit Escape-cancel wins over the blur that follows it.
 * The IME guard sits at the top of the key handler (chat-composer parity), so a
 * CJK Enter — which only confirms a candidate — never misfires a save.
 */
function InlineFieldEditor({
  taskId,
  field,
  initial,
  onDone,
  onCancel,
}: {
  taskId: string;
  field: 'title' | 'content';
  initial: string;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const edit = useEditTask();
  const [value, setValue] = useState(initial);
  // Why the editor stayed open after a blur (required title empty / body over
  // its raw limit), if at all — drives the inline error and the error border.
  const [blocked, setBlocked] = useState<'empty' | 'over' | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Escape marks a cancel BEFORE the editor unmounts, so the blur that follows
  // the unmount is a no-op — an explicit cancel must beat blur-to-save.
  const cancelledRef = useRef(false);
  // A committed save latches this: Enter fires commit while the textarea is
  // still focused, so `onDone()` unmounts a focused field → the browser fires a
  // trailing blur → commit() would run again. The latch makes that blur (and
  // any repeat) a no-op; a FAILED save unlatches so the kept draft can retry.
  const submittingRef = useRef(false);

  const isTitle = field === 'title';

  // Both fields auto-grow to their content: reset to `auto` then to the scroll
  // height on every value change so the box never scrolls internally.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  async function commit(): Promise<void> {
    // Escape already cancelled, or a save already went through (the trailing
    // focus-unmount blur must not re-submit).
    if (cancelledRef.current || submittingRef.current) return;
    if (edit.isPending) return; // a write is already in flight — dedup blurs
    if (value === initial) {
      onDone(); // untouched → just leave edit mode, send nothing
      return;
    }
    // Mirror the schema's non-empty title rule for instant feedback; the schema
    // stays the authority (and collapses internal whitespace on the server).
    if (isTitle && value.trim().length === 0) {
      setBlocked('empty'); // stay open, inline error — never persist an empty title
      return;
    }
    // Length is hard-blocked only for the body (raw 10000). Title length is
    // NOT checked here: `TaskTitleSchema` collapses internal whitespace before
    // testing its limit, so `"foo" + 300 spaces + "bar"` is over raw length yet
    // has a valid canonical form. The renderer runs no second normalization, so
    // it can't compute the canonical length — it defers title length to the
    // server (an over-limit title returns as `edit.isError` and stays open).
    if (!isTitle && value.length > TASK_CONTENT_MAX_LEN) {
      setBlocked('over');
      return;
    }
    submittingRef.current = true; // latch before the write settles (see ref decl)
    try {
      // Submit ONLY this field, VERBATIM — title normalization lives in
      // `TaskTitleSchema`; body keeps its whitespace/newlines.
      await edit.mutateAsync(
        isTitle ? { taskId, title: value } : { taskId, body: value },
      );
    } catch {
      submittingRef.current = false; // failed — unlatch so a retry blur/Enter can resubmit
      return; // stay open; `edit.isError` renders the inline error, draft kept
    }
    onDone();
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    // Ignore keystrokes mid IME composition — Enter accepts a CJK candidate and
    // Esc dismisses it; neither should touch the editor (chat-composer parity).
    if (e.nativeEvent.isComposing) return;
    // Enter saves, Shift+Enter inserts a newline — same as the chat composer.
    // (Title is single-line by schema, so a Shift+Enter break there just
    // collapses to a space on save.)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void commit();
      return;
    }
    if (e.key === 'Escape') {
      // Cancel the edit (revert to the read view) WITHOUT closing the Dialog:
      // preventDefault stops Radix's DismissableLayer from also dismissing, and
      // the cancel flag makes the ensuing blur a no-op.
      e.preventDefault();
      cancelledRef.current = true;
      onCancel();
    }
  }

  const errorMsg =
    blocked === 'empty'
      ? 'Title can’t be empty.'
      : blocked === 'over'
        ? `Keep it under ${TASK_CONTENT_MAX_LEN} characters.`
        : edit.isError
          ? 'Couldn’t save changes. Try again.'
          : null;

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        ref={ref}
        aria-label={isTitle ? 'Task title' : 'Task description'}
        rows={1}
        value={value}
        onChange={e => {
          setValue(e.target.value);
          if (blocked) setBlocked(null);
          if (edit.isError) edit.reset();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
        autoFocus
        className={cn(
          'resize-none overflow-hidden',
          isTitle
            ? 'min-h-0 py-1 text-base font-medium leading-snug'
            : 'min-h-[120px] text-sm leading-relaxed',
          errorMsg && 'border-error focus-visible:border-error',
        )}
      />
      {errorMsg ? <p className="text-xs text-error">{errorMsg}</p> : null}
    </div>
  );
}

// ── Compact icon button ────────────────────────────────────────────

/** Small flat icon-only control (18px) for the per-field edit pencils — a
 *  light inline affordance: no fill, just deepens from muted → primary ink on
 *  hover. (The header "View in conversation" jump is NOT one of these — it's the
 *  close ✕'s twin, styled via `dialogCornerButtonClass`.) Always carries a
 *  tooltip + accessible name (`<button>` exposes aria-label). */
function MiniIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
