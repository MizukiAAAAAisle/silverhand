import { useEffect, useId, useState, type FormEvent } from "react";
import { Loader2, UserRound } from "lucide-react";
import { validateAvatarFile } from "@silverhand/shared";
import { AvatarPickerButton } from "@/components/avatar-picker-button";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { primaryAction } from "@/components/common/primary-action";
import { rejectDisplayName } from "@/features/identity/display-name";
import { nameFormatMessage } from "@/features/naming/use-name-availability";

export interface ProfileSetupValues {
  displayName: string;
  username: string;
  avatar: File | null;
}

export interface ProfileSetupFormProps {
  pending: boolean;
  error: string | null;
  onSubmit: (values: ProfileSetupValues) => void;
  onRetry?: () => void;
}

export function ProfileSetupForm({
  pending,
  error,
  onSubmit,
  onRetry,
}: ProfileSetupFormProps): JSX.Element {
  const id = useId();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!avatar) {
      setAvatarUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatar);
    setAvatarUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatar]);

  const displayNameError = submitted ? rejectDisplayName(displayName.trim()) : null;
  const usernameError = submitted
    ? username.trim()
      ? nameFormatMessage("agent", username.trim())
      : "Username is required."
    : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setSubmitted(true);
    if (
      rejectDisplayName(displayName.trim()) ||
      !username.trim() ||
      nameFormatMessage("agent", username.trim())
    ) {
      return;
    }
    onSubmit({ displayName: displayName.trim(), username: username.trim(), avatar });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-base px-6 py-14 text-text-primary">
      <form
        onSubmit={submit}
        data-modal-shell
        data-popover-frame="info"
        className="flex w-full max-w-105 flex-col gap-5 bg-bg-floating p-6 shadow-modal"
      >
        <h1 className="text-lg font-semibold">Set up your profile</h1>
        <div className="flex items-center gap-3">
          <AvatarPickerButton
            size={56}
            label={avatar ? "Edit" : "Add"}
            ariaLabel="Choose profile photo"
            disabled={pending}
            onPick={(file) => {
              const validation = validateAvatarFile(file);
              setAvatarError(validation?.message ?? null);
              if (!validation) {
                setAvatar(file);
              }
            }}
          >
            <span data-avatar-ground className="grid size-full place-items-center">
              {avatarUrl ? (
                <img src={avatarUrl} alt="Profile preview" className="size-full object-cover" />
              ) : (
                <UserRound className="size-6 text-text-muted" />
              )}
            </span>
          </AvatarPickerButton>
          <div className="flex flex-col gap-1">
            <span className="text-sm">
              Profile photo <span className="text-xs text-text-muted">Optional</span>
            </span>
            {avatar ? (
              <button
                type="button"
                disabled={pending}
                className="self-start text-xs text-text-muted hover:text-text-primary focus-outline"
                onClick={() => {
                  setAvatar(null);
                  setAvatarError(null);
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
        {avatarError ? (
          <p role="alert" className="text-xs text-error">
            {avatarError}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-display-name`} required>
            Display name
          </Label>
          <Input
            id={`${id}-display-name`}
            autoFocus
            autoComplete="name"
            value={displayName}
            disabled={pending}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={!!displayNameError}
            aria-describedby={displayNameError ? `${id}-display-error` : undefined}
          />
          {displayNameError ? (
            <p id={`${id}-display-error`} role="alert" className="text-xs text-error">
              {displayNameError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-username`} required>
            Username
          </Label>
          <Input
            id={`${id}-username`}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            disabled={pending}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={!!usernameError}
            aria-describedby={usernameError ? `${id}-username-error` : undefined}
          />
          {usernameError ? (
            <p id={`${id}-username-error`} role="alert" className="text-xs text-error">
              {usernameError}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        ) : null}
        {onRetry ? (
          <Button type="button" onClick={onRetry} {...primaryAction("w-full")}>
            Retry
          </Button>
        ) : (
          <Button type="submit" disabled={pending} {...primaryAction("w-full")}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Continue
          </Button>
        )}
      </form>
    </main>
  );
}
