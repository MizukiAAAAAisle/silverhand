import {
  forwardRef,
  useEffect,
  useState,
  type InputHTMLAttributes,
} from 'react';
import dayjs from 'dayjs';
import { Lock, User as UserIcon } from 'lucide-react';
import { validateAvatarFile, type UserDto } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { cn } from '@/lib/cn';
import {
  MetadataList,
  ProfileSection,
} from '@/features/common/ProfileSummarySections';
import {
  useClearAvatar,
  useUpdateProfile,
  useUploadAvatar,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from './hooks';
import { canEditUserProfile } from './permissions';

interface HumanProfileCardProps {
  /** The user to render. v1 always passes the viewer's own dto; v2
   *  multi-human will pass arbitrary users. */
  user: UserDto;
}

/**
 * Human profile card. Section structure mirrors `AgentProfileCard` —
 * Identity + Metadata — but drops the Capabilities section because
 * humans have no runtime/model surface. Identity hosts the avatar
 * picker and the editable display-name input; Metadata is the tight
 * `<dl>` of created/updated/id.
 *
 * Backend contract reused as-is from the registration / Settings →
 * Profile flow:
 *   - `PATCH /api/me` only accepts `display_name`. Names are permanent.
 *   - `POST/DELETE /api/me/avatar` for avatar upload / clear.
 *   - All three are keyed off `requireViewerUserId(c)`, so a non-self
 *     edit attempt 403s server-side. The renderer-side gate
 *     (`canEditUserProfile`) is a UI-affordance hide, not the security
 *     boundary.
 */
export function HumanProfileCard({ user }: HumanProfileCardProps): JSX.Element {
  const { data: viewer } = useViewerUser();
  const canEdit = canEditUserProfile(viewer, user);
  const update = useUpdateProfile();
  const upload = useUploadAvatar();
  const clear = useClearAvatar();
  // For v1 single-human, the only reachable user IS the viewer, so the
  // viewer hook resolves the right blob. v2 multi-human will need a
  // separate `useUserAvatarObjectUrl(userId)` hook for non-self rows;
  // we keep the prop boundary clean by routing through a single
  // resolved url here.
  const avatarObjectUrl = useViewerAvatarObjectUrl();

  const [displayName, setDisplayName] = useState(user.display_name);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // Reseed when switching users (v2) or on remote profile updates.
  useEffect(() => {
    setDisplayName(user.display_name);
  }, [user.display_name, user.id]);

  // Clear avatar error when switching users — stale "Avatar must be
  // PNG…" text shouldn't follow from one profile to the next.
  useEffect(() => {
    setAvatarError(null);
  }, [user.id]);

  const onCommitDisplayName = () => {
    const next = displayName.trim();
    if (!next) {
      // Empty display_name means "back to default = name". The PATCH
      // service rejects an empty string, so we just snap the local
      // draft back to the canonical value rather than firing a doomed
      // request.
      setDisplayName(user.display_name);
      return;
    }
    if (next === user.display_name) return;
    update.mutate({ display_name: next });
  };

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

      <ProfileSection title="Identity">
        <div className="flex items-center gap-4">
          {canEdit ? (
            <div className="flex flex-col gap-1.5">
              <AvatarPickerButton
                size={56}
                label={hasAvatar ? 'Edit' : 'Add'}
                onPick={file => void onPickAvatar(file)}
                disabled={avatarPending}
                ariaLabel={hasAvatar ? 'Change avatar' : 'Add avatar'}
                className="border border-border-subtle"
              >
                <span className="grid size-full place-items-center bg-bg-row-hover">
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
            <span className="grid size-14 place-items-center overflow-hidden rounded-none border border-border-subtle bg-bg-row-hover">
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
              <GhostInput
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                onBlur={onCommitDisplayName}
                placeholder={user.name}
                className="font-serif text-lg font-semibold leading-tight"
              />
            ) : (
              <div className="px-2 font-serif text-lg font-semibold leading-tight text-text-primary">
                {user.display_name || user.name}
              </div>
            )}
            <div className="mt-1 flex items-center gap-1.5 px-2 text-xs text-text-muted">
              <span className="font-mono">@{user.name}</span>
              <Lock className="size-3" />
              <span>name is permanent</span>
            </div>
            {canEdit && hasAvatar ? (
              <div className="mt-1 px-2">
                <button
                  type="button"
                  onClick={() => void onClearAvatar()}
                  disabled={avatarPending}
                  className="text-[11px] text-text-muted underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Remove avatar
                </button>
              </div>
            ) : null}
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
 * lookup yet; once we have one we can swap in the actual creator name.
 * Until then the line is intentionally generic.
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
 * message. Mirrors `formatAvatarMutationError` in
 * `EditableAgentAvatar` but localized for the user surface — 403 is
 * effectively impossible here in v1 (the route is keyed off the
 * viewer's principal), but we still cover it for v2.
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

const GhostInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-panel-control="ghost-input"
      className={cn(
        'w-full rounded-sm border border-transparent bg-transparent px-2 py-1 text-sm text-text-primary placeholder:text-text-muted',
        'transition-colors hover:border-border-subtle hover:bg-bg-base/40',
        'focus:border-border focus:bg-bg-floating focus:outline-none focus:ring-2 focus:ring-border-focus',
        className,
      )}
      {...props}
    />
  ),
);
GhostInput.displayName = 'GhostInput';
