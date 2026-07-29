import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckSquare, ExternalLink, Loader2, Pencil } from 'lucide-react';
import { TASK_CONTENT_MAX_LEN, type TaskDetailDto } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogCornerButtonClass,
  DialogCornerButton,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { MiniIconButton } from '@/components/tasks/MiniIconButton';
import { TaskDetailMetaPanel } from '@/components/tasks/TaskDetailMetaPanel';
import { Markdown } from '@/components/chat/Markdown';
import {
  useAssignTask,
  useEditTask,
  useTaskDetail,
  useUpdateTaskStatus,
} from '@/features/tasks/hooks';
import {
  classifyTaskDetailFailure,
  resolveTaskDetailView,
  resolveTaskJumpTarget,
  type TaskDetailFailure,
  type TaskDetailView,
  type TaskJumpTarget,
} from '@/features/tasks/taskDetail';
import { cn } from '@/lib/cn';

export type { TaskJumpTarget } from '@/features/tasks/taskDetail';

/** Which field is currently in inline-edit mode; `null` is the read view. Only
 *  one field edits at a time — the other field's pencil is hidden until the
 *  current edit finishes, so there is never a mid-edit switch. */
type EditingField = 'title' | 'content' | null;

export interface TaskDetailDialogProps {
  /** Task identity to show, or null when the modal is closed. An ID, not a
   *  summary DTO: every entrance (chat chip, board card, cold `?task=<id>`
   *  deep-link) can supply one, so the modal has a SINGLE data source
   *  (#task:1715) instead of painting from a possibly-stale card while the
   *  authoritative read is in flight. */
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
  /** "View in conversation". The surface wires this to its own jump handler; the
   *  dialog does NOT close itself — whoever navigates owns the pointer's fate
   *  (App closes it only when no navigation happened). */
  onJump: (target: TaskJumpTarget) => void;
  /** "View in Tasks" — reveal this task's card on whichever task board is on
   *  screen. Takes the task id ONLY: both boards are cross-workspace
   *  (`useTasks({})`), so a task id resolves against all of them and the reveal
   *  needs no workspace of its own. Omitted → the affordance is absent. Same
   *  ownership rule as `onJump`: the dialog does not close itself. */
  onReveal?: (taskId: string) => void;
}

