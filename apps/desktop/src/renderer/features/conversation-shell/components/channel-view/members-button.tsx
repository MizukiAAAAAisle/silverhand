import { Users } from "lucide-react";
import { useConversationMembers } from "@/features/conversations/useConversationMembers";

/**
 * The channel header's Members action, carrying the current member count
 * (shiki 2026-07-28).
 *
 * The count is a DERIVED value of the roster read model, not a second piece of
 * state and not a count endpoint: `useConversationMembers` already returns the
 * full roster under the key `['conversation-members', id]` and already
 * invalidates itself on `conversation_members_changed` / `snapshot_required`, so
 * the number follows every add/remove by any route. The member strip beside this
 * button reads the same key, so this component adds no request of its own.
 *
 * It is the number the modal this opens shows in its own title — the total
 * roster, humans and agents together, viewer included. The strip's `+N` chip
 * counts something else on purpose (it drops the viewer, being about "who else
 * is in this room"), so the two are not interchangeable.
 *
 * An unresolved roster renders NO number rather than `0`: the read is gated on
 * strict conversation membership and does not retry a 403, so `0` would state
 * "nobody is here" when the truth is "not read" (@Alice / @Cindy, 2026-07-28).
 * The box keeps the square footprint of its sibling header actions
 * (`min-w-7`) while the count is absent, and grows by the numeral once it
 * resolves — one settle, not a per-render jitter.
 *
 * This component owns the read so it mounts only where the caller's member gate
 * already holds; a non-member never issues the request that would 403.
 */
export function MembersButton({
  channelId,
  onOpen,
}: {
  channelId: string;
  onOpen: () => void;
}): JSX.Element {
  const membersResult = useConversationMembers(channelId);
  const count = membersResult.status === "resolved" ? membersResult.members.length : null;

  return (
    <button
      type="button"
      data-sticker
      data-sticker-size="md"
      data-sticker-tone="neutral"
      onClick={onOpen}
      aria-label={count === null ? "Members" : `Members (${count})`}
      title="Members"
      data-member-count={count ?? undefined}
      className="flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-[var(--control-radius)] px-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
    >
      <Users className="size-3.5" />
      {count === null ? null : (
        <span className="text-[length:var(--text-meta)] font-medium leading-none tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}
