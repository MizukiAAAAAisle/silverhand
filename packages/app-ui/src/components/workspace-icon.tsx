import { UserIcon } from "@/icons";
import type { AgentDto } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";

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
  if (ownerAgentId) return <UserIcon style={{ width: size, height: size }} className="shrink-0" />;
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
      P
    </span>
  );
}
