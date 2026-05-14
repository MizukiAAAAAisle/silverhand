import { useState, type ComponentType } from 'react';
import { AtSign, CheckCircle2, ChevronRight, Eraser } from 'lucide-react';
import {
  type MessageDto,
  type SystemSubtype,
  resolveSubtype,
} from '@silverhand/shared';
import { useMessage } from '@/features/messages/hooks';
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

// ─── session_cleared card ──────────────────────────────────────────────

function SessionClearedCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: RendererProps): JSX.Element {
  return (
    <div className="mx-4 my-1.5 rounded-md border border-error/25 bg-error/5 px-3 py-2">
      <div className="flex items-start gap-2 text-xs text-text-secondary">
        <Eraser className="mt-0.5 size-3.5 shrink-0 text-error" />
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
  // P0 (PR-2): becomes a task event row.
  task_create: GenericNarrationFallback,
  task_claim: GenericNarrationFallback,
  task_unclaim: GenericNarrationFallback,
  task_status: GenericNarrationFallback,
  // P0 (PR-3): becomes inline audit row.
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
