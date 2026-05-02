import { useState } from 'react';
import { AtSign, ChevronRight } from 'lucide-react';
import type { MessageDto } from '@silverhand/shared';
import { useMessage } from '@/features/messages/hooks';
import { Markdown } from './Markdown';

interface SystemMessageProps {
  message: MessageDto;
}

/**
 * System messages (onboarding, join/leave, child summaries) render as
 * a left-aligned secondary line — not a centered italic banner.
 *
 * Onboarding (and similarly long subtypes like child_summary, thread_anchor)
 * collapse to one line by default and expand on click. The subtype lives
 * in `message.metadata.subtype`; for backward compatibility with messages
 * inserted before metadata existed, we also fall back to detecting the
 * onboarding template by content prefix.
 */
export function SystemMessage({ message }: SystemMessageProps): JSX.Element {
  const subtype = readSubtype(message.metadata) ?? inferSubtype(message.content);
  const collapsible = COLLAPSIBLE_SUBTYPES.has(subtype ?? '');
  const [expanded, setExpanded] = useState(false);

  if (subtype === 'mention_cc') {
    return <MentionCcCard message={message} />;
  }

  if (!collapsible) {
    // join/leave/etc. are typically a single line — no need for a toggle.
    return (
      <div className="px-2 py-1 text-xs text-text-muted">
        <Markdown content={message.content} />
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
          <Markdown content={message.content} />
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
 * (user · #channel · session) plus the original message body.
 * The verbose imperative wrap stays in `message.content` for the
 * agent's stdin only.
 */
function MentionCcCard({ message }: { message: MessageDto }): JSX.Element {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const channelName = typeof meta['source_channel_name'] === 'string'
    ? (meta['source_channel_name'] as string)
    : null;
  const sessionTitle = typeof meta['source_session_title'] === 'string'
    ? (meta['source_session_title'] as string)
    : null;
  const inlineOriginal = typeof meta['source_message_content'] === 'string'
    ? (meta['source_message_content'] as string)
    : null;
  const sourceMessageId = typeof meta['source_message_id'] === 'string'
    ? (meta['source_message_id'] as string)
    : null;
  // Legacy rows (pre-`source_message_content`) fall back to fetching
  // the original message by id. Hook stays disabled when the inline
  // copy is present so we don't pay the round-trip on new rows.
  const { data: fetched } = useMessage(inlineOriginal ? null : sourceMessageId);
  const original = inlineOriginal ?? fetched?.message.content ?? null;

  return (
    <div className="border-l-2 border-accent/60 bg-bg-floating/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
        <AtSign className="size-3.5" />
        <span>
          mentioned by <span className="text-text-secondary">user</span>
          {channelName ? (
            <>
              {' in '}
              <span className="text-text-secondary">#{channelName}</span>
            </>
          ) : null}
          {sessionTitle ? (
            <>
              {' · '}
              <span className="text-text-secondary">{sessionTitle}</span>
            </>
          ) : null}
        </span>
      </div>
      {original ? (
        <div className="text-sm text-text-primary">
          <Markdown content={original} />
        </div>
      ) : (
        <div className="text-xs text-text-muted">(loading original…)</div>
      )}
    </div>
  );
}


