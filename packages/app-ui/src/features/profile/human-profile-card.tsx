import { ProfileMessageActivity } from "@/features/profile/profile-message-activity";
import dayjs from "dayjs";
import { Clock, IdCard } from "lucide-react";
import type { UserDto } from "@silverhand/shared";
import { ProfileFact, ProfileFactBand } from "@/features/profile/profile-summary-sections";
import { useHumanAvatar } from "./use-human-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useProfileHeroSize } from "@/features/profile/use-profile-hero-size";
import "@/features/agents/components/agent-profile-hero.css";

interface HumanProfileCardProps {
  user: UserDto;
}

export function HumanProfileCard({ user }: HumanProfileCardProps): JSX.Element {
  const avatarObjectUrl = useHumanAvatar(user.id);
  const { profileRef, compactHero } = useProfileHeroSize();

  return (
    <div ref={profileRef} data-profile-layout className="mx-auto flex flex-col gap-6">
      <section
        aria-label="Human profile"
        data-compact={compactHero}
        className="agent-profile-hero"
        style={{ alignItems: "center" }}
      >
        <UserAvatar
          size={compactHero ? AVATAR_PX.profileCompact : AVATAR_PX.profile}
          avatarObjectUrl={avatarObjectUrl}
          alt={user.display_name || user.name}
        />
        <div className="agent-profile-hero-fields min-w-0 flex-1">
          <div className="agent-profile-hero-name wrap-break-word font-serif font-semibold text-text-primary">
            {user.display_name || user.name}
          </div>
          <div className="wrap-break-word font-mono text-xs text-text-muted">@{user.name}</div>
        </div>
      </section>

      <ProfileFactBand>
        <ProfileFact icon={<Clock className="size-3.5" />} label="Created">
          <span
            className="font-medium text-text-primary"
            title={dayjs(user.created_at).format("YYYY-MM-DD HH:mm:ss")}
          >
            {dayjs(user.created_at).format("YYYY-MM-DD")}
          </span>
        </ProfileFact>
        <ProfileFact icon={<IdCard className="size-3.5" />} label="ID">
          <span className="font-mono">{user.id}</span>
        </ProfileFact>
      </ProfileFactBand>

      <ProfileMessageActivity subject={{ kind: "user", id: user.id }} />
    </div>
  );
}
