import { useState, type ComponentType } from 'react';
import { AtSign, CheckCircle2, ChevronRight, ClipboardCheck, Clock, Quote, RotateCcw, RotateCw, Sprout } from 'lucide-react';
import {
  type ChannelContextMetadata,
  type ChildContextMetadata,
  type MessageDto,
  type RenameMetadata,
  type ScheduleFireMetadata,
  type SessionClearedMetadata,
  type SystemSubtype,
  type TaskStatus,
  type TaskSubtype,
  type TaskSystemMetadata,
  type TaskSystemMetadataPartial,
  type ThreadAnchorMetadata,
  readChannelContextMetadata,
  readChildContextMetadata,
  readRenameMetadata,
  readScheduleFireMetadata,
  readSessionClearedMetadata,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
  readThreadAnchorMetadata,
  resolveSubtype,
} from '@silverhand/shared';
import { useMessage } from '@/features/messages/hooks';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';
import { formatUserDisplayName } from '@/lib/current-user';
import { Markdown } from './Markdown';
import { ConversationRef } from './ConversationRef';
import { useRelativeTime } from './useRelativeTime';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';

interface SystemMessageProps {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}

/**
 * Props every per-subtype renderer receives. Mirrors `SystemMessageProps`
 * minus the public-facing prop name; carrying the same shape keeps refs
 * (channel / conversation links, mention pills) wired through markdown
 * inside any renderer.
 */
interface RendererProps {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}

type SystemMessageRenderer = ComponentType<RendererProps>;

/**
 * System messages render via a per-subtype registry. The registry is typed
 * `Record<SystemSubtype, SystemMessageRenderer>` — missing entries fail
 * typecheck, so adding a new subtype to `@silverhand/shared` forces a
 * matching renderer here.
 *
 * Resolution is three-state (`resolveSubtype`):
 *  - `current`: look up in `systemMessageRenderers` and render.
 *  - `legacy`: DB-resident subtype no producer writes anymore — generic
 *    narration. We do NOT re-parse content prefixes to fake current
 *    rendering for legacy rows; that path lived in the old `inferSubtype`
 *    helper and was removed in PR-1.
 *  - `unknown`: missing/unrecognized subtype — generic narration.
 *
 * Both fallback states render the same generic-narration component; we
 * keep them as separate `kind` values so future telemetry can distinguish
 * historic rows from drift bugs.
 */
export function SystemMessage(props: SystemMessageProps): JSX.Element {
  const resolution = resolveSubtype(readRawSubtype(props.message.metadata));
  if (resolution.kind === 'current') {
    const Renderer = systemMessageRenderers[resolution.subtype];
    return <Renderer {...props} />;
  }
  return <GenericNarrationFallback {...props} />;
}

function readRawSubtype(
  metadata: MessageDto['metadata'],
): string | null | undefined {
  if (!metadata) return null;
  const v = (metadata as Record<string, unknown>)['subtype'];
  return typeof v === 'string' ? v : null;
}

// ─── Generic fallback ──────────────────────────────────────────────────

/** IM-convention narration for legacy/unknown subtypes and any current
 *  subtype that doesn't have a custom renderer yet (PR-2..PR-6 will
 *  progressively replace fallthrough entries with bespoke components). */
