import type { AgentDto } from '@silverhand/shared';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { useNav } from '@/router';

interface MentionProps {
  /** The handle as it appeared in the source text (without `@`). */
  name: string;
  /** Resolved agent — undefined when the name doesn't match any known
   *  agent (typo, deleted agent, or just a stray "@word"). */
  agent: AgentDto | undefined;
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
export function Mention({ name, agent, conversationId }: MentionProps): JSX.Element {
  const nav = useNav();

  if (!agent) {
    return <span className="text-text-muted">@{name}</span>;
  }
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
        title={`@${agent.name}`}
      >
        @{label}
      </button>
    </AgentInfoPopover>
  );
}