/**
 * Task detail modal — the ONE surface for reading a single task, opened by
 * `?task=<task_id>` in the URL (#task:1715): a task card on either board
 * surface, an inline `#task:<n>` chip in chat, or a cold deep-link all write
 * that one pointer, so there is a single modal instance at app level with a
 * single state. Reads the full body + edit-provenance byline on demand.
 *
 * Because a chip click no longer opens the tasks board first, the modal may be
 * the only task surface on screen — hence "View in Tasks" beside "View in
 * conversation": two destinations, one verb, so the corner cluster reads as one
 * family. Neither closes the modal from here: the surface that navigates decides
 * what happens to the `?task` pointer, so there is exactly ONE owner per action
 * (Cindy BLOCKER 3) instead of a close racing a route change.
 *
 * WHAT IS RENDERED is one exhaustive decision, `resolveTaskDetailView` — failure
 * tier and "is there a body to paint" are independent axes and both are real
 * (a background refresh can fail while the previous body is still cached). The
 * `switch` below is total over that union, so no branch order can swallow a tier.
 *
 * A read that doesn't resolve gets a COMPACT single-column shell, not the wide
 * two-column one: the wide shape exists to seat a description beside a metadata
 * column, and neither exists yet. The URL pointer is never stripped on failure —
 * the user clicked that reference, so it stays addressable until they close it
 * (same principle as `SideUnresolvedPlaceholder`; the corner ✕ is the explicit
 * close, so the panel adds no second Close button).
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
  taskId,
  onOpenChange,
  onJump,
  onReveal,
}: TaskDetailDialogProps): JSX.Element {
  const open = taskId !== null;
  const detailQuery = useTaskDetail(taskId, { enabled: open });
  const failure = detailQuery.isError
    ? classifyTaskDetailFailure(detailQuery.error)
    : null;
  const view = resolveTaskDetailView({ failure, detail: detailQuery.data });
  // The body this view paints, if any. `not_found` deliberately paints none even
  // when a stale one is still cached — the server has just disowned it.
  const painted =
    view.kind === 'body' || view.kind === 'body_with_retry' || view.kind === 'body_stale'
      ? view.detail
      : null;

  const [editingField, setEditingField] = useState<EditingField>(null);
  // Snap back to read mode whenever the modal opens onto a different task
  // (or closes) so a stale inline draft never bleeds across tasks. Note this
  // keys on the ID, NOT the live detail — a task_changed refetch of the SAME
  // task must not reset an open editor and wipe the unsubmitted draft.
  useEffect(() => {
    setEditingField(null);
  }, [taskId]);

  // Corner actions only exist once there is a body to act on: before that there
  // is no `nav` discriminant to branch on, and a disabled placeholder button
  // would promise a destination we can't name yet. Both are also hidden while a
  // field is being edited — a click would blur-save and then navigate away,
  // unmounting the editor and losing the draft if the write failed.
  const jumpTarget = painted ? resolveTaskJumpTarget(painted) : null;
  const actionsVisible = open && painted !== null && editingField === null;
  const resolved = painted !== null;

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
        // Explicit px instead of a Tailwind step because this sits between
        // `max-w-2xl` and `max-w-3xl`.
        //
        // 900, not 800 (shiki 2026-07-29 "正文的地方也变小了"): the 240px
        // metadata column is a real tax on the reading column — at 800 the main
        // column was 520px, so the description had ~494px, down from ~734px
        // pre-sidebar. Every px added here goes to the prose (the sidebar is
        // fixed), and 900 keeps the modal at ~70% of the default 1280 window.
        // Restoring the FULL pre-sidebar width is deliberately not the goal:
        // 734px is ~103ch at the default prose size, well past readable.
        //
        // HEIGHT is a band, not one cap (shiki 2026-07-29). Floor 300px: the
        // sidebar's rows used to be the only floor, so a short task's modal
        // height moved with how many optional rows (Edited / Closed) happened to
        // exist — the same task read as two different shapes. Ceiling 70vh
        // instead of 80vh: 80 on a tall window produced a column of mostly empty
        // space under a short description. One value is fixed and the other
        // viewport-relative on purpose — the floor is a shape guarantee, the
        // ceiling is "leave the window visible around me". They only cross below
        // a ~430px-tall window, where the app has no usable layout anyway.
        //
        // Not-yet-resolved states drop BOTH: no prose, no metadata column, so
        // the wide band would frame a sentence in a mostly-empty 900×300 box.
        className={
          resolved
            ? 'flex max-h-[70vh] min-h-[300px] max-w-[900px] flex-col gap-0 p-0'
            : 'flex max-w-[420px] flex-col gap-0 p-0'
        }
        // This dialog owns its padding (`p-0` + a bordered header at `px-5
        // py-4`), so the cluster keeps hugging the corner: its band is the
        // metadata row, not a `p-6` title line.
        cornerBand="top"
        cornerActions={
          actionsVisible ? (
            // Ordered by DISTANCE from where the reader already is (shiki
            // 2026-07-29): the task's own board first — still inside the task
            // context this modal belongs to — then the conversation it came from,
            // which leaves that context, then ✕. So one scan left→right steps
            // steadily further away instead of alternating.
            <>
              {onReveal && taskId ? (
                // `DialogCornerButton`, not a hand-rolled peer: the primitive
                // stamps the corner-cluster theme marker, so this button can't
                // ship as a flat ghost beside the sticker ✕ in forza6.
                <DialogCornerButton
                  data-task-view-board
                  title="View in Tasks"
                  aria-label="View in Tasks"
                  onClick={() => onReveal(taskId)}
                >
                  <CheckSquare className="size-4" aria-hidden />
                </DialogCornerButton>
              ) : null}
              {jumpTarget ? (
                <button
                  type="button"
                  data-task-view-jump
                  title="View in conversation"
                  aria-label="View in conversation"
                  onClick={() => onJump(jumpTarget)}
                  className={dialogCornerButtonClass}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </button>
              ) : null}
            </>
          ) : null
        }
      >
        <TaskDetailContent
          view={view}
          editingField={editingField}
          onEditField={setEditingField}
          onStopEditing={() => setEditingField(null)}
          onRetry={() => void detailQuery.refetch()}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Total `switch` over the resolved view — the only place that decides what the
 * modal shows. Adding a state to `TaskDetailView` breaks this exhaustively
 * instead of falling into whichever branch happens to come first.
 */
