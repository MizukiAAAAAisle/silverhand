import {
  type TaskStatus,
  type TaskSubtype,
  type TaskSystemMetadata,
  type TaskSystemMetadataPartial,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
} from "@silverhand/shared";
import { formatUserDisplayName } from "@/features/session/current-user";
import { TaskRef } from "@/features/messages/components/task-ref";
import { type RendererProps, useUserResolver } from "./shared";

// ─── task event row ───────────────────────────────────────────────────
export function TaskEventRow({ message }: RendererProps): JSX.Element {
  const meta = readTaskSystemMetadata(message.metadata);
  if (meta) return <TaskEventRowEnriched meta={meta} />;
  // Mid-tier degradation for legacy rows that carry the minimal
  // `(subtype, task_number, task_status)` triple but no actor /
  // title / message_id enrichment. Render chip + dot + pill (or
  // chip + verb) so the audit entry still self-identifies. We do
  // NOT promote `message.content` here — it was the old narration
  // string, not structured data.
  const partial = readTaskSystemMetadataPartial(message.metadata);
  if (partial) return <TaskEventRowDegraded meta={partial} />;
  // Total degradation — metadata is missing even subtype/task_number
  // (shouldn't happen for current producers, but bare belt+suspenders
  // for unknown malformed rows).
  return <TaskEventLegacyFallback content={message.content} />;
}

function TaskEventRowEnriched({ meta }: { meta: TaskSystemMetadata }): JSX.Element {
  const userResolver = useUserResolver();

  const actorLabel =
    meta.actor.kind === "user"
      ? formatUserDisplayName(meta.actor.id, userResolver) || meta.actor.name || "user"
      : meta.actor.name;

  const dotKind: TaskEventDotKind = meta.subtype === "task_unclaim" ? "unclaim" : meta.task_status;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-1.5 text-text-secondary">
      <TaskEventDot kind={dotKind} />
      <TaskEventBody subtype={meta.subtype} actorLabel={actorLabel} meta={meta} />
    </div>
  );
}

function TaskEventBody({
  subtype,
  actorLabel,
  meta,
}: {
  subtype: TaskSubtype;
  actorLabel: string;
  meta: TaskSystemMetadata;
}): JSX.Element {
  if (subtype === "task_status") {
    return (
      <>
        <span className="font-medium text-text-primary">{actorLabel}</span>
        <span className="text-text-muted">moved</span>
        <TaskRef taskNumber={meta.task_number} />
        <span className="text-text-muted" aria-hidden>
          →
        </span>
        <TaskStatusPill status={meta.task_status} />
      </>
    );
  }
  // `task_claim` / `task_unclaim` mean two different things depending on WHO
  // acted (`docs/tasks-design.md` §4.4, wire contract in
  // `TaskSystemMetadataSchema`): an AGENT is taking or releasing the job
  // (claimed / unclaimed — a workflow verb), while a HUMAN is assigning or
  // unassigning from the board. Saying "shiki claimed #task" for an assignment
  // to someone else states the wrong fact.
  // The two human arms are NOT symmetric: an assign DISPATCHES the work — a
  // `todo` task is started in the same write, so `task_status` can arrive here as
  // `in_progress` (shiki 2026-08-06, §4.4) — while an unassign writes ownership
  // only. Neither the verb nor the dot has to branch on that: the verb names the
  // ACTION and the dot renders the after-state `task_status` the server settled
  // on, so this surface never predicts a status.
  // A human assign also names the new owner, since that is the rest of the
  // write's content.
  const humanAssignmentWrite =
    meta.actor.kind === "user" && (subtype === "task_claim" || subtype === "task_unclaim");
  if (humanAssignmentWrite) {
    const assignee = meta.task_assignee;
    return (
      <>
        <span className="font-medium text-text-primary">{actorLabel}</span>
        <span className="text-text-muted">
          {subtype === "task_claim" ? "assigned" : "unassigned"}
        </span>
        <TaskRef taskNumber={meta.task_number} />
        {subtype === "task_claim" && assignee ? (
          <>
            <span className="text-text-muted" aria-hidden>
              →
            </span>
            <span className="font-medium text-text-primary">{assignee.name}</span>
          </>
        ) : null}
      </>
    );
  }
  // `cross_conversation` (`TaskSystemMetadataSchema`, create-only) says an agent
  // filed this task from a DIFFERENT conversation than the one it landed in.
  // Without it the row reads "@Norman created #task:N" to members who watched
  // nothing happen here — including that agent, which cannot tell its own
  // sessions apart (claim/creator granularity is the AGENT, not the session), so
  // no identity field can fix "I have no memory of creating this"; the missing
  // fact is that it came from elsewhere. HARD PRIVACY INVARIANT — the bit
  // carries no origin id/title/ref, so this row says THAT it was filed remotely
  // and never WHERE from: do not add the origin conversation's name, link, or
  // icon. A destination (and an origin) can be ANY conversation — a DM
  // qualifies, the create route has no kind gate — so nothing on this surface
  // may be phrased as "channel" either. Absent
  // (legacy rows + same-conversation creates) reads `created`, so the immutable
  // metadata snapshot degrades by itself, no migration. The agent-facing
  // narration derives its own wording from this same bit — neither face reads
  // the other's product.
  const filedRemotely = subtype === "task_create" && meta.cross_conversation === true;
  const verb =
    subtype === "task_create"
      ? filedRemotely
        ? "filed"
        : "created"
      : subtype === "task_claim"
        ? "claimed"
        : subtype === "task_edit"
          ? "edited"
          : "unclaimed";
  return (
    <>
      <span className="font-medium text-text-primary">{actorLabel}</span>
      <span className="text-text-muted">{verb}</span>
      <TaskRef taskNumber={meta.task_number} />
      {filedRemotely ? <span className="text-text-muted">from another conversation</span> : null}
    </>
  );
}

