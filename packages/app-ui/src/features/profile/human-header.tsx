import { MessageSquare } from "lucide-react";
import { ProfileHeaderAction } from "./profile-header-action";
import type { UserDto } from "@silverhand/shared";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { SidePanelHeader } from "@/components/layout/side-panel-header";
import { ProfileHeaderContent } from "@/features/profile/profile-header-content";
import { usePresenceById, presenceDotStatus, humanPresenceText } from "@/features/presence/hooks";
import { useHumanAvatar } from "./use-human-avatar";

export function HumanHeader({
  user,
  compact = false,
  onClose,
  onMessage,
}: {
  user: UserDto;
  compact?: boolean;
  onClose?: () => void;
  onMessage?: () => void;
}): JSX.Element {
  const avatarObjectUrl = useHumanAvatar(user.id);
  const presence = usePresenceById().get(user.id);
  const online = presenceDotStatus(presence?.presence) === "active";
  const content = (
    <ProfileHeaderContent
      compact={compact}
      avatar={
        <UserAvatar
          size={compact ? AVATAR_PX.md : AVATAR_PX.xl}
          avatarObjectUrl={avatarObjectUrl}
          alt={user.display_name || user.name}
        />
      }
      displayName={user.display_name || user.name}
      actions={
        onMessage ? (
          <ProfileHeaderAction
            compact={compact}
            label="Message"
            title={`Message @${user.name}`}
            onClick={onMessage}
          >
            <MessageSquare className="size-3.5" />
          </ProfileHeaderAction>
        ) : undefined
      }
      status={
        <span
          data-status-pip
          className={`size-1.5 shrink-0 self-center rounded-full ${online ? "bg-success" : "bg-text-muted/40"}`}
          title={humanPresenceText(presence?.presence, null, "")}
        />
      }
    />
  );

  return compact ? (
    <SidePanelHeader onClose={onClose}>{content}</SidePanelHeader>
  ) : (
    <header className="agent-header-full">{content}</header>
  );
}
