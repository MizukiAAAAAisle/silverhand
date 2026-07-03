import { useState } from 'react';
import {
  AtSign,
  CheckCircle2,
  ChevronRight,
  Pencil,
  RotateCcw,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import {
  type ConversationMemberChangeMetadata,
  type SessionClearedMetadata,
  readConversationMemberChangeMetadata,
  readRenameMetadata,
  readSessionClearedMetadata,
} from '@silverhand/shared';
import { useMessage } from '@/features/messages/hooks';
import { formatUserDisplayName } from '@/lib/current-user';
import { Markdown } from '@/components/chat/Markdown';
import {
  type RendererProps,
  GenericNarrationFallback,
  firstLine,
  useUserResolver,
} from './shared';

// ─── mention_cc card ───────────────────────────────────────────────────

/**
 * Compact render for `mention_cc` system messages: source line
 * (user · workspace · conversation) plus the original message body.
 * The verbose imperative wrap stays in `message.content` for the
 * agent's stdin only.
 */
export function MentionCcCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
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
  const sourceConversationId =
    typeof meta['source_conversation_id'] === 'string'
      ? (meta['source_conversation_id'] as string)
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
  const userResolver = useUserResolver();
  const sourceUserLabel =
    sourceFromKind === 'user' || fetched?.message.from_kind === 'user'
      ? formatUserDisplayName(
          sourceFromUserId ?? fetched?.message.from_user_id,
          userResolver,
        )
      : 'user';

  // Secondary nav affordance: after the D-flip, the `mention_external`
  // notification primary-jumps to this local DM (where we are right
  // now). The source channel link below restores the legacy "back to
  // source" path so the user can still see the surrounding context.
  // No message anchor — `onOpenConversationRef` only takes a
  // conversation id; landing in the source conversation is the
  // intended scope.
  const canJumpSource = !!(sourceConversationId && onOpenConversationRef);
  const handleOpenSource = canJumpSource
    ? () => onOpenConversationRef!(sourceConversationId!)
    : null;
  const sourceLocationLabel = channelName
    ? conversationTitle
      ? `#${channelName} · ${conversationTitle}`
      : `#${channelName}`
    : conversationTitle ?? null;

  return (
    <div className="border-l-2 border-accent/60 bg-bg-floating/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <AtSign className="size-3.5" />
        <span>
          mentioned by{' '}
          <span className="text-text-secondary">{sourceUserLabel}</span>
          {sourceLocationLabel ? (
            <>
              {' in '}
              {handleOpenSource ? (
                <button
                  type="button"
                  onClick={handleOpenSource}
                  className="text-text-secondary underline-offset-2 hover:text-accent hover:underline"
                  data-mention-cc-source="1"
                >
                  {sourceLocationLabel}
                </button>
              ) : (
                <span className="text-text-secondary">{sourceLocationLabel}</span>
              )}
            </>
          ) : null}
        </span>
      </div>
      {original ? (
        <div className="text-text-primary">
          <Markdown
            content={original}
            conversationRefsById={conversationRefsById}
            onOpenConversationRef={onOpenConversationRef}
            channelsByName={channelsByName}
            onOpenChannelRef={onOpenChannelRef}
            humansByName={humansByName}
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
export function SessionClearedCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  const meta = readSessionClearedMetadata(message.metadata);
  if (meta) return <SessionClearedRow meta={meta} />;
  return (
    <div
      className="flex items-center gap-2 px-4 py-1 text-text-muted"
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
          humansByName={humansByName}
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
  const userResolver = useUserResolver();
  const actorLabel = meta.actor_user_id
    ? `@${formatUserDisplayName(meta.actor_user_id, userResolver)}`
    : 'a user';
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-1 text-text-muted"
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

// ─── thread_summary card ───────────────────────────────────────────────

/**
 * Compact render for `thread_summary` system messages — emitted to the
 * parent channel when a thread is closed. The summary itself is
 * markdown (often headings + lists + code), so we surface it as a
 * left-aligned card with full markdown rendering rather than the
 * centered-italic narration treatment that suits one-liners.
 */
export function ThreadSummaryCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
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
      <div className="text-text-primary">
        <Markdown
          content={summary}
          conversationRefsById={conversationRefsById}
          onOpenConversationRef={onOpenConversationRef}
          channelsByName={channelsByName}
          onOpenChannelRef={onOpenChannelRef}
          humansByName={humansByName}
        />
      </div>
    </div>
  );
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

export function OnboardingRow({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
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
        'group flex w-full items-start gap-2 px-2 py-1 text-left text-text-muted ' +
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
            humansByName={humansByName}
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
// audit row (`✎ workspace renamed old → new`) so the prose body
// (which exists for the agent-stdin imperative wrap) doesn't have
// to be the user-visible surface. Legacy rows without metadata fall
// through to generic narration.

export function RenameRow(props: RendererProps): JSX.Element {
  const meta = readRenameMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return <GenericNarrationFallback {...props} />;
  }
  // `scope` splits a workspace rename (broadcast to every channel) from a
  // single channel rename (#task:1108/1109). Channel titles are freeform
  // (spaces / CJK), so the `#` name sigil is dropped for them; workspace
  // names stay `#`-prefixed since they're name-addressable. Legacy rows
  // lack `scope` → schema default 'workspace' preserves the original
  // rendering. The names render as plain inline text (old = muted, new =
  // emphasised) — the earlier `<code>` chips read as visual noise in the
  // stream (@shiki feedback msg `otnb0ykIuDaNTtoC`).
  const isConversation = meta.scope === 'conversation';
  const namePrefix = isConversation ? '' : '#';
  return (
    <div
      data-rename-row="1"
      className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-1 text-text-muted"
    >
      <Pencil aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span>{isConversation ? 'channel renamed' : 'workspace renamed'}</span>
      <span className="text-text-secondary">
        {namePrefix}
        {meta.old_name}
      </span>
      <span aria-hidden>→</span>
      <span className="font-medium text-text-primary">
        {namePrefix}
        {meta.new_name}
      </span>
    </div>
  );
}

// ─── conversation_member_added / _removed row ───────────────────────────

/**
 * One renderer for both member-change events so add and remove read
 * identically (same chrome / centered narration / @-label treatment) —
 * only the icon, verb, and preposition swap off `subtype`. Before this,
 * remove had no structured renderer and fell through to the generic
 * markdown fallback, rendering the raw `@actor removed @member …` text as
 * italic with a pink auto-linked mention — visibly different from add
 * (shiki hYkvtpZXDsU3PEkb).
 */
export function ConversationMemberChangeRow(props: RendererProps): JSX.Element {
  const meta = readConversationMemberChangeMetadata(
    (props.message.metadata ?? null) as Record<string, unknown> | null,
  );
  if (!meta) {
    return <GenericNarrationFallback {...props} />;
  }
  const removed = meta.subtype === 'conversation_member_removed';
  const Icon = removed ? UserMinus : UserPlus;
  return (
    <div
      data-conversation-member-change={removed ? 'removed' : 'added'}
      className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-1 text-text-muted"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      <span className="text-text-secondary">
        {participantLabel({
          kind: meta.actor_kind,
          name: meta.actor_name,
          displayName: meta.actor_display_name,
        })}
      </span>
      <span>{removed ? 'removed' : 'added'}</span>
      <span className="font-medium text-text-primary">
        {participantLabel({
          kind: meta.member_kind,
          name: meta.member_name,
          displayName: meta.member_display_name,
        })}
      </span>
      <span>{removed ? 'from this conversation' : 'to this conversation'}</span>
    </div>
  );
}

function participantLabel(input: {
  kind: ConversationMemberChangeMetadata['actor_kind']
    | ConversationMemberChangeMetadata['member_kind'];
  name: string;
  displayName: string | null;
}): string {
  if (input.kind === 'system') return 'system';
  const handle = `@${input.name}`;
  const display = input.displayName?.trim();
  return display && display !== input.name ? `${display} ${handle}` : handle;
}
