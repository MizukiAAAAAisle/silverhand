import { useEffect, useId, useState, type FormEvent } from "react";
import { SpinnerIcon, UserIcon } from "@/icons";
import { validateAvatarFile } from "@silverhand/shared";
import { AvatarPickerButton } from "@/components/avatar-picker-button";
import { AVATAR_PX } from "@/components/avatar-scale";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { AuthSplitLayout } from "@/components/brand/auth-split-layout";
import { cn } from "@/lib/cn";
import { rejectDisplayName } from "@/features/identity/display-name";
import { nameFormatMessage } from "@/features/identity/use-name-availability";

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

  const previewName = displayName.trim();
  const previewHandle = username.trim();

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
    <AuthSplitLayout>
      <form
        onSubmit={submit}
        data-auth-form
        className="flex w-full max-w-90 flex-col gap-4"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">Set up your profile</h1>
        <div className="mb-3 flex items-center gap-3">
          <AvatarPickerButton
            size={AVATAR_PX["3xl"]}
            label={avatar ? "Edit" : "Add"}
            ariaLabel="Choose profile photo"
            disabled={pending}
            className="border border-border-subtle"
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
                <UserIcon className="size-7 text-text-muted" />
              )}
            </span>
          </AvatarPickerButton>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p
              className={cn(
                "truncate text-base font-semibold leading-tight",
                previewName ? "text-text-primary" : "text-text-muted",
              )}
            >
              {previewName || "Your name"}
            </p>
            <p className="truncate font-mono text-xs text-text-muted">
              @{previewHandle || "username"}
            </p>
            {avatar ? (
              <button
                type="button"
                disabled={pending}
                className="self-start text-xs text-text-secondary hover:text-text-primary focus-outline"
                onClick={() => {
                  setAvatar(null);
                  setAvatarError(null);
                }}
              >
                Remove photo
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
            placeholder="Ada Lovelace"
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
            placeholder="ada"
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
          <Button type="button" variant="primary" className="mt-2 w-full" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="mt-2 w-full" disabled={pending}>
            {pending ? <SpinnerIcon className="size-4 animate-spin" aria-hidden /> : null}
            Continue
          </Button>
        )}
      </form>
    </AuthSplitLayout>
  );
}
