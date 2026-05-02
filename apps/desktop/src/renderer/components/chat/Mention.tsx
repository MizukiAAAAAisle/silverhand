import type { AgentDto } from '@silverhand/shared';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';

interface MentionProps {
  /** The handle as it appeared in the source text (without `@`). */
  name: string;
  /** Resolved agent — undefined when the name doesn't match any known
   *  agent (typo, deleted agent, or just a stray "@word"). */
  agent: AgentDto | undefined;
  /** Session this mention is rendered inside. Forwarded to the
   *  popover so it can show per-session presence. Null when the
   *  mention isn't tied to a session (legacy paths). */
  sessionId: string | null;
}

/**
 * Inline rendering of an `@handle` reference inside a chat message.
 *
 * Resolved → display the agent's `display_name` (falling back to the
 * handle when display_name is empty), wrapped in a button that opens
 * an `<AgentInfoPopover>` on click.
 *
 * Unresolved → render plain text (no popover) so a stray `@todo` or
 * `@2025` doesn't look like a broken interactive control.
 */
export function Mention({ name, agent, sessionId }: MentionProps): JSX.Element {
  if (!agent) {
    return <span className="text-text-muted">@{name}</span>;
  }
  const label = agent.display_name?.trim() || agent.name;
  return (
    <AgentInfoPopover agent={agent} sessionId={sessionId}>
      <button
        type="button"
        className="rounded px-1 -mx-0.5 font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
        title={`@${agent.name}`}
      >
        @{label}
      </button>
    </AgentInfoPopover>
  );
}
