import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { MemberDto } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";

export function memberPreviewCapacity(
  width: number,
  canAdd: boolean,
): { columns: number; agents: number } {
  const columns = Math.max(1, Math.floor((width + 8) / 40));
  return { columns, agents: columns * 2 - (canAdd ? 1 : 0) };
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
  const agents = members
    .filter((member) => member.kind === "agent")
    .slice(0, capacity.agents);

  return (
    <div ref={container}>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${capacity.columns}, 32px)` }}
      >
        {agents.map((member) => (
          <button
            key={member.agent_id}
            type="button"
            onClick={onOpen}
            title={member.display_name || member.name}
            aria-label={`View member ${member.display_name || member.name}`}
            className="size-8"
          >
            <AgentAvatar
              runtime={member.runtime}
              size={32}
              className="border-(length:--border-avatar-width) border-border-avatar"
              avatarObjectUrl={avatarUrls.get(member.agent_id) ?? null}
              alt={member.display_name || member.name}
            />
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
