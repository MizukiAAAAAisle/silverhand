import { ProfileMessageActivity } from '@/features/profile/ProfileMessageActivity';
import dayjs from 'dayjs';
import { Pencil } from 'lucide-react';
import type { UserDto } from '@silverhand/shared';
import { useNav } from '@/router';
import { MetadataList, ProfileSection } from '@/features/common/ProfileSummarySections';
import { persistSettingsSection } from '@/features/settings/settings-section';
import { isBackendUnreachable, isUpdateRequired, useViewerUser } from './hooks';
import { useHumanAvatar } from './use-human-avatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { useProfileHeroSize } from '@/features/common/use-profile-hero-size';
import '@/features/agents/agent-profile-hero.css';
import { canEditUserProfile } from './permissions';

interface HumanProfileCardProps {
  user: UserDto;
}

export function HumanProfileCard({ user }: HumanProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  const isOwnProfile = canEditUserProfile(viewerForPermissions, user);
  const avatarObjectUrl = useHumanAvatar(user.id);
  const { profileRef, compactHero } = useProfileHeroSize();

  return (
    <div ref={profileRef} data-profile-layout className="mx-auto flex flex-col gap-6">
      <section aria-label="Human profile" data-compact={compactHero} className="agent-profile-hero">
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
          {isOwnProfile ? (
            <div>
              <EditInSettingsButton />
            </div>
          ) : null}
        </div>
      </section>

      <ProfileMessageActivity subject={{ kind: 'user', id: user.id }} />

      <ProfileSection title="Metadata" muted>
        <MetadataList
          items={[
            {
              label: 'Created',
              value: dayjs(user.created_at).format('YYYY-MM-DD'),
              title: dayjs(user.created_at).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              label: 'Updated',
              value: dayjs(user.updated_at).format('YYYY-MM-DD HH:mm'),
              title: dayjs(user.updated_at).format('YYYY-MM-DD HH:mm:ss'),
            },
            { label: 'User ID', value: user.id, mono: true },
          ]}
        />
      </ProfileSection>
    </div>
  );
}

/**
 * Route to the editor. Occupies the slot the pencil used to hold, and
 * says where it goes — a bare pencil here would promise inline editing
 * that this card no longer has. Aiming Settings at Account is a section
 * write plus `toSettings()`, because settings sections have no URL slot;
 * the write is best-effort in storage but always lands in memory, so the
 * navigation cannot miss Account.
 */
function EditInSettingsButton(): JSX.Element {
  const nav = useNav();
  return (
    <button
      type="button"
      onClick={() => {
        persistSettingsSection('account');
        nav.toSettings();
      }}
      className="inline-flex items-center gap-1 rounded-[var(--control-radius)] px-1 py-0.5 text-[length:var(--text-meta)] text-text-muted transition-colors hover:text-text-primary"
      title="Edit in Settings"
    >
      <Pencil className="size-3" />
      Edit in Settings
    </button>
  );
}
