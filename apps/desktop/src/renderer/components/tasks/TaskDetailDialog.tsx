import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Loader2, Pencil } from 'lucide-react';
import {
  TASK_CONTENT_MAX_LEN,
  TASK_TITLE_MAX_LEN,
  type TaskDetailDto,
  type TaskSummaryDto,
} from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge';
import { useRelativeTime } from '@/components/chat/useRelativeTime';
import { useEditTask, useTaskDetail } from '@/features/tasks/hooks';
import {
  buildTaskEditPayload,
  resolveTaskJumpTarget,
  type TaskJumpTarget,
} from '@/features/tasks/taskDetail';
import { cn } from '@/lib/cn';

export type { TaskJumpTarget } from '@/features/tasks/taskDetail';

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
 * byline on demand, edits title/content as a plain last-write-wins update (no
 * conflict prompt, no merge — the last successful Save wins), and offers ONE
 * "View in conversation" jump that consumes the viewer-resolved `nav`
 * discriminant (source → source message, else → task-created event; hidden
 * entirely when nav is `unavailable`).
 */
export function TaskDetailDialog({
  task,
  onOpenChange,
  onJump,
}: TaskDetailDialogProps): JSX.Element {
  const open = task !== null;
  const detailQuery = useTaskDetail(task?.id, { enabled: open });
  const detail = detailQuery.data;

  const [editing, setEditing] = useState(false);
  // Snap back to read mode whenever the modal opens onto a different task
  // (or closes) so a stale edit form never bleeds across tasks.
  useEffect(() => {
    setEditing(false);
  }, [task?.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-0 p-0">
        {task ? (
          editing && detail ? (
            // The form's lifecycle is bound to the TASK (mounted while
            // `editing`, reset on `task.id` change), never to the live detail —
            // a task_changed refetch must not remount it and wipe the viewer's
            // unsubmitted draft mid-edit.
            <TaskEditForm
              detail={detail}
              onDone={() => setEditing(false)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <TaskDetailView
              task={task}
              detail={detail}
              loading={detailQuery.isLoading}
              failed={detailQuery.isError}
              canEdit={Boolean(detail)}
              onEdit={() => setEditing(true)}
              onJump={target => {
                onJump(target);
                onOpenChange(false);
              }}
            />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── Read view ──────────────────────────────────────────────────────

function TaskDetailView({
  task,
  detail,
  loading,
  failed,
  canEdit,
  onEdit,
  onJump,
}: {
  task: TaskSummaryDto;
  detail: TaskDetailDto | undefined;
  loading: boolean;
  failed: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onJump: (target: TaskJumpTarget) => void;
}): JSX.Element {
  const title = detail?.title ?? task.title;
  const status = detail?.status ?? task.status;

  // Byline reflects the last DEFINITION edit only (status/claim don't move
  // it). Hook is called unconditionally; the label renders only when the
  // task has actually been edited.
  const { relative } = useRelativeTime(detail?.last_edited_at ?? task.created_at);
  const editor = detail?.last_editor ?? null;
  const editedAt = detail?.last_edited_at ?? null;

  // Navigate via the viewer-resolved `nav` discriminant on the detail:
  // source → source message, no-source → task-created event. Null when
  // nav is `unavailable` OR the detail hasn't resolved yet — the button
  // is hidden for the former, disabled for the latter, so network timing
  // never changes the target.
  const jumpTarget = detail ? resolveTaskJumpTarget(detail) : null;

  return (
    <>
      <DialogHeader className="gap-2 border-b border-border-subtle px-5 py-4 pr-12">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-text-muted">
            #{task.task_number}
          </span>
          <TaskStatusBadge status={status} />
        </div>
        <DialogTitle className="text-base leading-snug [overflow-wrap:anywhere]">
          {title}
        </DialogTitle>
        <DialogDescription className="sr-only">Task detail</DialogDescription>
        {editor && editedAt ? (
          <p className="text-[11px] text-text-muted">
            Edited by {editor.name} · {relative}
          </p>
        ) : null}
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading…
          </div>
        ) : failed ? (
          <p className="text-sm text-error">Couldn’t load this task.</p>
        ) : detail && detail.content.trim() ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">
            {detail.content}
          </p>
        ) : (
          <p className="text-sm italic text-text-muted">No description.</p>
        )}
      </div>

      <DialogFooter className="border-t border-border-subtle px-5 py-3 sm:justify-between">
        {detail && !jumpTarget ? (
          // nav.kind === 'unavailable' — the destination is gone (source
          // unreadable, or no created-event resolvable). Hide the jump
          // rather than offer a dead control (Cindy gate). Empty spacer
          // keeps Edit anchored right via `justify-between`.
          <span />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!jumpTarget}
            onClick={() => {
              if (jumpTarget) onJump(jumpTarget);
            }}
          >
            <ExternalLink className="mr-1.5 size-3.5" aria-hidden />
            View in conversation
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canEdit}
          onClick={onEdit}
        >
          <Pencil className="mr-1.5 size-3.5" aria-hidden />
          Edit
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Edit form ──────────────────────────────────────────────────────

function TaskEditForm({
  detail,
  onDone,
  onCancel,
}: {
  detail: TaskDetailDto;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const edit = useEditTask();

  const [title, setTitle] = useState(detail.title);
  const [body, setBody] = useState(detail.content);
  // The authoritative definition the edit is diffed against, so a body-only
  // edit doesn't echo a legacy null-title fallback back as an explicit title.
  const [base] = useState({
    title: detail.title,
    content: detail.content,
  });

  const titleChanged = title !== base.title;
  const bodyChanged = body !== base.content;
  const dirty = titleChanged || bodyChanged;
  const titleEmpty = title.trim().length === 0;
  const titleOver = title.length > TASK_TITLE_MAX_LEN;
  const bodyOver = body.length > TASK_CONTENT_MAX_LEN;
  const canSave = dirty && !titleEmpty && !titleOver && !bodyOver && !edit.isPending;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSave) return;
    const payload = buildTaskEditPayload(
      { title: base.title, content: base.content },
      { title, body },
    );
    try {
      await edit.mutateAsync({
        taskId: detail.id,
        // Only-changed fields — omitting title keeps a legacy null-title
        // task's server-materialized fallback intact.
        ...payload,
      });
    } catch {
      // Typed failure (not-a-task / authz / network) — surfaced to the user via
      // `edit.isError` below. Swallow the rejection here so a
      // `void handleSubmit(...)` form handler doesn't leak an unhandled one.
      return;
    }
    // Plain last-write-wins: a successful UPDATE is the whole story — no conflict
    // prompt, no merge. The most recent successful write wins.
    onDone();
  }

  return (
    <form className="flex min-h-0 flex-col gap-0" onSubmit={e => void handleSubmit(e)}>
      <DialogHeader className="gap-1 border-b border-border-subtle px-5 py-4 pr-12">
        <DialogTitle className="text-base">Edit task</DialogTitle>
        <DialogDescription className="sr-only">
          Edit the task title and description
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="task-edit-title" required>
              Title
            </Label>
            <span
              className={cn(
                'text-[10px] tabular-nums text-text-muted',
                titleOver && 'text-error',
              )}
            >
              {title.length}/{TASK_TITLE_MAX_LEN}
            </span>
          </div>
          <Input
            id="task-edit-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="task-edit-body">Description</Label>
            <span
              className={cn(
                'text-[10px] tabular-nums text-text-muted',
                bodyOver && 'text-error',
              )}
            >
              {body.length}/{TASK_CONTENT_MAX_LEN}
            </span>
          </div>
          <Textarea
            id="task-edit-body"
            value={body}
            onChange={e => setBody(e.target.value)}
            className="min-h-[160px] flex-1 resize-none"
          />
        </div>

        {edit.isError ? (
          <p className="text-xs text-error">
            Couldn’t save changes. Try again.
          </p>
        ) : null}
      </div>

      <DialogFooter className="border-t border-border-subtle px-5 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="default" size="sm" disabled={!canSave}>
          {edit.isPending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            'Save'
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