function TaskDetailContent({
  view,
  editingField,
  onEditField,
  onStopEditing,
  onRetry,
}: {
  view: TaskDetailView;
  editingField: EditingField;
  onEditField: (field: Exclude<EditingField, null>) => void;
  onStopEditing: () => void;
  onRetry: () => void;
}): JSX.Element | null {
  switch (view.kind) {
    case 'loading':
      return <TaskDetailStatePanel failure={null} />;
    case 'not_found':
      return <TaskDetailStatePanel failure="not_found" />;
    case 'unreachable_empty':
      return <TaskDetailStatePanel failure="unreachable" />;
    case 'transient_empty':
      return <TaskDetailStatePanel failure="transient" onRetry={onRetry} />;
    case 'body':
    // `body_stale` is the SAME body: the connection is down, so the last read
    // is the best available truth and the one app-status banner already says
    // the connection is down. A second copy of that notice here would be a
    // second surface claiming one fact (Alice, #task:1462).
    case 'body_stale':
      return (
        <TaskDetailBody
          detail={view.detail}
          editingField={editingField}
          onEditField={onEditField}
          onStopEditing={onStopEditing}
        />
      );
    case 'body_with_retry':
      return (
        <>
          {/* The refresh failed over a body we still hold. Nothing re-reads it
              on its own (`retry: 1`, no focus refetch), so the Retry has to be
              reachable here — but it stays a single muted line: the body below
              is still readable, this is a footnote about its freshness. */}
          <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-2 text-xs text-text-muted">
            <span>Showing the last loaded version — the refresh failed.</span>
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto shrink-0 rounded px-1 py-0.5 font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Retry
            </button>
          </div>
          <TaskDetailBody
            detail={view.detail}
            editingField={editingField}
            onEditField={onEditField}
            onStopEditing={onStopEditing}
          />
        </>
      );
  }
}

// ── Unresolved states (loading + the three failure tiers) ──────────

const FAILURE_COPY: Record<TaskDetailFailure, { header: string; body: string }> = {
  not_found: {
    header: 'Task not found',
    // Both causes answer 404 and the viewer can't tell them apart, so the copy
    // names both rather than asserting the one we can't verify.
    body: 'This task was deleted, or it belongs to a conversation you can’t read.',
  },
  unreachable: {
    header: 'Can’t reach the server',
    // No Retry here: the app-status banner already owns this signal and its
    // retry. A second, narrower retry button would be a competing control for
    // the same recovery.
    body: 'The task can’t be loaded while the connection is down.',
  },
  transient: {
    header: 'Couldn’t load this task',
    body: 'The request failed.',
  },
};

