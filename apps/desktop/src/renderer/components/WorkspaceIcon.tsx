import { User } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';

/**
 * Canonical workspace identity icon — the single source of truth shared by the
 * sidebar rail (`WorkspacesPanel`) and every workspace-filter dropdown
 * (`SearchPanel`, `ArchivedChannelsPanel`) so a workspace reads identically
 * everywhere instead of each surface hand-rolling its own glyph (#task:1192).
 *
 * - regular workspace → a serif `W` carrying the theme-neutral
 *   `data-workspace-icon` hook. Every theme paints it as a filled square poster
 *   badge (`text-base` here is only the unthemed fallback — the themes
 *   override the glyph to 11px). Layout/size stays here; identity painting lives
 *   in the theme (#task:1160).
 * - DM workspace → the bound agent's avatar (DMs are 1:1 with an agent), so the
 *   row reads as "talking to @x" instead of a generic person glyph.
 * - DM fallback (agent not yet resolved / list still loading) → the neutral
 *   `User` glyph in the same box.
 *
 * `size` (px, default 16) is the single layout knob — it drives the avatar,
 * the `User` fallback, and the `W` box uniformly, so a consumer that needs the
 * icon to match a smaller control glyph (e.g. the task filter-bar triggers at
 * 14px) scales all three branches together instead of one drifting from the
 * rest (#task:1437).
 */
export function WorkspaceIcon({
  kind,
  dmAgentId,
  agentsById,
  dmAgentAvatarUrls,
  size = 16,
}: {
  kind: 'regular' | 'dm';
  dmAgentId: string | null;
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Optional — only read for the DM branch. Regular callers (e.g. a search
   *  result row with no agent context) can omit it. */
  dmAgentAvatarUrls?: ReadonlyMap<string, string | null>;
  /** Square edge in px for all three branches. Default 16 (rail / search /
   *  archived panels). */
  size?: number;
}): JSX.Element {
  const dmAgent =
    kind === 'dm' && dmAgentId ? agentsById?.get(dmAgentId) ?? null : null;
  if (dmAgent) {
    return (
      <AgentAvatar
        runtime={dmAgent.runtime}
        size={size}
        avatarObjectUrl={dmAgentAvatarUrls?.get(dmAgent.id) ?? null}
        alt={dmAgent.display_name?.trim() || dmAgent.name}
      />
    );
  }
  if (kind === 'dm')
    return <User style={{ width: size, height: size }} className="shrink-0" />;
  return (
    <span
      data-workspace-icon
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center font-serif text-base font-semibold leading-none"
    >
      W
    </span>
  );
}
