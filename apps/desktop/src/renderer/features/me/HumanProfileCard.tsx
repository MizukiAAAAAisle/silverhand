import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Lock, User as UserIcon } from 'lucide-react';
import { validateAvatarFile, type UserDto } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { AVATAR_PX } from '@/components/avatar-scale';
import {
  MetadataList,
  ProfileSection,
} from '@/features/common/ProfileSummarySections';
import { EditPencilButton } from '@/features/common/EditPencilButton';
import { InlineText } from '@/features/common/InlineText';
import {
  useClearAvatar,
  isBackendUnreachable,
  isUpdateRequired,
  useUpdateProfile,
  useUploadAvatar,
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
 * Human profile card. Section shape mirrors `AgentProfileCard`:
 * Identity holds the editable display-name (Identity-header pencil) +
 * avatar picker + locked handle; Metadata is the tight `<dl>` of
 * created/updated/id. Every edit is explicit (Enter or Save; blur
 * preserves the draft) so a stray click on the page can't silently
 * PATCH — same contract as the agent profile card.
 *
 * Editing display name and avatar for the viewer's own profile lives
 * only on this card; the Settings pane is Account-only (session
 * operations). Keeping one editing surface avoids two long-lived
 * ownership sites for the same `/api/me` capabilities.
 *
 * Backend contract:
 *   - `PATCH /api/me` accepts `display_name` only (names are permanent).
 *   - `POST/DELETE /api/me/avatar` upload / clear.
 *   - All three key off `requireViewerUserId(c)`; a non-self edit
 *     attempt 403s server-side. The renderer-side gate
 *     (`canEditUserProfile`) is a UI-affordance hide, not the security
 *     boundary.
 */
export function HumanProfileCard({ user }: HumanProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  const canEdit = canEditUserProfile(viewerForPermissions, user);
  const update = useUpdateProfile();
  const upload = useUploadAvatar();
  const clear = useClearAvatar();
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

  const [nameEditing, setNameEditing] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // Clear avatar error when switching users — stale "Avatar must be
  // PNG…" text shouldn't follow from one profile to the next.
  useEffect(() => {
    setAvatarError(null);
  }, [user.id]);

  const onPickAvatar = async (file: File): Promise<void> => {
    setAvatarError(null);
    const validation = validateAvatarFile(file);
    if (validation) {
      setAvatarError(validation.message);
      return;
    }
    try {
      await upload.mutateAsync({ file });
    } catch (err) {
      setAvatarError(formatAvatarMutationError(err));
    }
  };

  const onClearAvatar = async (): Promise<void> => {
    setAvatarError(null);
    try {
      await clear.mutateAsync();
    } catch (err) {
      setAvatarError(formatAvatarMutationError(err));
    }
  };

  const avatarPending = upload.isPending || clear.isPending;
  const hasAvatar = user.avatar_url != null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {!canEdit ? <ReadOnlyNotice /> : null}

      <ProfileSection
        title="Identity"
        titleAdornment={
          canEdit ? (
            <EditPencilButton
              onClick={() => setNameEditing(true)}
              ariaLabel="Edit display name"
              hidden={nameEditing}
            />
          ) : null
        }
      >
        {/* `items-start` keeps the avatar column (avatar + Remove +
            optional error) top-aligned with the name column so the name
            input never dips below the avatar's top edge. */}
        <div className="flex items-start gap-4">
          {canEdit ? (
            <div className="flex flex-col items-center gap-1.5">
              <AvatarPickerButton
                size={AVATAR_PX['3xl']}
                label={hasAvatar ? 'Edit' : 'Add'}
                onPick={file => void onPickAvatar(file)}
                disabled={avatarPending}
                ariaLabel={hasAvatar ? 'Change avatar' : 'Add avatar'}
                className="border border-border-subtle"
              >
                <span data-avatar-ground className="grid size-full place-items-center">
                  {avatarObjectUrl ? (
                    // eslint-disable-next-line jsx-a11y/img-redundant-alt
                    <img
                      src={avatarObjectUrl}
                      alt="Your avatar"
                      className="size-full object-cover"
                    />
                  ) : (
                    <UserIcon className="size-7 text-text-muted" />
                  )}
                </span>
              </AvatarPickerButton>
              {hasAvatar ? (
                <button
                  type="button"
                  onClick={() => void onClearAvatar()}
                  disabled={avatarPending}
                  className="text-[11px] text-text-muted underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              ) : null}
              {avatarError ? (
                <p
                  role="alert"
                  className="text-[11px] leading-snug text-error"
                  data-testid="human-avatar-error"
                >
                  {avatarError}
                </p>
              ) : null}
            </div>
          ) : (
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
          )}
          <div className="min-w-0 flex-1">
            {canEdit ? (
              <InlineText
                value={user.display_name}
                ariaLabel="Display name"
                editing={nameEditing}
                onExitEdit={() => setNameEditing(false)}
                className="font-serif text-lg font-semibold leading-tight"
                onCommit={async next => {
                  await update.mutateAsync({ display_name: next });
                }}
              />
            ) : (
              <div className="font-serif text-lg font-semibold leading-tight text-text-primary">
                {user.display_name || user.name}
              </div>
            )}
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

      {update.isError && canEdit ? (
        <div className="text-xs text-error">{String(update.error)}</div>
      ) : null}
    </div>
  );
}

/**
 * Single-source-of-truth read-only message. Mirrors the agent
 * equivalent — no `@<id>` substitution because there is no users-by-id
 * lookup yet.
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

/**
 * Map a failed `/api/me/avatar` mutation to a one-line user-facing
 * message. Mirrors `formatAvatarMutationError` in `EditableAgentAvatar`
 * but localized for the user surface.
 */
export function formatAvatarMutationError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = parseErrorCode(err.body);
    switch (code) {
      case 'avatar_too_large':
        return 'Avatar must be 5 MB or smaller.';
      case 'avatar_unsupported_type':
        return 'Avatar must be a PNG, JPEG, GIF, or WEBP image.';
      case 'avatar_missing':
        return 'Avatar file is empty.';
      case 'avatar_storage_failed':
        return 'Storage backend failed to write the avatar. Try again.';
      default:
        break;
    }
    switch (err.status) {
      case 401:
        return 'Sign-in expired. Reload the app and try again.';
      case 403:
        return 'You no longer have permission to edit this profile.';
      case 404:
        return 'This profile no longer exists.';
      default:
        return `Failed to update avatar (HTTP ${err.status}).`;
    }
  }
  return 'Failed to update avatar.';
}

function parseErrorCode(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}
