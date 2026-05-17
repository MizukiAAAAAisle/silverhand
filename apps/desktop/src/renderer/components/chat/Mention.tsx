import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { useViewerAvatarObjectUrl } from '@/features/me/hooks';
import { useNav } from '@/router';
import { HoverPopover } from './HoverPopover';

interface MentionProps {
  /** The handle as it appeared in the source text (without `@`). */
  name: string;
  /** Resolved agent — undefined when the name doesn't match any known
   *  agent (typo, deleted agent, or just a stray "@word"). */
  agent: AgentDto | undefined;
  /** Resolved human user. `users.name` and `agents.name` are globally
   *  unique in the data layer, so this is mutually exclusive with
   *  `agent` unless the invariant is broken upstream. */
  human?: UserDto | undefined;
  /** Conversation this mention is rendered inside. Forwarded to the
   *  popover so it can show per-conversation presence. Null when the
   *  mention isn't tied to a conversation (legacy paths). */
  conversationId: string | null;
}

/**
 * Inline rendering of an `@handle` reference inside a chat message.
 *
 * Resolved → display the agent's `display_name` (falling back to the
 * handle when display_name is empty), wrapped in a button. Hover opens
 * an `<AgentInfoPopover>`; click navigates to the agent detail route.
 *
 * Unresolved → render plain text (no popover) so a stray `@todo` or
 * `@2025` doesn't look like a broken interactive control.
 */
export function Mention({
  name,
  agent,
  human,
  conversationId,
}: MentionProps): JSX.Element {
  if (agent) {
    return <AgentMention agent={agent} conversationId={conversationId} />;
  }

  if (human) {
    return <HumanMention human={human} />;
  }

  return <span className="text-text-muted">@{name}</span>;
}

function AgentMention({
  agent,
  conversationId,
}: {
  agent: AgentDto;
  conversationId: string | null;
}): JSX.Element {
  const nav = useNav();

  const label = agent.display_name?.trim() || agent.name;
  return (
    <AgentInfoPopover
      agent={agent}
      conversationId={conversationId}
      trigger="hover"
    >
      <button
        type="button"
        onClick={event => {
          event.preventDefault();
          nav.toMembers(agent.id);
        }}
        className="rounded px-1 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
        aria-label={`@${agent.name}`}
      >
        @{label}
      </button>
    </AgentInfoPopover>
  );
}

function HumanMention({ human }: { human: UserDto }): JSX.Element {
  // v1 invariant: the only registered human is the viewer themselves
  // (no `/api/users` listing endpoint yet), so the avatar always belongs
  // to the viewer. When multi-human lands, swap to a prop-threaded
  // avatar map keyed by user id.
  const avatarObjectUrl = useViewerAvatarObjectUrl();
  const nav = useNav();
  const label = human.display_name?.trim() || human.name;
  const initial = label.charAt(0).toUpperCase();
  // Keep element + classes identical to AgentMention so both mentions
  // share box model, baseline, and focus ring. Clicking @yourself
  // jumps to Settings where the viewer manages their profile (v1
  // invariant: human === viewer).
  const trigger = (
    <button
      type="button"
      onClick={event => {
        event.preventDefault();
        nav.toSettings();
      }}
      className="rounded px-1 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
      aria-label={`@${human.name}`}
      data-mention-kind="human"
      data-mention-id={human.id}
    >
      @{label}
    </button>
  );
  return (
    <HoverPopover
      trigger={trigger}
      isContentReady
      // Mirror AgentInfoPopover's 80ms hover-open so agent and human
      // mentions feel identical to the pointer. Default 500ms was too
      // slow next to the agent popover.
      openDelayMs={80}
      content={
        <div className="flex items-start gap-3">
          {avatarObjectUrl ? (
            <span className="inline-block size-9 shrink-0 overflow-hidden rounded-full bg-bg-elevated">
              {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
              <img
                src={avatarObjectUrl}
                alt=""
                className="size-full object-cover"
              />
            </span>
          ) : (
            <span
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-sm font-medium text-text-muted"
              aria-hidden
            >
              {initial}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-primary">
              {label}
            </div>
            <div className="truncate font-mono text-xs text-text-muted">
              @{human.name}
            </div>
          </div>
        </div>
      }
    />
  );
}