function GenericNarrationFallback({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  return (
    <div className="px-4 py-1.5 text-center text-xs italic text-text-muted">
      <Markdown
        content={message.content}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        channelsByName={channelsByName}
        onOpenChannelRef={onOpenChannelRef}
      />
    </div>
  );
}

// ─── Collapsible long-form narration ───────────────────────────────────

/** Long markdown bodies (onboarding prompt, inherited context, quoted
 *  anchor) collapse to a single line by default and expand on click. */
function CollapsibleNarration({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={
        'group flex w-full items-start gap-1 px-2 py-1 text-left text-xs text-text-muted ' +
        (expanded ? 'bg-bg-floating' : 'rounded hover:bg-bg-hover')
      }
      aria-expanded={expanded}
    >
      <ChevronRight
        className={
          'mt-[3px] size-3 shrink-0 text-text-muted/60 transition-transform ' +
          (expanded ? 'rotate-90' : '')
        }
      />
      <div className={'min-w-0 flex-1 ' + (expanded ? '' : 'truncate')}>
        {expanded ? (
          <Markdown
            content={message.content}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
          />
        ) : (
          // Plain text — markdown leaks block elements that break a
          // single-line clamp.
          <span>{firstLine(message.content)}</span>
        )}
      </div>
    </button>
  );
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

// ─── mention_cc card ───────────────────────────────────────────────────

/**
 * Compact render for `mention_cc` system messages: source line
 * (user · workspace · conversation) plus the original message body.
 * The verbose imperative wrap stays in `message.content` for the
 * agent's stdin only.
 */
function MentionCcCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const channelName =
    typeof meta['source_workspace_name'] === 'string'
      ? (meta['source_workspace_name'] as string)
      : null;
  const conversationTitle =
    typeof meta['source_conversation_title'] === 'string'
      ? (meta['source_conversation_title'] as string)
      : null;
  const inlineOriginal =
    typeof meta['source_message_content'] === 'string'
      ? (meta['source_message_content'] as string)
      : null;
  const sourceMessageId =
    typeof meta['source_message_id'] === 'string'
      ? (meta['source_message_id'] as string)
      : null;
  const sourceFromKind =
    typeof meta['source_from_kind'] === 'string'
      ? (meta['source_from_kind'] as string)
      : null;
  const sourceFromUserId =
    typeof meta['source_from_user_id'] === 'string'
      ? (meta['source_from_user_id'] as string)
      : null;
  // Legacy rows (pre-`source_message_content`) fall back to fetching
  // the original message by id. Hook stays disabled when the inline
  // copy is present so we don't pay the round-trip on new rows.
  const { data: fetched } = useMessage(inlineOriginal ? null : sourceMessageId);
  const original = inlineOriginal ?? fetched?.message.content ?? null;
  const sourceUserLabel =
    sourceFromKind === 'user' || fetched?.message.from_kind === 'user'
      ? formatUserDisplayName(sourceFromUserId ?? fetched?.message.from_user_id)
      : 'user';

  return (
    <div className="border-l-2 border-accent/60 bg-bg-floating/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <AtSign className="size-3.5" />
        <span>
          mentioned by{' '}
          <span className="text-text-secondary">{sourceUserLabel}</span>
          {channelName ? (
            <>
              {' in '}
              <span className="text-text-secondary">#{channelName}</span>
            </>
          ) : null}
          {conversationTitle ? (
            <>
              {' · '}
              <span className="text-text-secondary">{conversationTitle}</span>
            </>
          ) : null}
        </span>
      </div>
      {original ? (
        <div className="text-sm text-text-primary">
          <Markdown
            content={original}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
          />
        </div>
      ) : (
        <div className="text-xs text-text-muted">(loading original…)</div>
      )}
    </div>
  );
}

// ─── session_cleared audit row ────────────────────────────────────────

/**
 * `session_cleared` is an audit event ("user reset @Alice's CLI session
 * context"). The previous renderer wrapped it as a destructive toast
 * (red border + bg-error tint + Eraser icon), which clashed with the
 * message stream's IM aesthetic — sessions don't get *deleted*, they
 * get *reset*. PR-3 swaps the toast for a single muted inline row
 * with a `RotateCcw` (counter-clockwise reset arrow) icon and
 * structured metadata pieces (actor · agent · prev session prefix ·
 * was-running flag) so the row reads as a one-line audit entry, not a
 * warning popup.
 *
 * Renderer chain:
 *  - Full metadata (`SessionClearedMetadata`): structured row.
 *  - Missing/legacy metadata: degraded muted row carrying
 *    `message.content` so legacy DB rows still display something
 *    sensible.
 */
function SessionClearedCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const meta = readSessionClearedMetadata(message.metadata);
  if (meta) return <SessionClearedRow meta={meta} />;
  return (
    <div
      className="flex items-center gap-2 px-4 py-1 text-xs text-text-muted"
      data-session-cleared-legacy="1"
    >
      <RotateCcw aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <div className="min-w-0 flex-1">
        <Markdown
          content={message.content}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
        />
      </div>
    </div>
  );
}

