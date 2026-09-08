import { User } from "lucide-react";
import type { AgentDto } from "@silverhand/shared";
import { AgentAvatar } from "@/components/AgentAvatar";

/**
 * Canonical workspace identity icon — the single source of truth shared by the
 * sidebar rail (`WorkspacesPanel`) and every workspace-filter dropdown
 * (`SearchPanel`, `ArchivedChannelsPanel`) so a workspace reads identically
 * everywhere instead of each surface hand-rolling its own glyph (#task:1192).
 *
 * OWNERSHIP is the only input (#task:2078). A workspace either belongs to an
 * agent or it does not, and the container kind is that same bit spelled a second
 * way — so asking for both invited a caller to pass a disagreeing pair. The old
 * `kind === 'agent_space' && ownerAgentId` conjunct could not discriminate
 * anything the id alone did not already say.
 *
 * - unowned workspace → a serif `W` carrying the theme-neutral
 *   `data-workspace-icon` hook. Every theme paints it as a filled square poster
 *   badge (`text-base` here is only the unthemed fallback — the themes
 *   override the glyph to 11px). Layout/size stays here; identity painting lives
 *   in the theme (#task:1160).
 * - owned, owner resolved → the owning agent's avatar (ownership is 1:1), so
 *   the row reads as "talking to @x" instead of a generic person glyph.
 * - owned, owner not resolved (directory still loading, or the agent is not
 *   visible to this viewer) → the neutral `User` glyph in the same box. Still an
 *   agent-owned space; only the identity behind it is unknown.
 *
 * `size` (px, default 16) is the single layout knob — it drives the avatar,
 * the `User` fallback, and the `W` box uniformly, so a consumer that needs the
 * icon to match a smaller control glyph (e.g. the task filter-bar triggers at
 * 14px) scales all three branches together instead of one drifting from the
 * rest (#task:1437).
 */
export function WorkspaceIcon({
  ownerAgentId,
  agentsById,
  ownerAgentAvatarUrls,
  size = 16,
}: {
  ownerAgentId: string | null;
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Optional — only read for the owned branch. Callers with no agent context
   *  (e.g. a search result row) can omit it. */
  ownerAgentAvatarUrls?: ReadonlyMap<string, string | null>;
  /** Square edge in px for all three branches. Default 16 (rail / search /
   *  archived panels). */
  size?: number;
}): JSX.Element {
  const ownerAgent = ownerAgentId ? (agentsById?.get(ownerAgentId) ?? null) : null;
  if (ownerAgent) {
    return (
      <AgentAvatar
        runtime={ownerAgent.runtime}
        size={size}
        avatarObjectUrl={ownerAgentAvatarUrls?.get(ownerAgent.id) ?? null}
        alt={ownerAgent.display_name?.trim() || ownerAgent.name}
      />
    );
  }
  if (ownerAgentId) return <User style={{ width: size, height: size }} className="shrink-0" />;
  return (
    <span
      data-workspace-icon
      data-sticker
      data-sticker-tone="workspace"
      data-sticker-no-frame
      data-sticker-flat
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center font-serif text-base font-semibold leading-none"
    >
      W
    </span>
  );
}
