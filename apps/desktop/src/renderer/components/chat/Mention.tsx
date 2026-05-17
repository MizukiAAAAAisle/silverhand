import { User } from 'lucide-react';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
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
  const label = human.display_name?.trim() || human.name;
  const trigger = (
    <span
      className="inline-flex items-center gap-0.5 rounded px-1 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
      aria-label={`@${human.name}`}
      tabIndex={0}
      data-mention-kind="human"
      data-mention-id={human.id}
    >
      @{label}
    </span>
  );
  return (
    <HoverPopover
      trigger={trigger}
      isContentReady
      content={
        <div className="space-y-2">
          <div className="flex items-start gap-2.5">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-muted">
              <User className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-text-primary">
                {label}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                @{human.name}
              </div>
            </div>
          </div>
          <span className="inline-flex rounded bg-bg-elevated px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-muted">
            Human
          </span>
        </div>
      }
    />
  );
}