function SessionClearedRow({
  meta,
}: {
  meta: SessionClearedMetadata;
}): JSX.Element {
  // `actor_user_id: null` in this metadata means "principal info wasn't
  // recorded at insert time" (per shared schema docstring), NOT "current
  // viewer" — the latter is the v1 message-row convention used by
  // `formatUserDisplayName`. Run the helper only when the id is set;
  // otherwise render a generic "a user" so the audit row doesn't
  // misattribute the action to the current viewer.
  const actorLabel = meta.actor_user_id
    ? `@${formatUserDisplayName(meta.actor_user_id)}`
    : 'a user';
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-1 text-xs text-text-muted"
      data-session-cleared="1"
    >
      <RotateCcw aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span
        className="text-text-secondary"
        data-session-cleared-actor={meta.actor_user_id ?? 'unknown'}
      >
        {actorLabel}
      </span>
      <span>reset</span>
      <span className="font-medium text-text-primary">@{meta.agent_name}</span>
      <span>'s session context</span>
      {meta.previous_cli_session_id_prefix ? (
        <>
          <span aria-hidden className="text-text-muted/60">·</span>
          <span>
            prev{' '}
            <code className="rounded bg-bg-elevated px-1 font-mono text-[11px] text-text-secondary">
              {meta.previous_cli_session_id_prefix}
            </code>
          </span>
        </>
      ) : null}
      <span aria-hidden className="text-text-muted/60">·</span>
      <span data-session-cleared-running={meta.was_running ? '1' : '0'}>
        was {meta.was_running ? 'running' : 'idle'}
      </span>
    </div>
  );
}

// ─── schedule_fire wake banner ─────────────────────────────────────────

/**
 * Flat banner for `schedule_fire` system messages — emitted when a
 * scheduled wake fires for an agent. The previous renderer used the
 * generic centered-italic narration, which lost the actionable shape
 * (kind, planned vs actual, missed catch-up, next fire). PR-4 swaps
 * for an inline banner with a left warning accent line, header pills
 * for the spec + timing facts, and the user's reminder text as the
 * body.
 *
 * Renderer chain:
 *  - Full metadata: structured banner with header + pills + body.
 *  - Missing metadata: muted fallback rendering `message.content` as
 *    a single muted block — same banner chrome, no pills, lets old
 *    DB rows still display sensibly.
 */
function ScheduleFireBanner({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const meta = readScheduleFireMetadata(message.metadata);
  // Body is `meta.body` when producer wrote it (post-PR-4 producer
  // change); legacy rows fall back to `message.content` so older DB
  // wakes still surface their reminder text.
  const bodyMd = meta?.body ?? message.content;

  return (
    <div
      className="border-y border-border-subtle border-l-[3px] border-l-warning bg-bg-floating px-4 py-2 text-sm"
      data-schedule-fire={meta ? '1' : '0'}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
        <Clock aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span>Scheduled wake</span>
        {meta ? (
          <span className="ml-auto font-mono text-[11px] font-normal text-text-muted">
            {meta.spec_summary ?? meta.spec_kind}
          </span>
        ) : null}
      </div>
      {meta ? (
        <ScheduleFirePills meta={meta} />
      ) : null}
      <div className="text-text-primary">
        <Markdown
          content={bodyMd}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
        />
      </div>
    </div>
  );
}

function ScheduleFirePills({ meta }: { meta: ScheduleFireMetadata }): JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      <ScheduleFireFiredPill firedAt={meta.actual_fire_at} />
      {meta.planned_fire_at !== null ? (
        <ScheduleFirePlannedPill
          plannedAt={meta.planned_fire_at}
          actualAt={meta.actual_fire_at}
        />
      ) : null}
      <ScheduleFireMissedPill count={meta.missed_count} />
      {meta.next_fire_at !== null ? (
        <ScheduleFireNextPill nextAt={meta.next_fire_at} />
      ) : null}
    </div>
  );
}

const PILL_BASE =
  'inline-flex items-center gap-1 rounded bg-bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-text-secondary';

function ScheduleFireFiredPill({ firedAt }: { firedAt: number }): JSX.Element {
  const { relative, absolute } = useRelativeTime(firedAt);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="fired">
      <span className="text-text-muted">fired</span>
      <span>{relative}</span>
    </span>
  );
}

/** "planned 4m ago" / "planned 2s late" — relative to actual fire time.
 *  Negative delta (planned BEFORE actual) means the wake fired late;
 *  positive delta (planned AFTER actual) shouldn't really happen but
 *  display "early" defensively. */
function ScheduleFirePlannedPill({
  plannedAt,
  actualAt,
}: {
  plannedAt: number;
  actualAt: number;
}): JSX.Element {
  const { absolute } = useRelativeTime(plannedAt);
  const deltaMs = actualAt - plannedAt;
  const label = formatScheduleDelta(deltaMs);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="planned">
      <span className="text-text-muted">planned</span>
      <span>{label}</span>
    </span>
  );
}

