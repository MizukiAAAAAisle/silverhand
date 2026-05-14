import { useState } from 'react';
import { AtSign, CheckCircle2, ChevronRight, Eraser } from 'lucide-react';
import type { MessageDto } from '@silverhand/shared';
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
 * System messages (onboarding, join/leave, child summaries) render as
 * a centered italic narration line — IM-convention so they don't read
 * as messages from an unnamed participant.
 *
 * Onboarding (and similarly long subtypes like child_summary, thread_anchor)
 * collapse to one line by default and expand on click. The subtype lives
 * in `message.metadata.subtype`; for backward compatibility with messages
 * inserted before metadata existed, we also fall back to detecting the
 * onboarding template by content prefix.
 */
export function SystemMessage({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: SystemMessageProps): JSX.Element {
  const subtype = readSubtype(message.metadata) ?? inferSubtype(message.content);
  const collapsible = COLLAPSIBLE_SUBTYPES.has(subtype ?? '');
  const [expanded, setExpanded] = useState(false);

  if (subtype === 'mention_cc') {
    return (
      <MentionCcCard
        message={message}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        channelsByName={channelsByName}
        onOpenChannelRef={onOpenChannelRef}
      />
    );
  }

  if (subtype === 'thread_summary') {
    return (
      <ThreadSummaryCard
        message={message}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        channelsByName={channelsByName}
        onOpenChannelRef={onOpenChannelRef}
      />
    );
  }

  if (subtype === 'session_cleared') {
    return (
      <SessionClearedCard
        message={message}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        channelsByName={channelsByName}
        onOpenChannelRef={onOpenChannelRef}
      />
    );
  }

  if (!collapsible) {
    // join/leave/etc. are typically a single line — no need for a toggle.
    // Centered + italic so they read as narration, not a participant message.
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

  return (
    <button
      type="button"
      onClick={() => setExpanded(v => !v)}
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
          // Keep collapsed view as plain text — markdown leaks block elements
          // that break a single-line clamp.
          <span>{firstLine(message.content)}</span>
        )}
      </div>
    </button>
  );
}

const COLLAPSIBLE_SUBTYPES = new Set([
  'onboarding',
  'child_summary',
  'child_context',
  'thread_anchor',
]);

function readSubtype(metadata: MessageDto['metadata']): string | null {
  if (!metadata) return null;
  const v = (metadata as Record<string, unknown>)['subtype'];
  return typeof v === 'string' ? v : null;
}

/** Backfill subtype from content for messages inserted before PR2's
 *  metadata tagging. Match the prefixes literally produced by
 *  `provision.ts` and `routes.ts`. */
function inferSubtype(content: string): string | null {
  if (content.startsWith('Onboarding task (system-triggered):')) return 'onboarding';
  if (content.startsWith('Inherited context from parent session')) return 'child_context';
  if (content.startsWith('Sub-session ')) return 'child_summary';
  return null;
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

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
}: {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const channelName = typeof meta['source_workspace_name'] === 'string'
    ? (meta['source_workspace_name'] as string)
    : null;
  const conversationTitle = typeof meta['source_conversation_title'] === 'string'
    ? (meta['source_conversation_title'] as string)
    : null;
  const inlineOriginal = typeof meta['source_message_content'] === 'string'
    ? (meta['source_message_content'] as string)
    : null;
  const sourceMessageId = typeof meta['source_message_id'] === 'string'
    ? (meta['source_message_id'] as string)
    : null;
  const sourceFromKind = typeof meta['source_from_kind'] === 'string'
    ? (meta['source_from_kind'] as string)
    : null;
  const sourceFromUserId = typeof meta['source_from_user_id'] === 'string'
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
          mentioned by <span className="text-text-secondary">{sourceUserLabel}</span>
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

function SessionClearedCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
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

/**
 * Compact render for `thread_summary` system messages — emitted to the
 * parent channel when a thread is closed. The summary itself is
 * markdown (often headings + lists + code), so we surface it as a
 * left-aligned card with full markdown rendering rather than the
 * centered-italic narration treatment that suits one-liners. Header
 * line shows "Thread closed: <title> · by <actor>"; body renders the
 * raw `summary` from metadata so we don't have to re-parse the prose
 * prefix that's also baked into `content`.
 */
function ThreadSummaryCard({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
}: {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
}): JSX.Element {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const threadTitle = typeof meta['thread_title'] === 'string'
    ? (meta['thread_title'] as string)
    : null;
  const closedBy = typeof meta['closed_by'] === 'string'
    ? (meta['closed_by'] as string)
    : null;
  const summary = typeof meta['summary'] === 'string'
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
