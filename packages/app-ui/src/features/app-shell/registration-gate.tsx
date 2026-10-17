import { ServerAddressControl, ServerConnectionStatus } from "./server-address-control";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SpinnerIcon } from "@/icons";
import { AUTH_HANDLE_TAKEN_CODE, suggestParticipantNameFromEmail } from "@silverhand/shared";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { nameFormatMessage } from "@/features/identity/use-name-availability";
import { cn } from "@/lib/cn";
import { AuthSplitLayout } from "@/components/brand/auth-split-layout";
import { ExternalLink, PRIVACY_POLICY_URL } from "@/features/legal/legal-links";
import { DraftAvatarCard } from "@/features/avatar-maker/components/draft-avatar-card";
import { useDraftAvatar } from "@/features/avatar-maker/hooks/use-draft-avatar";
import { useLoginUser, useSignupUser, useUploadDraftViewerAvatar } from "../session/hooks";

export interface RegistrationGateProps {
  signupEnabled: boolean;
  preferLogin?: boolean;
  autoFocus?: boolean;
  connectionReady?: boolean;
  connectionStatus?: string;
  connectionChecking?: boolean;
  showServerAddress?: boolean;
  onRetry?: () => void;
}

type AuthMode = "signup" | "login";

/** A submit failure that belongs to ONE field rather than to the form. Only the
 *  handle has such a case today (`handle_taken`): every other auth failure is
 *  either about the email+password PAIR or about the whole body, and pinning
 *  those to a single input would point the user at the wrong place. */
interface AuthError {
  field: "handle" | null;
  message: string;
}

/**
 * Full-screen desktop auth gate. The renderer never receives the
 * `user_token`: submit calls an IPC method, main performs `/auth/*`,
 * persists the main-owned 0600 local session file, and returns only
 * the resolved user.
 *
 * Signup asks for the handle explicitly (#task:1830). It is the one field here
 * that can never be corrected afterwards, which is why it carries a note, is
 * required, sits directly under the email it is prefilled from, and stops
 * following that email the moment the user edits it.
 */