function ScheduleFireMissedPill({ count }: { count: number }): JSX.Element {
  const cls = count === 0
    ? PILL_BASE + ' text-text-muted'
    : PILL_BASE + ' bg-warning/10 text-warning';
  return (
    <span className={cls} data-pill="missed" data-missed-count={String(count)}>
      <span className="text-text-muted">missed</span>
      <span>{count}</span>
    </span>
  );
}

function ScheduleFireNextPill({ nextAt }: { nextAt: number }): JSX.Element {
  const { relative, absolute } = useRelativeTime(nextAt);
  return (
    <span className={PILL_BASE} title={absolute} data-pill="next">
      <span className="text-text-muted">next</span>
      <span>{relative}</span>
    </span>
  );
}

/** Delta between planned and actual wake. Positive = wake fired
 *  late ("planned 4m ago"); negative = early ("planned in 2s"). */
function formatScheduleDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const SEC = 1_000;
  const MIN = 60 * SEC;
  const HR = 60 * MIN;
  let value: string;
  if (abs < MIN) value = `${Math.round(abs / SEC)}s`;
  else if (abs < HR) value = `${Math.round(abs / MIN)}m`;
  else value = `${Math.round(abs / HR)}h`;
  // "planned <value> ago" if late, "<value> late" reads odd; keep it
  // symmetric with "next in <value>" by using "ago"/"in".
  if (deltaMs > 0) return `${value} ago`;
  if (deltaMs < 0) return `in ${value}`;
  return 'on time';
}

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
 *    create/claim/unclaim; `<dot> <chip> → <status pill> by <actor>`
 *    for status transitions.
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
function TaskEventRow({ message }: RendererProps): JSX.Element {
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
  const actorLabel = meta.actor.kind === 'user'
    ? `@${formatUserDisplayName(meta.actor.id) || meta.actor.name || 'user'}`
    : `@${meta.actor.name}`;

  const dotKind: TaskEventDotKind =
    meta.subtype === 'task_unclaim' ? 'unclaim' : meta.task_status;

  return (
    <div className="flex items-center gap-2.5 px-4 py-1.5 text-xs text-text-secondary">
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
    return (
      <>
        <TaskEventChip
          taskNumber={meta.task_number}
          title={meta.task_title}
        />
        <span className="text-text-muted" aria-hidden>→</span>
        <TaskStatusPill status={meta.task_status} />
        <span className="text-text-muted">by {actorLabel}</span>
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
      <TaskEventChip
        taskNumber={meta.task_number}
        title={subtype === 'task_create' ? meta.task_title : null}
      />
    </>
  );
}

type TaskEventDotKind = TaskStatus | 'unclaim';

function TaskEventDot({ kind }: { kind: TaskEventDotKind }): JSX.Element {
  const cls: Record<TaskEventDotKind, string> = {
    todo: 'bg-text-muted/60',
    in_progress: 'bg-accent',
    in_review: 'bg-warning',
    done: 'bg-success',
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
 * Static chip rendering for the task event row. Mirrors `TaskRef`'s
 * resolved-state shape but reads `task_number` / `title` straight from
 * metadata — no fetch, no skeleton, no hover popover. The popover and
 * deep linking on the chip stay on `#task:N` sigils inside chat
 * messages where the user is reading prose; the event row is itself
 * the audit record, so the chip's job is just to label the row.
 */
function TaskEventChip({
  taskNumber,
  title,
}: {
  taskNumber: number;
  title: string | null;
}): JSX.Element {
  const ctx = useTaskRefContext();
  const onOpenTask = ctx?.onOpenTask;
  const label = `#task:${taskNumber}`;
  const baseClass =
    'inline-flex max-w-[260px] items-center gap-0.5 rounded bg-bg-elevated px-1.5 font-mono text-[11px]';
  const content = (
    <>
      <ClipboardCheck className="size-3 shrink-0 self-center text-accent" />
      <span className="truncate font-semibold text-accent">{label}</span>
      {title ? (
        <span className="truncate font-sans font-normal text-text-secondary">
          {title}
        </span>
      ) : null}
    </>
  );
  if (!onOpenTask) {
    return (
      <span
        className={baseClass + ' text-text-secondary'}
        title={title ? `${label} · ${title}` : label}
        data-task-event-chip={String(taskNumber)}
        data-task-event-chip-state="inert"
      >
        {content}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className={
        baseClass +
        ' cursor-pointer text-text-secondary transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus'
      }
      aria-label={title ? `${label} · ${title}` : label}
      data-task-event-chip={String(taskNumber)}
      data-task-event-chip-state="clickable"
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

function TaskStatusPill({ status }: { status: TaskStatus }): JSX.Element {
  const styles: Record<TaskStatus, string> = {
    todo: 'bg-bg-elevated text-text-muted',
    in_progress: 'bg-accent/10 text-accent',
    in_review: 'bg-warning/10 text-warning',
    done: 'bg-success/10 text-success',
  };
  const labels: Record<TaskStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    in_review: 'in review',
    done: 'done',
  };
  return (
    <span
      data-task-event-status={status}
      className={
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ' +
        styles[status]
      }
    >
      {labels[status]}
    </span>
  );
}

function TaskEventLegacyFallback({ content }: { content: string }): JSX.Element {
  return (
    <div
      className="px-4 py-1.5 text-center text-xs italic text-text-muted"
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
      className="flex items-center gap-2.5 px-4 py-1.5 text-xs text-text-secondary"
      data-task-event-degraded="1"
    >
      <TaskEventDot kind={dotKind} />
      {meta.subtype === 'task_status' ? (
        <>
          <TaskEventChip taskNumber={meta.task_number} title={null} />
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
          <TaskEventChip taskNumber={meta.task_number} title={null} />
        </>
      )}
    </div>
  );
}

// ─── thread_summary card ───────────────────────────────────────────────

/**
 * Compact render for `thread_summary` system messages — emitted to the
 * parent channel when a thread is closed. The summary itself is
 * markdown (often headings + lists + code), so we surface it as a
 * left-aligned card with full markdown rendering rather than the
 * centered-italic narration treatment that suits one-liners.
 */
function ThreadSummaryCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const threadTitle =
    typeof meta['thread_title'] === 'string'
      ? (meta['thread_title'] as string)
      : null;
  const closedBy =
    typeof meta['closed_by'] === 'string'
      ? (meta['closed_by'] as string)
      : null;
  const summary =
    typeof meta['summary'] === 'string'
      ? (meta['summary'] as string)
      : message.content;

  return (
    <div className="border-l-2 border-accent/60 bg-bg-floating/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <CheckCircle2 className="size-3.5" />
        <span>
          Thread closed
          {threadTitle ? (
            <>
              {' · '}
              <span className="text-text-secondary">{threadTitle}</span>
            </>
          ) : null}
          {closedBy ? (
            <>
              {' · by '}
              <span className="text-text-secondary">{closedBy}</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="text-sm text-text-primary">
        <Markdown
          content={summary}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
        />
      </div>
    </div>
  );
}

// ─── context-card series (PR-5) ───────────────────────────────────────
//
// `thread_anchor`, `child_context`, and `channel_context` share the
// same render shape: left accent line (color per kind), kind tag,
// source chip, collapsible body. Three thin subtype-specific shells
// pull their metadata, normalize it into a `ContextCardModel`, and
// hand off to `ContextCardShell` for the chrome.
//
// Cindy's visual rule (msg AjrWQyiFyq08zMya): kind accent color is
// confined to the 2px left line + the small kind tag. The body itself
// stays neutral text-primary so multiple stacked context cards don't
// shout at the reader.

type ContextCardKind = 'quoted' | 'inherited' | 'spawned';

interface ContextCardModel {
  kind: ContextCardKind;
  /** uppercase tag label: "Quoted" / "Inherited" / "Spawned-from" */
  tagLabel: string;
  /** Optional small phrase rendered before the source chip (e.g.
   *  "from " for `child_context`). Empty for the other kinds. */
  sourcePrefix: string;
  /** Conversation id of the source — rendered as a clickable
   *  `ConversationRef` chip so the reader can jump to the original
   *  conversation (cross-workspace safe via `useConversationById`). */
  sourceConversationId: string;
  /** Optional secondary label appended after the chip with a `·`
   *  separator (e.g. "@shiki", "by @Cindy"). Empty when the source
   *  has no companion identity to surface. */
  sourceAuthorLabel: string;
  /** raw body text rendered through Markdown when expanded */
  body: string;
  /** epoch ms of the original event, surfaced as relative time on
   *  the right of the header. `null` to suppress. */
  timestamp: number | null;
  /** when true, body opens expanded by default and the toggle is
   *  hidden — used for `thread_anchor` since the quoted text IS the
   *  point of the row. */
  defaultExpanded: boolean;
  /** when true, render the body inside a blockquote — currently only
   *  `thread_anchor` (visually echoes "this is quoted text"). */
  blockquote: boolean;
}

const CONTEXT_KIND_BORDER: Record<ContextCardKind, string> = {
  quoted: 'border-l-accent',
  inherited: 'border-l-success',
  spawned: 'border-l-warning',
};

const CONTEXT_KIND_TAG_BG: Record<ContextCardKind, string> = {
  quoted: 'bg-accent text-text-on-accent',
  inherited: 'bg-success text-white',
  spawned: 'bg-warning text-white',
};

const CONTEXT_KIND_TAG_ICON: Record<ContextCardKind, JSX.Element> = {
  quoted: <Quote className="size-3" />,
  inherited: <ChevronRight className="size-3" />,
  spawned: <Sprout className="size-3" />,
};

/** Tiny wrapper so `useRelativeTime` only fires when there's a real
 *  timestamp to render — keeps the hook call site unconditional. */
function ContextCardRelativeTime({ epochMs }: { epochMs: number }): JSX.Element {
  const { relative } = useRelativeTime(epochMs);
  return <span className="text-text-muted">{relative}</span>;
}

/** Shared chrome for the three context-card subtypes. Renders
 *  registry-flagged kind tag + source chip + optional timestamp on
 *  the header line, then a collapsible body underneath. */
function ContextCardShell({
  model,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: {
  model: ContextCardModel;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(model.defaultExpanded);
  const collapsible = !model.defaultExpanded;
  const bodyMarkdown = (
    <Markdown
      content={model.body}
      conversationRefsById={conversationRefsById}
      onOpenConversationRef={onOpenConversationRef}
      channelsByName={channelsByName}
      onOpenChannelRef={onOpenChannelRef}
    />
  );

  return (
    <div
      data-context-card={model.kind}
      className={
        'mx-4 my-1 border-l-2 bg-bg-floating px-3 py-2 ' +
        CONTEXT_KIND_BORDER[model.kind]
      }
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <span
          className={
            'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ' +
            CONTEXT_KIND_TAG_BG[model.kind]
          }
        >
          {CONTEXT_KIND_TAG_ICON[model.kind]}
          {model.tagLabel}
        </span>
        {model.sourcePrefix ? (
          <span className="text-text-secondary">{model.sourcePrefix}</span>
        ) : null}
        <ConversationRef
          id={model.sourceConversationId}
          conversation={conversationRefsById?.get(model.sourceConversationId)}
          onOpen={onOpenConversationRef}
        />
        {model.sourceAuthorLabel ? (
          <span className="text-text-secondary">
            · {model.sourceAuthorLabel}
          </span>
        ) : null}
        {model.timestamp !== null ? (
          <ContextCardRelativeTime epochMs={model.timestamp} />
        ) : null}
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto text-text-muted hover:text-text-secondary"
            aria-expanded={expanded}
            data-context-toggle={expanded ? 'collapse' : 'expand'}
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        ) : null}
      </div>
      <div
        className={
          'text-sm ' +
          (expanded ? 'text-text-primary' : 'truncate text-text-secondary')
        }
      >
        {expanded ? (
          model.blockquote ? (
            <blockquote className="border-l-2 border-border pl-2 text-text-secondary">
              {bodyMarkdown}
            </blockquote>
          ) : (
            bodyMarkdown
          )
        ) : (
          // Plain text first line so markdown blocks (lists, headings)
          // don't break the single-line clamp.
          <span>{firstLine(model.body)}</span>
        )}
      </div>
    </div>
  );
}

/** Muted fallback for legacy rows lacking enriched metadata. Preserves
 *  the kind tag + left accent line so the reader can still tell what
 *  flavor of context this was — strictly less informative than the
 *  enriched card (no clickable source chip, no toggle / blockquote /
 *  timestamp) but still distinguishable from generic narration.
 *
 *  Layout note: tag goes on its own row above the body. The body is a
 *  block `<div>` because `Markdown` renders block-level elements
 *  (`<p>`, lists, etc.) — wrapping it in an inline `<span>` produces
 *  invalid DOM that browsers silently restructure (PR-5 review by
 *  @Cindy on commit 3236554).
 */
function ContextCardLegacyFallback({
  kind,
  tagLabel,
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: {
  kind: ContextCardKind;
  tagLabel: string;
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
  return (
    <div
      data-context-card={kind}
      data-context-card-legacy="1"
      className={
        'mx-4 my-1 border-l-2 bg-bg-floating px-3 py-2 text-xs text-text-muted ' +
        CONTEXT_KIND_BORDER[kind]
      }
    >
      <div className="mb-1">
        <span
          className={
            'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ' +
            CONTEXT_KIND_TAG_BG[kind]
          }
        >
          {tagLabel}
        </span>
      </div>
      <div className="italic">
        <Markdown
          content={message.content}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
        />
      </div>
    </div>
  );
}

function ThreadAnchorCard(props: RendererProps): JSX.Element {
  const meta = readThreadAnchorMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return (
      <ContextCardLegacyFallback
        kind="quoted"
        tagLabel="Quoted"
        {...props}
      />
    );
  }
  return (
    <ContextCardShell
      model={threadAnchorModel(meta)}
      conversationRefsById={props.conversationRefsById}
      onOpenConversationRef={props.onOpenConversationRef}
      channelsByName={props.channelsByName}
      onOpenChannelRef={props.onOpenChannelRef}
    />
  );
}

function threadAnchorModel(meta: ThreadAnchorMetadata): ContextCardModel {
  let authorLabel: string;
  if (meta.quoted_from_kind === 'agent') {
    authorLabel = meta.quoted_agent_name
      ? `@${meta.quoted_agent_name}`
      : '@agent';
  } else if (meta.quoted_from_kind === 'user') {
    authorLabel = `@${formatUserDisplayName(meta.quoted_from_user_id)}`;
  } else {
    authorLabel = 'system';
  }
  return {
    kind: 'quoted',
    tagLabel: 'Quoted',
    sourcePrefix: '',
    sourceConversationId: meta.quoted_conversation_id,
    sourceAuthorLabel: authorLabel,
    body: meta.quoted_content,
    timestamp: meta.quoted_created_at,
    defaultExpanded: true,
    blockquote: true,
  };
}

function ChildContextCard(props: RendererProps): JSX.Element {
  const meta = readChildContextMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return (
      <ContextCardLegacyFallback
        kind="inherited"
        tagLabel="Inherited"
        {...props}
      />
    );
  }
  return (
    <ContextCardShell
      model={childContextModel(meta)}
      conversationRefsById={props.conversationRefsById}
      onOpenConversationRef={props.onOpenConversationRef}
      channelsByName={props.channelsByName}
      onOpenChannelRef={props.onOpenChannelRef}
    />
  );
}

function childContextModel(meta: ChildContextMetadata): ContextCardModel {
  return {
    kind: 'inherited',
    tagLabel: 'Inherited',
    sourcePrefix: 'from ',
    sourceConversationId: meta.parent_conversation_id,
    sourceAuthorLabel: '',
    body: meta.summary,
    timestamp: null,
    defaultExpanded: false,
    blockquote: false,
  };
}

function ChannelContextCard(props: RendererProps): JSX.Element {
  const meta = readChannelContextMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return (
      <ContextCardLegacyFallback
        kind="spawned"
        tagLabel="Spawned-from"
        {...props}
      />
    );
  }
  return (
    <ContextCardShell
      model={channelContextModel(meta, props.message.content)}
      conversationRefsById={props.conversationRefsById}
      onOpenConversationRef={props.onOpenConversationRef}
      channelsByName={props.channelsByName}
      onOpenChannelRef={props.onOpenChannelRef}
    />
  );
}

function channelContextModel(
  meta: ChannelContextMetadata,
  content: string,
): ContextCardModel {
  const agentLabel = meta.created_by_agent_name
    ? `by @${meta.created_by_agent_name}`
    : 'by an agent';
  return {
    kind: 'spawned',
    tagLabel: 'Spawned-from',
    sourcePrefix: '',
    sourceConversationId: meta.source_conversation_id,
    sourceAuthorLabel: agentLabel,
    body: content,
    timestamp: null,
    defaultExpanded: false,
    blockquote: false,
  };
}

// ─── onboarding row (PR-6) ─────────────────────────────────────────────
//
// Onboarding messages used to render via `CollapsibleNarration` —
// chevron + first-line preview, no kind identification. PR-6 keeps
// the same collapsible affordance but adds an explicit "Onboarding"
// badge so the row is recognisable at a glance even when the prose
// has been rewritten. No metadata enrichment needed: the body itself
// is the onboarding instruction (different shape per call site:
// workspace join, agent DM, thread spawn).

function OnboardingRow({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={
        // `items-start` (not `items-center`) so when expanded — body
        // becomes multi-line Markdown (paragraphs / lists / code) —
        // the chevron and badge stay anchored at the top instead of
        // floating to the vertical center of the rendered block.
        // Tiny per-element top offsets line them up visually against
        // the first line of the body. PR-6 follow-up review by
        // @Cindy on `6f15d96`.
        'group flex w-full items-start gap-2 px-2 py-1 text-left text-xs text-text-muted ' +
        (expanded ? 'bg-bg-floating' : 'rounded hover:bg-bg-hover')
      }
      aria-expanded={expanded}
      data-onboarding-row="1"
    >
      <ChevronRight
        className={
          'mt-[3px] size-3 shrink-0 text-text-muted/60 transition-transform ' +
          (expanded ? 'rotate-90' : '')
        }
      />
      <span
        className="mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent bg-accent-soft"
        data-onboarding-badge="1"
      >
        Onboarding
      </span>
      <div className={'min-w-0 flex-1 ' + (expanded ? '' : 'truncate')}>
        {expanded ? (
          <Markdown
            content={message.content}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
          />
        ) : (
          <span>{firstLine(message.content)}</span>
        )}
      </div>
    </button>
  );
}

// ─── rename row (PR-6) ─────────────────────────────────────────────────
//
// Rename messages carry `{old_name, new_name}` in metadata since
// PR-6's predecessor — the renderer parses them into a compact
// audit row (`↻ workspace renamed #old → #new`) so the prose body
// (which exists for the agent-stdin imperative wrap) doesn't have
// to be the user-visible surface. Legacy rows without metadata fall
// through to generic narration.

function RenameRow(props: RendererProps): JSX.Element {
  const meta = readRenameMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return <GenericNarrationFallback {...props} />;
  }
  return (
    <div
      data-rename-row="1"
      className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-1 text-xs italic text-text-muted"
    >
      <RotateCw aria-hidden className="size-3.5 shrink-0 not-italic opacity-60" />
      <span>workspace renamed</span>
      <code className="not-italic rounded bg-bg-elevated px-1 font-mono text-text-secondary">
        #{meta.old_name}
      </code>
      <span aria-hidden className="not-italic">→</span>
      <code className="not-italic rounded bg-bg-elevated px-1 font-mono text-text-primary">
        #{meta.new_name}
      </code>
    </div>
  );
}

// ─── Registry ──────────────────────────────────────────────────────────

/**
 * Per-subtype renderer registry. TypeScript narrows this to
 * `Record<SystemSubtype, SystemMessageRenderer>` — missing keys break
 * typecheck. Adding a new subtype to `SYSTEM_SUBTYPES` in shared forces
 * a corresponding entry here before the build passes.
 *
 * PR-1 baseline: existing custom cards (mention_cc / thread_summary /
 * session_cleared) and the existing collapsible narration treatment
 * (onboarding / child_context / thread_anchor) are wired up. The
 * remaining current subtypes (channel_context / schedule_fire / rename /
 * task_*) point at `GenericNarrationFallback` and will be replaced one
 * by one in subsequent PRs (PR-2..PR-6).
 */
const systemMessageRenderers: Record<SystemSubtype, SystemMessageRenderer> = {
  // P0 (PR-2): task event row reads enriched metadata; legacy rows
  // (no actor / task_title / task_message_id metadata) fall back to
  // muted narration without the structured chip/pill presentation.
  task_create: TaskEventRow,
  task_claim: TaskEventRow,
  task_unclaim: TaskEventRow,
  task_status: TaskEventRow,
  // P0 (PR-3): inline audit row + RotateCcw icon (no longer a toast).
  session_cleared: SessionClearedCard,
  // P1 (PR-4): flat banner with left warning accent + actionable pills.
  schedule_fire: ScheduleFireBanner,
  // P1 (PR-5): unified context-card series — shared chrome (left
  // accent line + kind tag + source chip + collapsible body), color
  // per kind. Each subtype renderer parses its enriched metadata and
  // falls back to a tagged single-line muted row when the row predates
  // PR-5's metadata enrichment.
  channel_context: ChannelContextCard,
  child_context: ChildContextCard,
  thread_anchor: ThreadAnchorCard,
  // P2 (PR-6): minor polish (badge, icon).
  // P2 (PR-6): minor polish — onboarding gets an explicit badge in
  // its collapsible header; rename reads `{old_name, new_name}` and
  // draws a compact `↻ #old → #new` audit row (legacy rows without
  // metadata fall through to generic italic narration).
  onboarding: OnboardingRow,
  rename: RenameRow,
  mention_cc: MentionCcCard,
  thread_summary: ThreadSummaryCard,
};