type TaskEventDotKind = TaskStatus | "unclaim";

function TaskEventDot({ kind }: { kind: TaskEventDotKind }): JSX.Element {
  // Status dots consume the board's per-status SOLID signal colour
  // (`--task-status-*-solid`, #task:1018) so the chat-stream dot matches
  // the task board chip in every theme. Each theme homes `-solid` on its
  // own identity source (poster → poster `-bg`; warm/slack → saturated
  // `-text`), so this single token reads correctly everywhere. `unclaim`
  // is not a status — it keeps a neutral dashed-hollow marker.
  const cls: Record<TaskEventDotKind, string> = {
    todo: "bg-[var(--task-status-todo-solid)]",
    in_progress: "bg-[var(--task-status-in-progress-solid)]",
    in_review: "bg-[var(--task-status-in-review-solid)]",
    done: "bg-[var(--task-status-done-solid)]",
    closed: "bg-[var(--task-status-closed-solid)]",
    unclaim: "border border-dashed border-text-muted/60 bg-transparent",
  };
  return (
    <span
      aria-hidden
      className={`size-2 shrink-0 rounded-full ${cls[kind]}`}
      data-task-event-dot={kind}
    />
  );
}

/**
 * Status pill for task event rows. Stays local to the system event
 * surface — `TaskRef` already brings the chip + hover popover; the
 * pill encodes the after-mutation status snapshot for `task_status`
 * subtype rows.
 *
 * Height is driven by the `.system-message-row` scoped CSS rule
 * (`--system-message-control-height: max(18px, calc(var(--md-prose-size,
 * 12px) * 1.5))` in `chrome.css`), which is also applied to the sibling
 * `TaskRef` chip via `[data-task-ref]`. Both grow together at larger
 * theme prose sizes so the chip + pill stay pixel-aligned and never
 * crop their text. `leading-none` keeps the inline content centered
 * inside that height regardless of the row's `line-height: 1.5`.
 */
function TaskStatusPill({ status }: { status: TaskStatus }): JSX.Element {
  const labels: Record<TaskStatus, string> = {
    todo: "todo",
    in_progress: "in progress",
    in_review: "in review",
    done: "done",
    closed: "closed",
  };
  return (
    <span
      data-task-event-status={status}
      data-task-status={status}
      className="inline-flex items-center whitespace-nowrap rounded-(--task-status-radius) px-1.5 text-(length:--text-badge) font-semibold uppercase leading-none tracking-wider"
    >
      {labels[status]}
    </span>
  );
}

function TaskEventLegacyFallback({ content }: { content: string }): JSX.Element {
  return (
    <div className="px-4 py-1.5 text-center italic text-text-muted" data-task-event-legacy="1">
      {content}
    </div>
  );
}

/**
 * Mid-tier degraded row for legacy task system messages (pre-PR-2 DB
 * rows). Metadata only carries `(subtype, task_number, task_status)`;
 * we have no actor / title / message_id, so:
 *  - dot uses `subtype === 'task_unclaim' ? 'unclaim' : task_status`
 *    — same rule as the enriched row; `subtype` is in legacy metadata.
 *  - chip is just `#task:N` (no inline title).
 *  - body shows `{verb}` (create/claim/unclaim/edit) or `→ {pill}`
 *    (status); no actor pill.
 */
function TaskEventRowDegraded({ meta }: { meta: TaskSystemMetadataPartial }): JSX.Element {
  const dotKind: TaskEventDotKind = meta.subtype === "task_unclaim" ? "unclaim" : meta.task_status;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-1.5 text-text-secondary"
      data-task-event-degraded="1"
    >
      <TaskEventDot kind={dotKind} />
      {meta.subtype === "task_status" ? (
        <>
          <TaskRef taskNumber={meta.task_number} />
          <span className="text-text-muted" aria-hidden>
            →
          </span>
          <TaskStatusPill status={meta.task_status} />
        </>
      ) : (
        <>
          <span className="text-text-muted">
            {meta.subtype === "task_create"
              ? "created"
              : meta.subtype === "task_claim"
                ? "claimed"
                : meta.subtype === "task_edit"
                  ? "edited"
                  : "unclaimed"}
          </span>
          <TaskRef taskNumber={meta.task_number} />
        </>
      )}
    </div>
  );
}
