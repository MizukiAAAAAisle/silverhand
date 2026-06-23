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
 *   badge (`text-[16px]` here is only the unthemed fallback — the themes
 *   override the glyph to 11px). Layout/size stays here; identity painting lives
 *   in the theme (#task:1160).
 * - DM workspace → the bound agent's avatar (DMs are 1:1 with an agent), so the
 *   row reads as "talking to @x" instead of a generic person glyph.
 * - DM fallback (agent not yet resolved / list still loading) → the neutral
 *   `User` glyph in the same 16px box.
 */
export function WorkspaceIcon({
  kind,
  dmAgentId,
  agentsById,
  dmAgentAvatarUrls,
}: {
  kind: 'regular' | 'dm';
  dmAgentId: string | null;
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Optional — only read for the DM branch. Regular callers (e.g. a search
   *  result row with no agent context) can omit it. */
  dmAgentAvatarUrls?: ReadonlyMap<string, string | null>;
}): JSX.Element {
  const dmAgent =
    kind === 'dm' && dmAgentId ? agentsById?.get(dmAgentId) ?? null : null;
  if (dmAgent) {
    return (
      <AgentAvatar
        runtime={dmAgent.runtime}
        size={16}
        avatarObjectUrl={dmAgentAvatarUrls?.get(dmAgent.id) ?? null}
        alt={dmAgent.display_name?.trim() || dmAgent.name}
      />
    );
  }
  if (kind === 'dm') return <User className="size-4 shrink-0" />;
  return (
    <span
      data-workspace-icon
      className="inline-flex size-4 shrink-0 items-center justify-center font-serif text-[16px] font-semibold leading-none"
    >
      W
    </span>
  );
}
