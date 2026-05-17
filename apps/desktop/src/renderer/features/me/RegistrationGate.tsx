import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { validateAvatarFile } from '@silverhand/shared';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AvatarPickerButton } from '@/components/AvatarPickerButton';
import { useRegisterUser, useUploadAvatar } from './hooks';

/**
 * Full-screen registration gate. Renders BEFORE the app shell mounts
 * whenever `/api/me` returns `{ registration_required: true }` — i.e.
 * no `users` row + no `app_settings.viewer_user_id` exists yet.
 *
 * Contract (locked design):
 *   - The user picks a permanent `name` (used for `@mentions`, search,
 *     audit trails). Decided here, never editable later.
 *   - `display_name` is optional; defaults to the registered `name`
 *     server-side and remains editable via Settings → Profile after
 *     registration.
 *   - `avatar` is also optional. The file is held client-side as a
 *     local preview during registration; once `POST /api/register`
 *     succeeds we upload it via `POST /api/me/avatar`. Upload failure
 *     does NOT block entry to the app — the user just retries from
 *     Settings → Profile.
 *
 * `suggestedName` comes from the server (`/api/me`'s
 * `RegistrationRequired` shape) so the input is never empty on first
 * paint. Same shape every call (`user-<4hex>`); user is free to
 * overwrite.
 *
 * No marketing copy: the gate's job is to block the shell, get three
 * fields, and step out of the way.
 */
export interface RegistrationGateProps {
  suggestedName: string;
}

export function RegistrationGate({ suggestedName }: RegistrationGateProps): JSX.Element {
  const register = useRegisterUser();
  const uploadAvatar = useUploadAvatar();

  const [name, setName] = useState(suggestedName);
  const [displayName, setDisplayName] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus + select-all on mount so the user can type a name
  // immediately or arrow into the suggested one.
  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  // Local-preview avatar via FileReader. Uploaded only after
  // registration succeeds.
  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const onPickAvatar = (file: File) => {
    const validation = validateAvatarFile(file);
    if (validation) {
      setAvatarFile(null);
      setError(
        `${validation.message} You can continue now and retry from Settings -> Profile.`,
      );
      return;
    }
    setError(null);
    setAvatarFile(file);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await register.mutateAsync({
        name: name.trim(),
        display_name:
          displayName.trim().length > 0 ? displayName.trim() : undefined,
      });
      // Upload avatar best-effort. If this fails the user is already
      // in the app — Settings → Profile is the recovery path.
      if (avatarFile) {
        try {
          await uploadAvatar.mutateAsync({ file: avatarFile });
        } catch (err) {
          const apiErr = err as { body?: string; message?: string };
          let parsed: { error?: string } = {};
          try {
            parsed = JSON.parse(apiErr.body ?? '{}');
          } catch {
            // not JSON — fall through.
          }
          setError(
            `Account created, but avatar upload failed: ${
              parsed.error ?? apiErr.message ?? 'please retry from Settings -> Profile'
            }. Retry from Settings -> Profile.`,
          );
        }
      }
      // App.tsx re-renders against the resolved UserDto (no longer
      // the `registration_required` shape) and replaces the gate
      // with the shell — no nav needed.
    } catch (err) {
      const apiErr = err as { body?: string; message?: string };
      let parsed: { error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(apiErr.body ?? '{}');
      } catch {
        // not JSON — fall through.
      }
      if (parsed.code === 'name_taken') {
        setError(`The name "${name.trim()}" is already taken.`);
      } else if (parsed.code === 'already_registered') {
        // Race: another window registered first. The next /api/me
        // refetch will return the resolved UserDto and App.tsx will
        // unmount this gate. Surface a soft message in the meantime.
        setError('A viewer is already registered — reloading…');
      } else {
        setError(parsed.error ?? apiErr.message ?? 'Could not register.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const trimmedName = name.trim();
  const canSubmit =
    !submitting
    && trimmedName.length >= 2
    && trimmedName.length <= 32
    // Must mirror RegisterUserInputSchema (packages/shared/src/api/dto.ts)
    // and MENTION_RE: alpha-first, then letters / digits / dash / underscore.
    && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmedName);

  return (
    <main
      className="grid h-screen w-screen place-items-center bg-bg-base px-6 py-14 text-text-primary"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[420px] rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <header className="mb-5 flex flex-col gap-1.5">
          <h1 className="text-base font-semibold leading-tight">
            Create your account
          </h1>
          <p className="text-xs leading-relaxed text-text-muted">
            The name is permanent. Display name and avatar can be changed
            later in Settings.
          </p>
        </header>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reg-name">Name</Label>
            <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-bg-floating focus-within:ring-2 focus-within:ring-border-focus">
              <span className="grid w-9 place-items-center border-r border-border bg-bg-row-hover font-mono text-sm text-text-muted">
                @
              </span>
              <input
                ref={nameInputRef}
                id="reg-name"
                value={name}
                onChange={e => setName(e.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="flex-1 bg-transparent px-3 py-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
                placeholder="your-name"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reg-display">Display name</Label>
            <Input
              id="reg-display"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Avatar</Label>
            <div className="flex items-center gap-3">
              <AvatarPickerButton
                size={40}
                label={avatarFile ? 'Edit' : 'Add'}
                onPick={onPickAvatar}
                disabled={submitting}
                ariaLabel={avatarFile ? 'Change avatar' : 'Add avatar'}
                className="border border-border"
              >
                <span className="grid size-full place-items-center bg-bg-row-hover text-xs font-semibold text-text-muted">
                  {avatarPreview ? (
                    // eslint-disable-next-line jsx-a11y/img-redundant-alt
                    <img
                      src={avatarPreview}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    (displayName || name || 'Y').slice(0, 1).toUpperCase()
                  )}
                </span>
              </AvatarPickerButton>
              {avatarFile ? (
                <button
                  type="button"
                  onClick={() => setAvatarFile(null)}
                  disabled={submitting}
                  className="text-[11px] text-text-muted underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <footer className="mt-6 flex flex-col gap-2">
          <Button
            type="submit"
            disabled={!canSubmit}
            className="w-full justify-center"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Confirming…
              </>
            ) : (
              'Confirm'
            )}
          </Button>
          {error ? (
            <p className="text-xs text-status-error">{error}</p>
          ) : null}
        </footer>
      </form>
    </main>
  );
}
