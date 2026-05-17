import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentInfoPopover } from '@/components/AgentInfoPopover';
import { HumanInfoPopover } from '@/components/HumanInfoPopover';
import { useViewerAvatarObjectUrl } from '@/features/me/hooks';
import { useNav } from '@/router';

interface MentionProps {
  /** The handle as it appeared in the source text (without `@`). */
  name: string;
  /** Resolved agent — undefined when the name doesn't match any known
   *  agent (typo, deleted agent, or just a stray "@word"). */
  agent: AgentDto | undefined;
  /** Avatar URL resolved by the parent's batch hook (Markdown threads
   *  it from the timeline's lifted `agentAvatarUrls`). `undefined` =
   *  no batch context (popover falls back to its own single-agent
   *  fetch). `null` = batched parent looked it up and there's nothing
   *  yet (render the runtime icon, no fetch). `string` = use the
   *  parent's blob URL directly. */
  agentAvatarObjectUrl?: string | null;
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
  agentAvatarObjectUrl,
  human,
  conversationId,
}: MentionProps): JSX.Element {
  if (agent) {
    return (
      <AgentMention
        agent={agent}
        avatarObjectUrl={agentAvatarObjectUrl}
        conversationId={conversationId}
      />
    );
  }

  if (human) {
    return <HumanMention human={human} />;
  }

  return <span className="text-text-muted">@{name}</span>;
}

function AgentMention({
  agent,
  avatarObjectUrl,
  conversationId,
}: {
  agent: AgentDto;
  avatarObjectUrl?: string | null;
  conversationId: string | null;
}): JSX.Element {
  const nav = useNav();

  const label = agent.display_name?.trim() || agent.name;
  return (
    <AgentInfoPopover
      agent={agent}
      conversationId={conversationId}
      trigger="hover"
      avatarObjectUrl={avatarObjectUrl}
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
  // Keep element + classes identical to AgentMention so both mentions
  // share box model, baseline, and focus ring. Clicking @yourself
  // jumps to Settings where the viewer manages their profile (v1
  // invariant: human === viewer).
  return (
    <HumanInfoPopover human={human} trigger="hover" avatarObjectUrl={avatarObjectUrl}>
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
    </HumanInfoPopover>
  );
}
