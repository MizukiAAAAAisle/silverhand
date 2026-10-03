import type { AgentDto, TaskAssigneeDto } from "@silverhand/shared";
import { formatUserDisplayName, type UserNameResolver } from "@/features/session/current-user";
import type { CachedMessage } from "@/features/channels/pending-message";
import {
  StatusPicker,
  taskStatusLabel,
  TASK_STATUS_ICON,
} from "@/features/tasks/components/task-status-badge";
import { useUpdateTaskStatus } from "@/features/tasks/hooks/hooks";

/**
 * Task tag for a message linked to a task.
 *
 * Lives at the message's BOTTOM edge — its own row ahead of reactions and
 * the thread-reply badge (shiki #task:1185), aligned to the message's
 * reading edge.
 *
 * It is ONE cohesive tag (shiki review: the split lead + chip read as
 * scattered). The whole tag is a single button: `<status-icon> #<num> ·
 * <assignee>`, status-coloured via the shared `[data-task-status]` token
 * contract (so it states its status at a glance and matches every other
 * status chip per theme — incl. poster's poster caps / 0-radius). The status
 * is carried by the leading glyph (from the shared `TASK_STATUS_ICON` source,
 * so it tracks the kanban board) + the fill colour — no redundant status
 * text. For a member of an open channel (`canMutate`), clicking anywhere on the
 * tag opens the "Move to" picker, which drives `useUpdateTaskStatus`
 * (`POST /api/tasks/:id/status`) — the same any→any path the inline `#task:N`
 * reference uses. For a non-member (public channel = read-only) or any
 * read-only surface, the chip renders identically — same glyph, colour, number,
 * assignee — but as an inert `<span>`: the status is public to read, only the
 * mutation entry is member-gated. The task title lives in the tooltip.
 *
 * Renders nothing when the message has no linked task.
 */
export function MessageTaskTag({
  message,
  agentsById,
  userResolver,
  canMutate,
}: {
  message: CachedMessage;
  agentsById: Map<string, AgentDto>;
  userResolver?: UserNameResolver;
  canMutate: boolean;
}): JSX.Element | null {
  const updateStatus = useUpdateTaskStatus();
  const linkedTask = message.linked_task;
  if (linkedTask === null) return null;

  const status = linkedTask.status;
  const label = taskStatusLabel(status);
  const StatusIcon = TASK_STATUS_ICON[status];
  const assignee = linkedTask.assignee
    ? formatTaskAssignee(linkedTask.assignee, agentsById, userResolver)
    : null;
  const title = [`Task #${linkedTask.task_number}`, label, assignee, linkedTask.title]
    .filter(Boolean)
    .join(" ");

  // Shared chip body — identical glyph / number / assignee across both the
  // interactive and read-only forms, so a non-member reads the exact same
  // task state a member does.
  const body = (
    <>
      {/* Status glyph from the shared TASK_STATUS_ICON source (kanban /
          per-conversation Tasks tab use the same), so a future icon swap updates everywhere. */}
      <StatusIcon className="size-3 shrink-0" aria-hidden />
      {/* No `font-mono` on the number — it inherits the chip's typeface, so
          it matches the `· assignee` next to it (and poster's
          `[data-task-status]` display face applies to the whole chip rather
          than to the label alone). Space Mono digits read poorly in poster
          (@shiki `sLh6CqwNw0uAtThk`, #task:1757). */}
      <span className="shrink-0">#{linkedTask.task_number}</span>
      {assignee ? <span className="min-w-0 truncate font-normal">{assignee}</span> : null}
    </>
  );

  // Read-only chip (non-member / read-only surface): same look + content, no
  // picker, no mutation, no interactive affordances. The click falls through
  // to the row's normal selection/jump behaviour.
  if (!canMutate) {
    return (
      <span
        data-message-task-tag
        // Same `[data-task-status]` token contract as the interactive form —
        // fill / border / radius stay in lockstep with the board chips.
        data-task-status={status}
        title={title}
        className="inline-flex h-4.5 max-w-55 cursor-default items-center gap-1.5 whitespace-nowrap rounded-(--task-status-radius) px-2 text-(length:--text-meta) font-medium leading-none"
      >
        {/* The status glyph is aria-hidden and the fill colour is visual-only,
            and a generic span's aria-label is not reliably exposed — so carry
            the status name as real screen-reader text. The #number + assignee
            are already read from the body's visible text nodes. */}
        <span className="sr-only">{label}</span>
        {body}
      </span>
    );
  }

  return (
    <StatusPicker
      current={status}
      onChange={(next) => updateStatus.mutate({ taskId: linkedTask.task_id, status: next })}
    >
      <button
        type="button"
        data-message-task-tag
        // Status colour / border / radius all flow from the shared
        // `[data-task-status]` token contract (chrome.css + per-theme),
        // so this tag stays in lockstep with the board chips. No bg /
        // border / colour utilities here — they would fight the tokens.
        data-task-status={status}
        title={title}
        aria-label={`Task #${linkedTask.task_number} (${label}) — click to change status`}
        // Stop the click from reaching the row's selection/jump capture.
        onClick={(e) => e.stopPropagation()}
        className="inline-flex h-4.5 max-w-55 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-(--task-status-radius) px-2 text-(length:--text-meta) font-medium leading-none transition-opacity hover:opacity-80 focus-outline"
      >
        {body}
      </button>
    </StatusPicker>
  );
}

export function formatTaskAssignee(
  assignee: TaskAssigneeDto,
  agentsById: Map<string, AgentDto>,
  userResolver?: UserNameResolver,
): string {
  if (assignee.type === "user") {
    return formatUserDisplayName(assignee.id, userResolver);
  }
  const agent = agentsById.get(assignee.id);
  const name = (
    agent?.display_name?.trim() ||
    agent?.name ||
    assignee.name.trim() ||
    assignee.id
  ).replace(/^@/, "");
  // In-message task cards are a recognition surface: plain names for both
  // kinds, no leading `@` (the user branch above is already bare). Every task
  // assignee/creator DISPLAY reads the same way now — board cards, the
  // per-conversation Tasks tab,
  // TasksSection, the filter, and the TaskRef popover all show the plain
  // display name (the dto's `name` is the denormalized display_name, never a
  // handle). `@` is reserved for surfaces that show a real handle: mentions,
  // the composer, and the assignee picker — split by surface, not by actor
  // kind (shiki 2026-08-01, #task:1768).
  return name;
}
