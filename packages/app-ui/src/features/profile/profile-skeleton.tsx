import { SkeletonBlock as Block, SkeletonRegion as Region } from "@/components/layout/skeleton";
import { useProfileHeroSize } from "./use-profile-hero-size";
import {
  ProfileFact,
  ProfileFactBand,
  PROFILE_SECTION_FRAME_CLASS,
} from "./profile-summary-sections";
import { ClockIcon, ComputerIcon, ProfileCardIcon } from "@/icons";
import { AVATAR_PX } from "@/components/avatar-scale";

export function ProfileSkeleton({ agent = false }: { agent?: boolean }): JSX.Element {
  const { profileRef, compactHero } = useProfileHeroSize();
  const avatarSize = compactHero ? AVATAR_PX.profileCompact : AVATAR_PX.profile;
  return (
    <Region
      label={agent ? "Loading agent" : "Loading profile"}
      className={agent ? "p-3" : "human-profile-content"}
    >
      <div ref={profileRef} data-profile-layout className="mx-auto flex flex-col gap-6">
        <div className="agent-profile-hero" data-compact={compactHero}>
          <div style={{ width: avatarSize, height: avatarSize }} className="shrink-0">
            <div className="size-full rounded-none bg-bg-elevated" />
          </div>
          <div className="agent-profile-hero-fields min-w-0 flex-1">
            <Block className="h-5 w-2/5" />
            <Block className="h-3 w-24" />
            {agent ? <Block className="h-3 w-4/5" /> : null}
          </div>
        </div>
        <ProfileFactBand>
          <ProfileFact icon={<ProfileCardIcon className="size-3.5" />} label="ID">
            <span className="inline-block h-2.5 w-28 max-w-full rounded bg-bg-elevated" />
          </ProfileFact>
          {agent ? (
            <>
              <ProfileFact icon={<ComputerIcon className="size-3.5" />} label="Computer">
                <span className="inline-block h-2.5 w-24 max-w-full rounded bg-bg-elevated" />
              </ProfileFact>
              <ProfileFact
                icon={<span className="size-3.5 rounded bg-bg-elevated" />}
                label="Session"
              >
                <span className="inline-block h-2.5 w-28 max-w-full rounded bg-bg-elevated" />
              </ProfileFact>
            </>
          ) : null}
          <ProfileFact icon={<ClockIcon className="size-3.5" />} label="Created">
            <span className="inline-block h-2.5 w-16 max-w-full rounded bg-bg-elevated" />
          </ProfileFact>
        </ProfileFactBand>
        {agent ? (
          <div className="space-y-3">
            <Block className="h-3 w-24" />
            <div className={`${PROFILE_SECTION_FRAME_CLASS} space-y-2`}>
              <Block className="h-3 w-full" />
              <Block className="h-3 w-4/5" />
              <Block className="h-3 w-2/3" />
            </div>
          </div>
        ) : null}
      </div>
    </Region>
  );
}
