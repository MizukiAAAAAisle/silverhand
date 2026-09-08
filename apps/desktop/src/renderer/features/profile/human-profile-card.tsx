import { ProfileMessageActivity } from "@/features/profile/ProfileMessageActivity";
import dayjs from "dayjs";
import type { UserDto } from "@silverhand/shared";
import { MetadataList, ProfileSection } from "@/features/profile/profile-summary-sections";
import { useHumanAvatar } from "./use-human-avatar";
import { UserAvatar } from "@/components/UserAvatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useProfileHeroSize } from "@/features/profile/use-profile-hero-size";
import "@/features/agent-shell/components/agent-profile-hero.css";

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
          <div className="agent-profile-hero-name break-words font-serif font-semibold text-text-primary">
            {user.display_name || user.name}
          </div>
          <div className="break-words font-mono text-xs text-text-muted">@{user.name}</div>
        </div>
      </section>

      <ProfileMessageActivity subject={{ kind: "user", id: user.id }} />

      <ProfileSection title="Metadata" muted>
        <MetadataList
          items={[
            {
              label: "Created",
              value: dayjs(user.created_at).format("YYYY-MM-DD"),
              title: dayjs(user.created_at).format("YYYY-MM-DD HH:mm:ss"),
            },
            {
              label: "Updated",
              value: dayjs(user.updated_at).format("YYYY-MM-DD HH:mm"),
              title: dayjs(user.updated_at).format("YYYY-MM-DD HH:mm:ss"),
            },
            { label: "User ID", value: user.id, mono: true },
          ]}
        />
      </ProfileSection>
    </div>
  );
}
