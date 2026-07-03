import { useMemo, useState, type ComponentType } from 'react';
import { ChevronRight } from 'lucide-react';
import type { MessageDto, UserDto } from '@silverhand/shared';
import { useUsersById, makeUserNameResolver } from '@/features/users/hooks';
import { Markdown } from '@/components/chat/Markdown';
import type { ConversationReference } from '@/components/chat/ConversationRef';
import type { ChannelReference } from '@/components/chat/ChannelRef';

/**
 * Shared hook: build a resolver that maps `user_id` → display name.
 *
 * Used by every SystemMessage subtype renderer that surfaces a `user_id`
 * (quotes, audit lines, task events, …). Lives here so each renderer
 * doesn't repeat the `useUsersById + makeUserNameResolver` pair (multi-human
 * audit 2026-06-03 #task:857 P0.10). React Query memoizes the underlying
 * /api/users query so subscribing from multiple sub-components is free.
 */
export function useUserResolver(): ReturnType<typeof makeUserNameResolver> {
  const usersById = useUsersById();
  return useMemo(() => makeUserNameResolver(usersById), [usersById]);
}

/**
 * Props every per-subtype renderer receives. Mirrors `SystemMessageProps`
 * minus the public-facing prop name; carrying the same shape keeps refs
 * (channel / conversation links, mention pills) wired through markdown
 * inside any renderer.
 */
export interface RendererProps {
  message: MessageDto;
  conversationRefsById?: Map<string, ConversationReference>;
  onOpenConversationRef?: (id: string) => void;
  channelsByName?: Map<string, ChannelReference | null>;
  onOpenChannelRef?: (channelId: string) => void;
  humansByName?: Map<string, UserDto>;
}

export type SystemMessageRenderer = ComponentType<RendererProps>;

// ─── Generic fallback ──────────────────────────────────────────────────

/** IM-convention narration for legacy/unknown subtypes and any current
 *  subtype that doesn't have a custom renderer yet (PR-2..PR-6 will
 *  progressively replace fallthrough entries with bespoke components). */
export function GenericNarrationFallback({
  message,
  conversationRefsById,
  onOpenConversationRef,
  channelsByName,
  onOpenChannelRef,
  humansByName,
}: RendererProps): JSX.Element {
  return (
    <div className="px-4 py-1.5 text-center italic text-text-muted">
      <Markdown
        content={message.content}
        conversationRefsById={conversationRefsById}
        onOpenConversationRef={onOpenConversationRef}
        channelsByName={channelsByName}
        onOpenChannelRef={onOpenChannelRef}
        humansByName={humansByName}
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
  humansByName,
}: RendererProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={
        'group flex w-full items-start gap-1 px-2 py-1 text-left text-text-muted ' +
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
            humansByName={humansByName}
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

export function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}
