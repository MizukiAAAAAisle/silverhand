import { useState } from 'react';
import { Lock, User as UserIcon } from 'lucide-react';
import { validateAvatarFile, type UserDto } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { AVATAR_PX } from '@/components/avatar-scale';
import { EditPencilButton } from '@/features/common/EditPencilButton';
import { InlineText } from '@/features/common/InlineText';
import {
  useClearAvatar,
  useUpdateProfile,
  useUploadAvatar,
  useViewerAvatarObjectUrl,
} from './hooks';

/**
 * The viewer's own display name + avatar editor — the single writing
 * surface for `/api/me`.
 *
 * It lives in Settings > Account (shiki 2026-08-06:「现在这个交互不符合
 * 大部分的 IM 直觉,很多用户找不到。放到 account 中会更好」). It used to be
 * inlined in `HumanProfileCard` on the Members panel; that card is now
 * read-only for every user including the viewer, so the count of
 * long-lived `/api/me` ownership sites is unchanged — only the location
 * moved, to where people look for their own profile.
 *
 * Self-only by construction: the Account pane exists only for the
 * viewer, so there is no permission branch here. Cross-user editing is
 * refused server-side (`requireViewerUserId`), and the read-only view of
 * another human is `HumanProfileCard`'s job.
 *
 * Layout deliberately minimal — no card chrome, no "Profile" heading:
 * an avatar next to a name is self-labelling, and the pane header
 * already says Account.
 *
 * Backend contract:
 *   - `PATCH /api/me` accepts `display_name` only (handles are permanent).
 *   - `POST/DELETE /api/me/avatar` upload / clear.
 */
export function ViewerProfileEditor({ user }: { user: UserDto }): JSX.Element {
  const update = useUpdateProfile();
  const upload = useUploadAvatar();
  const clear = useClearAvatar();
  const avatarObjectUrl = useViewerAvatarObjectUrl();

  const [nameEditing, setNameEditing] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

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
    <div className="flex items-start gap-4">
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
      </div>

      <div className="min-w-0 flex-1">
        {/* The pencil is anchored to the name rather than to a section
            header (there is no section header on this pane), and stays
            in the DOM while editing so the row height doesn't jump. */}
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <InlineText
              value={user.display_name}
              ariaLabel="Display name"
              editing={nameEditing}
              onExitEdit={() => setNameEditing(false)}
              className="font-serif text-base font-semibold leading-tight"
              onCommit={async next => {
                await update.mutateAsync({ display_name: next });
              }}
            />
          </div>
          <EditPencilButton
            onClick={() => setNameEditing(true)}
            ariaLabel="Edit display name"
            hidden={nameEditing}
          />
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
          <span className="font-mono">@{user.name}</span>
          <Lock className="size-3" />
          <span>name is permanent</span>
        </div>
        {avatarError ? (
          <p
            role="alert"
            className="mt-2 text-[11px] leading-snug text-error"
            data-testid="human-avatar-error"
          >
            {avatarError}
          </p>
        ) : null}
        {update.isError ? (
          <p className="mt-2 text-xs text-error">{String(update.error)}</p>
        ) : null}
      </div>
    </div>
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
