import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { MemberDto } from "@silverhand/shared";
import { UserAvatar } from "@/components/user-avatar";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { useUsersById } from "@/features/users/hooks";
import { AgentAvatar } from "@/components/agent-avatar";

export function memberPreviewCapacity(
  width: number,
  canAdd: boolean,
): { columns: number; members: number } {
  const columns = Math.max(1, Math.floor((width + 8) / 40));
  return { columns, members: columns * 2 - (canAdd ? 1 : 0) };
}

export function ChannelMembersPreview({
  members,
  avatarUrls,
  canAdd,
  onOpen,
  onAdd,
}: {
  members: readonly MemberDto[];
  avatarUrls: Map<string, string | null>;
  canAdd: boolean;
  onOpen: () => void;
  onAdd: () => void;
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!element) return;

    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const capacity = memberPreviewCapacity(width, canAdd);
  const preview = members.slice(0, capacity.members);
  const usersById = useUsersById();
  const humanSources = useMemo(
    () =>
      members.flatMap((member) =>
        member.kind === "human"
          ? [
              {
                id: member.user_id,
                avatar_url: member.avatar_url ?? usersById.get(member.user_id)?.avatar_url ?? null,
              },
            ]
          : [],
      ),
    [members, usersById],
  );
  const humanAvatarUrls = useUserAvatarObjectUrls(humanSources);

  return (
    <div ref={container}>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${capacity.columns}, 32px)` }}
      >
        {preview.map((member) => (
          <button
            key={member.kind === "agent" ? `agent:${member.agent_id}` : `human:${member.user_id}`}
            type="button"
            onClick={onOpen}
            title={member.display_name || member.name}
            aria-label={`View member ${member.display_name || member.name}`}
            className="size-8"
          >
            {member.kind === "agent" ? (
              <AgentAvatar
                runtime={member.runtime}
                size={32}
                className="border-(length:--border-avatar-width) border-border-avatar"
                avatarObjectUrl={avatarUrls.get(member.agent_id) ?? null}
                alt={member.display_name || member.name}
              />
            ) : (
              <UserAvatar
                size={32}
                className="border-(length:--border-avatar-width) border-border-avatar"
                avatarObjectUrl={humanAvatarUrls.get(member.user_id) ?? null}
                alt={member.display_name || member.name}
              />
            )}
          </button>
        ))}
        {canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add member"
            title="Add member"
            className="flex size-8 items-center justify-center bg-bg-hover border-dashed border-(length:--border-avatar-width) border-border-avatar text-text-secondary hover:text-text-primary transition-colors"
          >
            <Plus className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
