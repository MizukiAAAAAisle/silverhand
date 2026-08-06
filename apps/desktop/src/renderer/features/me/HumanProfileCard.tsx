import dayjs from 'dayjs';
import { Lock, Pencil, User as UserIcon } from 'lucide-react';
import type { UserDto } from '@silverhand/shared';
import { useNav } from '@/router';
import {
  MetadataList,
  ProfileSection,
} from '@/features/common/ProfileSummarySections';
import { persistSettingsSection } from '@/features/settings/settings-section';
import {
  isBackendUnreachable,
  isUpdateRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from './hooks';
import { useUserAvatarObjectUrl } from '@/features/users/avatar-hooks';
import { canEditUserProfile } from './permissions';

interface HumanProfileCardProps {
  /** The user to render. v1 always passes the viewer's own dto; v2
   *  multi-human will pass arbitrary users. */
  user: UserDto;
}

/**
 * Human profile card — read-only for every user, including the viewer.
 *
 * Editing display name and avatar moved to Settings > Account (shiki
 * 2026-08-06:「现在这个交互不符合大部分的 IM 直觉,很多用户找不到。放到
 * account 中会更好」, #task:1845). This card therefore mounts NO write
 * surface at all: no picker, no inline input, no `/api/me` mutation
 * hooks. `/api/me` still has exactly one long-lived ownership site
 * (`ViewerProfileEditor`); it just lives where people look for their own
 * profile.
 *
 * What stays here is directory information — identity as others see it,
 * plus the created/updated/id metadata. On the viewer's own card the
 * Identity header carries a route to the editor instead of a pencil, so
 * arriving here with intent to edit is not a dead end.
 *
 * Cross-user editing was never possible: `PATCH /api/me` and the avatar
 * routes key off `requireViewerUserId(c)`. `canEditUserProfile` now gates
 * only the wayfinding affordance.
 */
export function HumanProfileCard({ user }: HumanProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  const isOwnProfile = canEditUserProfile(viewerForPermissions, user);
  // Multi-human: pick the avatar resolver by viewer match so visiting
  // another human's profile renders THEIR avatar, not the viewer's. Self
  // continues to use the viewer-cached path (works even before /api/users
  // hydrates).
  const isSelf =
    viewerForPermissions
    && !('registration_required' in viewerForPermissions)
    && viewerForPermissions.id === user.id;
  const viewerAvatar = useViewerAvatarObjectUrl();
  const otherAvatar = useUserAvatarObjectUrl({ userId: isSelf ? null : user.id });
  const avatarObjectUrl = isSelf ? viewerAvatar : otherAvatar;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {!isOwnProfile ? <ReadOnlyNotice /> : null}

      <ProfileSection
        title="Identity"
        titleAdornment={isOwnProfile ? <EditInSettingsButton /> : null}
      >
        <div className="flex items-start gap-4">
          <span data-avatar-ground className="grid size-14 place-items-center overflow-hidden rounded-none border border-border-subtle">
            {avatarObjectUrl ? (
              // eslint-disable-next-line jsx-a11y/img-redundant-alt
              <img
                src={avatarObjectUrl}
                alt={user.display_name || user.name}
                className="size-full object-cover"
              />
            ) : (
              <UserIcon className="size-7 text-text-muted" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-serif text-lg font-semibold leading-tight text-text-primary">
              {user.display_name || user.name}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
              <span className="font-mono">@{user.name}</span>
              <Lock className="size-3" />
              <span>name is permanent</span>
            </div>
          </div>
        </div>
      </ProfileSection>

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
 * that this card no longer has. Aiming Settings at Account is a
 * persisted-section write plus `toSettings()`, because settings sections
 * have no URL slot.
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
      className="inline-flex items-center gap-1 rounded-[var(--control-radius)] px-1 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text-primary"
      title="Edit in Settings"
    >
      <Pencil className="size-3" />
      Edit in Settings
    </button>
  );
}

/**
 * Single-source-of-truth read-only message for another human's profile.
 * Mirrors the agent equivalent — no `@<id>` substitution because there is
 * no users-by-id lookup yet.
 */
function ReadOnlyNotice(): JSX.Element {
  return (
    <p
      role="note"
      className="text-xs text-text-muted"
      data-testid="human-profile-readonly-notice"
    >
      Only this user can edit their profile.
    </p>
  );
}