export function RegistrationGate({
  signupEnabled,
  preferLogin = false,
  autoFocus = true,
  connectionReady = true,
  connectionStatus,
  connectionChecking,
  showServerAddress = false,
  onRetry,
}: RegistrationGateProps): JSX.Element {
  const signup = useSignupUser();
  const login = useLoginUser();
  const uploadDraftAvatar = useUploadDraftViewerAvatar();
  const draftAvatar = useDraftAvatar();
  const [mode, setMode] = useState<AuthMode>(signupEnabled && !preferLogin ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<AuthError | null>(null);
  const [editingServer, setEditingServer] = useState(false);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const handleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!signupEnabled) setMode("login");
  }, [signupEnabled]);

  useEffect(() => {
    if (autoFocus) emailInputRef.current?.focus();
  }, [autoFocus]);

  const submitting = signup.isPending || login.isPending;
  const emailTrimmed = email.trim();
  const handleTrimmed = handle.trim();
  const displayNameTrimmed = displayName.trim();
  const isSignup = mode === "signup";
  // Shared format seam — never a second regex or a second wording (#task:1827).
  // `agent` is the naming-era label for the participant/mention grammar, which
  // is exactly what a handle is, so the words match create-agent and rename.
  const handleFormatMessage = nameFormatMessage("agent", handleTrimmed);
  const canSubmit =
    connectionReady &&
    !editingServer &&
    !submitting &&
    emailTrimmed.length > 0 &&
    password.length >= (isSignup ? 8 : 1) &&
    (!isSignup ||
      (handleTrimmed.length > 0 && handleFormatMessage === null && password === confirmPassword));

  /** Prefill the handle from the email until the user takes the field over. A
   *  dirty flag rather than "empty means follow": typing a handle and then going
   *  back to finish the email must not overwrite the deliberate choice. */
  const onEmailChange = (next: string) => {
    setEmail(next);
    if (!handleEdited) setHandle(suggestParticipantNameFromEmail(next.trim()));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      if (isSignup) {
        await signup.mutateAsync({
          email: emailTrimmed,
          password,
          name: handleTrimmed,
          display_name: displayNameTrimmed.length > 0 ? displayNameTrimmed : undefined,
        });
        uploadDraftAvatar(draftAvatar);
      } else {
        await login.mutateAsync({ email: emailTrimmed, password });
      }
    } catch (err) {
      const authError = authErrorMessage(err);
      setError(authError);
      // There is no availability probe by design, so a taken handle can only
      // come back after submit. Put the cursor where the fix has to happen and
      // preselect the value — everything else the user typed stays untouched.
      if (authError.field === "handle") {
        handleInputRef.current?.focus();
        handleInputRef.current?.select();
      }
    }
  };

  const formError = error?.field === null ? error.message : null;
  const handleError = handleFormatMessage ?? (error?.field === "handle" ? error.message : null);

  return (
    <AuthSplitLayout>
      <form
        onSubmit={onSubmit}
        // Sits on the open page, not in a card: the brand column already frames
        // the screen, so a second container only adds weight.
        data-auth-form
        className="w-full max-w-90"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <header className="mb-7 flex flex-col gap-1.5">
          <h1 className="text-3xl font-semibold tracking-tight">
            {isSignup ? "Sign up" : "Log in"}
          </h1>
          <p className="text-sm text-text-muted">
            {isSignup ? "Create your account." : "Welcome back."}
          </p>
        </header>

        <div className="flex flex-col gap-4">
          {isSignup ? <DraftAvatarCard draft={draftAvatar} disabled={submitting} /> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              ref={emailInputRef}
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
            />
          </div>

          {isSignup ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-handle" required>
                Username
              </Label>
              <Input
                ref={handleInputRef}
                id="auth-handle"
                value={handle}
                onChange={(e) => {
                  setHandleEdited(true);
                  setHandle(e.target.value);
                  // A field-scoped error describes the value that was submitted.
                  // Since a `handle_taken` failure focuses AND selects this
                  // input, the next keystroke replaces exactly that value — and
                  // a stale "already taken" under a freshly typed handle reads
                  // as "this one is taken too".
                  if (error?.field === "handle") setError(null);
                }}
                autoComplete="username"
                spellCheck={false}
                placeholder="username"
              />
              {/* One line, always occupied: the problem when there is one, the
                  irreversibility note otherwise. Same height either way, so
                  nothing moves — and no reserved empty row. */}
              <p
                className={cn("text-xs leading-4", handleError ? "text-error" : "text-text-muted")}
              >
                {handleError ?? "Your username is permanent and cannot be changed."}
              </p>
            </div>
          ) : null}

          {isSignup ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-display">Display name</Label>
              <Input
                id="auth-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                placeholder="Optional"
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder={isSignup ? "At least 8 characters" : "Password"}
            />
          </div>

          {isSignup ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-confirm">Confirm password</Label>
              <Input
                id="auth-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="Repeat password"
              />
            </div>
          ) : null}
        </div>

        <footer className="mt-7 flex flex-col gap-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full justify-center"
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <SpinnerIcon className="size-3.5 animate-spin" />
                {isSignup ? "Creating..." : "Signing in..."}
              </>
            ) : isSignup ? (
              "Create account"
            ) : (
              "Log in"
            )}
          </Button>
          {isSignup && password.length > 0 && password !== confirmPassword ? (
            // `text-error` — the theme token. `text-status-error`, which these
            // two lines used, is not defined in any theme, so both rendered in
            // the default text colour.
            <p className="text-xs text-error">Passwords do not match.</p>
          ) : null}
          {formError ? <p className="text-xs text-error">{formError}</p> : null}
          {signupEnabled ? (
            <p className="text-sm text-text-muted">
              {isSignup ? "Already have an account?" : "No account?"}{" "}
              <button
                type="button"
                className="font-medium text-text-primary underline underline-offset-3 hover:text-text-secondary focus-outline"
                onClick={() => {
                  setMode(isSignup ? "login" : "signup");
                  setError(null);
                }}
              >
                {isSignup ? "Log in" : "Sign up"}
              </button>
            </p>
          ) : null}
        </footer>

        <p className="mt-6 text-xs text-text-muted">
          <ExternalLink
            href={PRIVACY_POLICY_URL}
            className="underline underline-offset-3 hover:text-text-secondary"
          >
            Privacy Policy
          </ExternalLink>
        </p>

        {showServerAddress && (
          <div className="mt-10 border-t border-border-subtle pt-4">
            <ServerAddressControl
              onRetry={onRetry}
              onEditingChange={setEditingServer}
              disabled={submitting}
            />
            <ServerConnectionStatus
              status={connectionStatus}
              checking={connectionChecking}
              onRetry={onRetry}
            />
          </div>
        )}
      </form>
    </AuthSplitLayout>
  );
}

/**
 * Classify a submit failure into (field, message). The field is what decides
 * WHERE the message is rendered: a conflict on one unique field has to appear
 * under that field, while a credential failure describes the email+password pair
 * and belongs in the form footer.
 */
function authErrorMessage(err: unknown): AuthError {
  const apiErr = err as { body?: string; message?: string };
  let parsed: { error?: string; error_code?: string; code?: string } = {};
  try {
    parsed = JSON.parse(apiErr.body ?? "{}");
  } catch {
    // not JSON — fall through.
  }
  if (parsed.error_code === AUTH_HANDLE_TAKEN_CODE || parsed.code === AUTH_HANDLE_TAKEN_CODE) {
    return { field: "handle", message: "This username is already taken." };
  }
  if (parsed.error_code === "auth_failed" || parsed.code === "auth_failed") {
    return { field: null, message: "Email or password is incorrect." };
  }
  if (parsed.error === "invalid input") {
    return { field: null, message: "Check the email and password fields." };
  }
  return {
    field: null,
    message: parsed.error ?? apiErr.message ?? "Authentication failed.",
  };
}
