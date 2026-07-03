import {
  type TaskStatus,
  type TaskSubtype,
  type TaskSystemMetadata,
  type TaskSystemMetadataPartial,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
} from '@silverhand/shared';
import { formatUserDisplayName } from '@/lib/current-user';
import { TaskRef } from '@/components/chat/TaskRef';
import { type RendererProps, useUserResolver } from './shared';

// ─── task event row ───────────────────────────────────────────────────

/**
 * Inline row for `task_create` / `task_claim` / `task_unclaim` /
 * `task_status` system messages. Each row appears at its real position
 * in the message stream — same-task events are NOT connected by a
 * line; visual continuity comes from the `#task:N` chip identity and
 * its hover popover (already wired in PR-4 infra).
 *
 * Three sub-shapes (chosen by a defensive metadata cascade —
 * `readTaskSystemMetadata` → `readTaskSystemMetadataPartial` →
 * total fallback):
 *  - Full enriched metadata: `<dot> <actor> <verb> <chip>` for
 *    create/claim/unclaim; `<dot> <actor> moved <chip> → <status pill>`
 *    for status transitions. PR-9 unified actor position to the front
 *    across all four subtypes (@shiki feedback msg `UoJ6LPHDpJCHYVFe`).
 *  - Partial legacy metadata (pre-PR-2 rows: subtype + task_number +
 *    task_status only): degraded row keeps the dot + chip + verb (or
 *    `→ pill` for status), drops the actor pill / inline title — we
 *    have no metadata for them and we deliberately do NOT re-parse
 *    `message.content`.
 *  - No usable metadata: centered muted-italic narration showing
 *    `message.content` verbatim, as a true bottom fallback.
 *
 * Status colors stay subtle (the row is muted overall — quieter than a
 * real chat message). Cindy's PR-2 visual norms (msg `AjrWQyiFyq08zMya`):
 *  - row baseline = `text-text-secondary`
 *  - status colors only on the dot + the pill, not on row body.
 */
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

function TaskEventRowEnriched({
  meta,
}: {
  meta: TaskSystemMetadata;
}): JSX.Element {
  const userResolver = useUserResolver();
  const actorLabel = meta.actor.kind === 'user'
    ? `@${formatUserDisplayName(meta.actor.id, userResolver) || meta.actor.name || 'user'}`
    : `@${meta.actor.name}`;

  const dotKind: TaskEventDotKind =
    meta.subtype === 'task_unclaim' ? 'unclaim' : meta.task_status;

  return (
    <div className="flex items-center gap-2.5 px-4 py-1.5 text-text-secondary">
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
  if (subtype === 'task_status') {
    // PR-9 (@shiki feedback msg `UoJ6LPHDpJCHYVFe`): keep actor at the
    // front like the create/claim/unclaim shape so all four task event
    // subtypes share an `@actor verb chip [→ pill]` reading order.
    // Verb is `moved` (Jira convention; covers any todo→in_progress /
    // in_progress→in_review / *→done transition without naming each).
    return (
      <>
        <span className="font-medium text-text-primary">{actorLabel}</span>
        <span className="text-text-muted">moved</span>
        <TaskRef taskNumber={meta.task_number} />
        <span className="text-text-muted" aria-hidden>→</span>
        <TaskStatusPill status={meta.task_status} />
      </>
    );
  }
  const verb =
    subtype === 'task_create'
      ? 'created'
      : subtype === 'task_claim'
        ? 'claimed'
        : 'unclaimed';
  return (
    <>
      <span className="font-medium text-text-primary">{actorLabel}</span>
      <span className="text-text-muted">{verb}</span>
      <TaskRef taskNumber={meta.task_number} />
    </>
  );
}

type TaskEventDotKind = TaskStatus | 'unclaim';

function TaskEventDot({ kind }: { kind: TaskEventDotKind }): JSX.Element {
  // Status dots consume the board's per-status SOLID signal colour
  // (`--task-status-*-solid`, #task:1018) so the chat-stream dot matches
  // the task board chip in every theme. Each theme homes `-solid` on its
  // own identity source (forza6 → poster `-bg`; warm/slack → saturated
  // `-text`), so this single token reads correctly everywhere. `unclaim`
  // is not a status — it keeps a neutral dashed-hollow marker.
  const cls: Record<TaskEventDotKind, string> = {
    todo: 'bg-[var(--task-status-todo-solid)]',
    in_progress: 'bg-[var(--task-status-in-progress-solid)]',
    in_review: 'bg-[var(--task-status-in-review-solid)]',
    done: 'bg-[var(--task-status-done-solid)]',
    closed: 'bg-[var(--task-status-closed-solid)]',
    unclaim: 'border border-dashed border-text-muted/60 bg-transparent',
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
 * 12px) * 1.5))` in `global.css`), which is also applied to the sibling
 * `TaskRef` chip via `[data-task-ref]`. Both grow together at larger
 * theme prose sizes so the chip + pill stay pixel-aligned and never
 * crop their text. `leading-none` keeps the inline content centered
 * inside that height regardless of the row's `line-height: 1.5`.
 */
function TaskStatusPill({ status }: { status: TaskStatus }): JSX.Element {
  const labels: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    in_review: 'in review',
    done: 'done',
    closed: 'closed',
  };
  return (
    <span
      data-task-event-status={status}
      data-task-status={status}
      className="inline-flex items-center whitespace-nowrap rounded-full px-1.5 text-[10px] font-semibold uppercase leading-none tracking-wider"
    >
      {labels[status]}
    </span>
  );
}

function TaskEventLegacyFallback({ content }: { content: string }): JSX.Element {
  return (
    <div
      className="px-4 py-1.5 text-center italic text-text-muted"
      data-task-event-legacy="1"
    >
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
 *  - body shows `{verb}` (create/claim/unclaim) or `→ {pill}`
 *    (status); no actor pill.
 */
function TaskEventRowDegraded({
  meta,
}: {
  meta: TaskSystemMetadataPartial;
}): JSX.Element {
  const dotKind: TaskEventDotKind =
    meta.subtype === 'task_unclaim' ? 'unclaim' : meta.task_status;
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-1.5 text-text-secondary"
      data-task-event-degraded="1"
    >
      <TaskEventDot kind={dotKind} />
      {meta.subtype === 'task_status' ? (
        <>
          <TaskRef taskNumber={meta.task_number} />
          <span className="text-text-muted" aria-hidden>→</span>
          <TaskStatusPill status={meta.task_status} />
        </>
      ) : (
        <>
          <span className="text-text-muted">
            {meta.subtype === 'task_create'
              ? 'created'
              : meta.subtype === 'task_claim'
                ? 'claimed'
                : 'unclaimed'}
          </span>
          <TaskRef taskNumber={meta.task_number} />
        </>
      )}
    </div>
  );
}