function TaskDetailStatePanel({
  failure,
  onRetry,
}: {
  /** null → still loading. */
  failure: TaskDetailFailure | null;
  /** Only the transient tier gets one; the others have no local recovery. */
  onRetry?: () => void;
}): JSX.Element {
  if (failure === null) {
    return (
      <div className="px-5 py-6">
        <DialogTitle className="sr-only">Task detail</DialogTitle>
        <DialogDescription className="sr-only">Loading task</DialogDescription>
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </div>
      </div>
    );
  }
  const copy = FAILURE_COPY[failure];
  return (
    <div className="flex flex-col gap-1.5 px-5 py-6 pr-12">
      <DialogTitle className="text-sm font-semibold leading-snug text-text-primary">
        {copy.header}
      </DialogTitle>
      <DialogDescription className="text-sm text-text-muted">
        {copy.body}
      </DialogDescription>
      {/* Retry ONLY for the transient tier: the query client is `retry: 1` with
          no focus refetch, so nothing else re-reads this — without a button the
          pointer is stuck. `not_found` is terminal and `unreachable` recovers
          through the app-status banner. */}
      {failure === 'transient' && onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 self-start"
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// ── Body ───────────────────────────────────────────────────────────

function TaskDetailBody({
  detail,
  editingField,
  onEditField,
  onStopEditing,
}: {
  /** The AUTHORITATIVE read. The body only mounts once it resolves, so there is
   *  no "paint the card's summary while the real values arrive" window — that
   *  window used to need a per-field merge, and a per-field `??` silently
   *  resurrects a stale value the moment the authoritative one becomes null. */
  detail: TaskDetailDto;
  editingField: EditingField;
  onEditField: (field: Exclude<EditingField, null>) => void;
  onStopEditing: () => void;
}): JSX.Element {

  // The metadata sidebar's two writes live HERE, with the title/content editor,
  // because the three of them share ONE dialog-local write slot: while any of
  // them is open or in flight the others go inert. Without that, clicking Status
  // during a title edit fires the blur-save AND a status write in the same
  // interaction, and `useEditTask`'s whole-object cache write can land last and
  // clobber the newer status (Cindy review, shiki 2026-07-29 "ui 上可以加状态来阻
  // 塞用户"). Local slot only — no lock, no revision, no multi-writer protocol.
  const updateStatus = useUpdateTaskStatus();
  const assign = useAssignTask();
  const metaPending = updateStatus.isPending || assign.isPending;
  const busy = editingField !== null || metaPending;

  return (
    <>
      <DialogHeader className="border-b border-border-subtle px-5 py-4">
        {/* Header is the TITLE line only — number, status and the edit byline
            moved into the metadata sidebar, where they sit beside the rest of
            the task's facts instead of stacking chrome above the title.
            `pr-28` reserves the corner cluster, which shares this top band:
            three 28px sticker boxes (forza6 adds a 2px border to the 24px
            `p-1`+`size-4` box) with `gap-1.5` and `right-3` reach 108px from
            the dialog's right edge, and the header's own `px-5` only accounts
            for 20 of those — so anything under 88px lets the title's edit
            pencil slide under the buttons (shiki 2026-07-29 "编辑 icon 和右侧
            三个 action button 有一些重叠"). 112px keeps a margin as the cluster
            grows. */}
        <div className="pr-28">
          {editingField === 'title' ? (
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
                {detail.title}
              </DialogTitle>
              {!busy ? (
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

      {/* Two columns, each scrolling on its own: a long description scrolls
          without dragging the metadata out of view, while the metadata stays
          put. Load / failure states never reach here — they get their own
          compact shell, so this column is always real content. */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {editingField === 'content' ? (
            <InlineFieldEditor
              taskId={detail.id}
              field="content"
              initial={detail.content}
              onDone={onStopEditing}
              onCancel={onStopEditing}
            />
          ) : (
            <div className="flex items-start gap-2">
              {/* Reading measure, in `ch` so it tracks the user's own prose size
                  (`--appearance-markdown-font-size`) instead of a fixed px.
                  76ch ≈ the widened column minus the pencil, so the extra width
                  from 800→900 lands in the text rather than as trailing slack —
                  while still stopping short of the ~103ch the single-column
                  modal used to run at. */}
              <div className="min-w-0 max-w-[76ch] flex-1">
                {detail.content.trim() ? (
                  <Markdown content={detail.content} />
                ) : (
                  <p className="text-sm italic text-text-muted">No description.</p>
                )}
              </div>
              {!busy ? (
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

        <TaskDetailMetaPanel
          view={detail}
          busy={busy}
          statusPending={updateStatus.isPending}
          statusFailed={updateStatus.isError}
          onStatusChange={status => {
            updateStatus.reset();
            updateStatus.mutate({ taskId: detail.id, status });
          }}
          assignPending={assign.isPending}
          assignFailed={assign.isError}
          onAssign={agentId => {
            assign.reset();
            assign.mutate({ taskId: detail.id, agentId });
          }}
        />
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
