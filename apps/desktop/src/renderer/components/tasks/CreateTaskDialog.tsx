import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { TASK_CONTENT_MAX_LEN, TASK_TITLE_MAX_LEN } from "@silverhand/shared";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateTaskChannelPicker } from "@/components/tasks/CreateTaskChannelPicker";
import { primaryAction, primaryCancel } from "@/features/common/PrimaryAction";
import { createTaskErrorMessage } from "@/features/tasks/createTaskError";
import { useCreateTask } from "@/features/tasks/hooks";
import type { ChannelOption } from "@/components/tasks/TaskFilterBar";

/**
 * The values the create form yields. The owner turns these into the create
 * request — this component never speaks the wire contract itself, so the
 * human create route/DTO can land independently (invariant #9).
 */
export interface CreateTaskFormValues {
  title: string;
  /** Empty string when the optional description is left blank. */
  body: string;
  /** The conversation the task belongs to — a member channel id in the `pick`
   *  target, or the pair conversation in the `locked` target. */
  conversationId: string;
}

/**
 * WHERE a new task will be created. Two shapes, because the two placements the
 * product has admit different target choices (contract §5):
 *
 *  - `pick` — a workspace-like surface (the global board or a per-conversation Tasks tab):
 *    the actor chooses a member channel from `channelOptions`, pre-focused on
 *    `defaultChannelId` when the surface opened on one. The global "All" board
 *    leaves it unseeded (`defaultChannelId: null`) — it never GUESSES a DM as the
 *    target; a DM task is created only from that direct line's own Tasks tab.
 *  - `locked` — a direct line's own Tasks tab: the target IS the pair
 *    conversation, so there is nothing to pick — no channel picker shows and the
 *    task is created straight onto `conversationId`.
 *
 * The server's create route is the final admission gate for either shape; this
 * union only decides whether the actor is offered a choice.
 */
export type CreateTaskTarget =
  | {
      kind: "pick";
      /** Candidate channels to create in (same member-scoped projection as the
       *  filter bar). This is a picker source, NOT the create-admission gate: the
       *  server is the final authority and can still reject a listed channel with
       *  a typed code. The projection filters `archived_at IS NULL` but NOT
       *  `closed_at`, so a member CLOSED channel stably appears here (an accepted
       *  v1 residue) and is rejected server-side with `conversation_closed`; a
       *  typed `conversation_archived` only covers a race / stale client, since
       *  archived is normally filtered out upstream. */
      channelOptions: ChannelOption[];
      /** Channel pre-selected when opened from a conversation; null on the global
       *  board (the actor picks one). */
      defaultChannelId: string | null;
    }
  | { kind: "locked"; conversationId: string };

export interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the task will be created — see {@link CreateTaskTarget}. */
  target: CreateTaskTarget;
  /** Owner performs the create and any post-success navigation. Resolve to let
   *  the dialog close + reset; reject to keep it open and surface the message. */
  onSubmit: (values: CreateTaskFormValues) => Promise<void>;
}

/**
 * Create a task straight from a task surface (the global board and the
 * per-conversation Tasks tab), naming the channel it belongs to. Deliberately minimal — a required
 * title, a required channel, an optional description — so the form carries no
 * explanatory prose; the required marks and labels do the work (shiki: no
 * conversational helper text stealing the information budget).
 *
 * In a locked (direct line) target there is no channel to choose, so the picker
 * is omitted entirely and the pair conversation is the target — the Tasks tab's own
 * header already names the direct line, so a read-only channel field would only
 * repeat it.
 *
 * The dialog owns only presentation and local form state. The create call and
 * what happens after (open the new task) belong to the owner via `onSubmit`, so
 * this stays independent of the human create contract.
 */
