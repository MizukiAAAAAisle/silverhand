import { useState, type ComponentType } from 'react';
import { AtSign, CheckCircle2, ChevronRight, ClipboardCheck, RotateCcw } from 'lucide-react';
import {
  type MessageDto,
  type SessionClearedMetadata,
  type SystemSubtype,
  type TaskStatus,
  type TaskSubtype,
  type TaskSystemMetadata,
  type TaskSystemMetadataPartial,
  readSessionClearedMetadata,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
  resolveSubtype,
} from '@silverhand/shared';
import { useMessage } from '@/features/messages/hooks';
import { useTaskRefContext } from '@/features/tasks/TaskRefContext';
import { formatUserDisplayName } from '@/lib/current-user';
import { Markdown } from './Markdown';
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
  const actorLabel = `@${formatUserDisplayName(meta.actor_user_id) || 'user'}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-1 text-xs text-text-muted"
      data-session-cleared="1"
    >
      <RotateCcw aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span className="text-text-secondary">{actorLabel}</span>
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
  // P1 (PR-4): becomes a flat banner.
  schedule_fire: GenericNarrationFallback,
  // P1 (PR-5): unified context-card series.
  channel_context: GenericNarrationFallback,
  child_context: CollapsibleNarration,
  thread_anchor: CollapsibleNarration,
  // P2 (PR-6): minor polish (badge, icon).
  onboarding: CollapsibleNarration,
  rename: GenericNarrationFallback,
  // KEEP: existing cards untouched.
  mention_cc: MentionCcCard,
  thread_summary: ThreadSummaryCard,
};
