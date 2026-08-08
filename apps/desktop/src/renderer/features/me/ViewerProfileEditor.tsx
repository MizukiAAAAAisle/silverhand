import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Loader2, User as UserIcon } from 'lucide-react';
import {
  validateAvatarFile,
  type UserDto,
} from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { AVATAR_PX } from '@/components/avatar-scale';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { primaryAction } from '@/features/common/PrimaryAction';
import { readDisplayNameDraft } from '@/features/common/display-name';
import { useUpdateProfile, useUploadAvatar, useViewerAvatarObjectUrl } from './hooks';

/**
 * The viewer's own profile editor — the single writing surface for
 * `/api/me`.
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
 * ## Shape: identity summary, then a labelled form
 *
 * Top block is read-only identity (avatar, display name, `@handle`);
 * below the rule is the form, one labelled field per row. The summary
 * shows the PERSISTED name, not the draft — it is how the viewer appears
 * to everyone else, so it may not preview an unsaved edit.
 *
 * ## Saving: one action for the form, the avatar apart from it
 *
 * shiki 2026-08-06:「我希望 saved 是整体一个动作」+「avatar 是独立的没
 * 问题。其他的保持整体」. So:
 *   - Every writable text field is a local draft until `Save Profile`,
 *     which submits them together. Today that is `display_name` alone,
 *     but the button is the form's action, not the field's — a second
 *     writable column joins this submit rather than growing its own
 *     control. `InlineText`'s per-field pencil/Save is deliberately gone
 *     from this surface (it remains right for the agent profile cards,
 *     where each section is edited on its own).
 *   - Picking an image IS the avatar commit: the OS file dialog is
 *     already an explicit act, and staging bytes for a later Save would
 *     make the one Save straddle two endpoints (`PATCH /api/me` +
 *     `POST /api/me/avatar`) and therefore able to half-succeed. Keeping
 *     the avatar out of the form makes Save exactly one row update, so
 *     "all or nothing" holds by construction with no new endpoint
 *     (@Cindy / @Alice 2026-08-06). New writable fields keep that
 *     property only while they land on the `users` row.
 *
 * ## Not on this surface
 *   - `Email` / `VERIFIED` from shiki's reference layout: `UserDto`
 *     carries no email, and address verification does not exist as a
 *     flow — email is credential-plane state (`user_auth_identities`),
 *     deliberately excluded from the profile read model (@Alice
 *     2026-08-06; shiki:「email 先不做」).
 *   - Clearing the avatar. `DELETE /api/me/avatar` stays live in the
 *     backend (shiki:「保留 backend api,前端先去掉消费」) but has no
 *     entry point here: picking a new image is the whole avatar
 *     interaction, and a second control under a 56px square costs more
 *     attention than the action is worth (shiki:「把头像下面那个 remove
 *     去掉」).
 *   - The `@handle`, as a form row. It cannot be changed, so a permanent
 *     read-only field would spend a labelled row on a value the identity
 *     summary above already shows (shiki 2026-08-06:「UserName 不可改,
 *     先移除」). It comes back with the field's own edit story, if it ever
 *     gets one.
 */
export function ViewerProfileEditor({ user }: { user: UserDto }): JSX.Element {
  const update = useUpdateProfile();
  const upload = useUploadAvatar();
  const avatarObjectUrl = useViewerAvatarObjectUrl();
  const nameFieldId = useId();
  const nameErrorId = useId();

  // `null` = pristine, i.e. "whatever the server says". Not seeded from
  // the dto, so a name changed on another device flows straight through
  // while untouched, and no effect has to guess whether a draft is worth
  // keeping (#task:1846).
  const [draftName, setDraftName] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nameValue = draftName ?? user.display_name;
  // The shared schema decides, and nothing else does: the field carries
  // NO `maxLength`. The DOM attribute counts raw input, the schema counts
  // the trimmed value, so a cap of 64 would cut a pasted `"  <64
  // chars>  "` down to 62 and save that silently — a client-side rewrite,
  // worse than the 400 it was meant to prevent (@Cindy 2026-08-06). Over
  // length is reported like any other rejection, below.
  const nameDraft = readDisplayNameDraft(draftName, user.display_name);
  const canSave = nameDraft.kind === 'ready' && !update.isPending;
  // Shown, not just disabled: the offending character is invisible in
  // the field, so a dead button would leave the viewer with nothing to
  // go on. Pristine / blank / unchanged stay silent — the field itself
  // says those.
  const nameRejection = nameDraft.kind === 'rejected' ? nameDraft.message : null;

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

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (nameDraft.kind !== 'ready' || update.isPending) return;
    setSaveError(null);
    try {
      await update.mutateAsync({ display_name: nameDraft.value });
      // Back to pristine: the fresh dto is now the field's value, so the
      // button disables itself without a second source of truth.
      setDraftName(null);
    } catch (err) {
      setSaveError(formatProfileSaveError(err));
    }
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Escape discards the draft — the counterpart of Enter submitting
    // through the form. Neither blur nor navigation saves.
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraftName(null);
      setSaveError(null);
    }
  };

  const hasAvatar = user.avatar_url != null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <AvatarPickerButton
            size={AVATAR_PX['3xl']}
            label={hasAvatar ? 'Edit' : 'Add'}
            onPick={file => void onPickAvatar(file)}
            disabled={upload.isPending}
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
          <div className="min-w-0">
            <p className="truncate font-serif text-base font-semibold leading-tight text-text-primary">
              {user.display_name}
            </p>
            <p className="truncate font-mono text-xs text-text-muted">
              @{user.name}
            </p>
          </div>
        </div>
        {avatarError ? (
          <p
            role="alert"
            className="text-[length:var(--text-meta)] leading-snug text-error"
            data-testid="human-avatar-error"
          >
            {avatarError}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={event => void onSubmit(event)}
        className="flex flex-col gap-4 border-t border-border-subtle pt-5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameFieldId}>Display Name</Label>
          <Input
            id={nameFieldId}
            value={nameValue}
            disabled={update.isPending}
            aria-invalid={nameRejection ? true : undefined}
            aria-describedby={nameRejection ? nameErrorId : undefined}
            onChange={event => setDraftName(event.target.value)}
            onKeyDown={onNameKeyDown}
          />
          {nameRejection ? (
            <p id={nameErrorId} role="alert" className="text-xs text-error">
              {nameRejection}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!canSave}
            {...primaryAction('self-start')}
          >
            {update.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Save Profile
          </Button>
          {saveError ? (
            <p role="alert" className="text-xs text-error">
              {saveError}
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/**
 * Map a failed `PATCH /api/me` to a one-line user-facing message. Only
 * the arms a viewer can act on are named; everything else keeps the
 * status code so a report is diagnosable.
 */
export function formatProfileSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === 'backend_unreachable') {
      return 'Server unreachable. Check the connection and try again.';
    }
    switch (err.status) {
      case 400:
        return 'This display name was rejected. Try a different one.';
      case 401:
        return 'Sign-in expired. Reload the app and try again.';
      default:
        return `Failed to save profile (HTTP ${err.status}).`;
    }
  }
  return 'Failed to save profile.';
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