export function CreateTaskDialog({
  open,
  onOpenChange,
  target,
  onSubmit,
}: CreateTaskDialogProps): JSX.Element {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channelId, setChannelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In a locked target the pair conversation IS the destination — the local
  // channelId state and its picker exist only in the `pick` target.
  const locked = target.kind === "locked";
  const defaultChannelId = target.kind === "pick" ? target.defaultChannelId : null;
  // The conversation the create will target: fixed to the pair in a locked
  // context, the actor's channel pick otherwise.
  const conversationId = target.kind === "locked" ? target.conversationId : channelId;

  // Reset ONLY on the closed→open transition — never while the dialog is up.
  // `defaultChannelId` (and the option list behind it) can settle asynchronously
  // after open; keying a full reset on it would wipe a draft the actor is mid-way
  // through typing. So we gate on the actual open edge via a ref, not on the prop.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle("");
      setBody("");
      setChannelId(defaultChannelId ?? "");
      setSubmitting(false);
      setError(null);
    }
    wasOpen.current = open;
  }, [open, defaultChannelId]);

  // Backfill the default channel if it arrives AFTER open and the actor hasn't
  // picked one yet. Only ever fills an empty selection — it never overwrites a
  // channel the actor already chose. Inert in a locked target (no picker,
  // `defaultChannelId` is null).
  useEffect(() => {
    if (open && channelId === "" && defaultChannelId) {
      setChannelId(defaultChannelId);
    }
  }, [open, channelId, defaultChannelId]);

  const canSubmit = title.trim().length > 0 && conversationId !== "";

  const submit = async (): Promise<void> => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ title: title.trim(), body, conversationId });
    } catch (e) {
      // Failure PRESERVES the draft: show the error and stay open, never reset
      // or close. A rejected create is an expected path here — the picker lists
      // member channels, but the target may be closed (server rejects with a
      // typed `conversation_closed`), and the actor must be able to retarget
      // without retyping. Do not "simplify" this to close-on-catch.
      setError(e instanceof Error ? e.message : "The task could not be created.");
      setSubmitting(false);
      return;
    }
    // Success is the ONLY path that closes; the open→false transition lets the
    // reset effect clear the draft for next time.
    setSubmitting(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-task-title" required>
              Title
            </Label>
            <Input
              id="create-task-title"
              autoFocus
              value={title}
              maxLength={TASK_TITLE_MAX_LEN}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {locked ? null : (
            <div className="flex flex-col gap-1.5">
              <Label required>Channel</Label>
              <CreateTaskChannelPicker
                channelOptions={target.channelOptions}
                value={channelId}
                onChange={setChannelId}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-task-body">Description</Label>
            <Textarea
              id="create-task-body"
              // Two more visible rows than the shared 80px floor (~3 lines) —
              // that default felt cramped for a task body (shiki 2026-07-30).
              // Only the initial height changes; the content cap and form
              // behaviour are untouched.
              rows={5}
              value={body}
              maxLength={TASK_CONTENT_MAX_LEN}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {error ? <p className="text-xs text-error">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              {...primaryCancel()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || submitting} {...primaryAction("gap-2")}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bind the create form to the mutation. Returns the `onSubmit` the dialog
 * expects: map the form values to the wire input (an empty description is
 * OMITTED, not sent as ""), then create. On success the dialog closes and
 * `useCreateTask`'s `['tasks']` invalidation refreshes the board in
 * place — the actor stays where they were; the new task is NOT opened in a
 * detail modal (shiki 2026-07-30). A rejection is RE-THROWN as an Error carrying
 * manual copy (`createTaskErrorMessage`, classified on the typed `code`) — the
 * dialog catches it, keeps the draft, and shows the message.
 */
export function useCreateTaskSubmit(): (values: CreateTaskFormValues) => Promise<void> {
  const createTask = useCreateTask();
  return useCallback(
    async (values: CreateTaskFormValues): Promise<void> => {
      const body = values.body.trim();
      try {
        await createTask.mutateAsync({
          title: values.title,
          conversation_id: values.conversationId,
          ...(body ? { body: values.body } : {}),
        });
      } catch (err) {
        throw new Error(createTaskErrorMessage(err));
      }
    },
    [createTask],
  );
}
