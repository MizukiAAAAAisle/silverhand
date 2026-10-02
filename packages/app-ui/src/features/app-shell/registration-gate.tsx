import { ServerAddressControl } from "./server-address-control";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, LogIn, UserPlus } from "lucide-react";
import { AUTH_HANDLE_TAKEN_CODE, suggestParticipantNameFromEmail } from "@silverhand/shared";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { nameFormatMessage } from "@/features/identity/use-name-availability";
import { cn } from "@/lib/cn";
import { AuthSplitLayout } from "@/components/brand/auth-split-layout";
import { useLoginUser, useSignupUser } from "../session/hooks";

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
        // Same dialog identity as the other boot gates — see UpdateRequiredGate
        // for the per-theme rationale (#task:1833). Not forza6-only: studio-light
        // also drops the 1px frame by its own `[data-modal-shell]` rule.
        data-auth-form
        data-modal-shell
        data-popover-frame="info"
        className="w-full max-w-105 rounded-md border border-border bg-bg-floating p-6 shadow-modal"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {showServerAddress && (
          <ServerAddressControl
            status={connectionStatus}
            checking={connectionChecking}
            onRetry={onRetry}
            onEditingChange={setEditingServer}
            disabled={submitting}
          />
        )}
        {!signupEnabled && <h1 className="mb-5 text-lg font-semibold">Log in</h1>}

        {signupEnabled ? (
          // The app's one segmented-control contract (`data-panel-tabs`,
          // surfaces.css panel-radius SSOT) rather than hand-written radii, so
          // this switch and the Schedules FilterTabs stay one widget. The
          // `hero` value is the density: a modal-level switch earns forza6's
          // poster weight (2px ink bracket + hard ink shadow); the valueless
          // in-card filter does not (#task:1833).
          <div
            data-panel-tabs="hero"
            className="mb-5 grid grid-cols-2 border border-border-subtle bg-bg-inset p-0.5"
          >
            <ModeButton
              active={isSignup}
              onClick={() => setMode("signup")}
              icon={<UserPlus className="size-3.5" />}
            >
              Sign up
            </ModeButton>
            <ModeButton
              active={!isSignup}
              onClick={() => setMode("login")}
              icon={<LogIn className="size-3.5" />}
            >
              Log in
            </ModeButton>
          </div>
        ) : null}

        <div className="flex flex-col gap-4">
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
                Handle
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
                placeholder="your-handle"
              />
              {/* One line, always occupied: the problem when there is one, the
                  irreversibility note otherwise. Same height either way, so
                  nothing moves — and no reserved empty row. */}
              <p
                className={cn("text-xs leading-4", handleError ? "text-error" : "text-text-muted")}
              >
                {handleError ?? "This handle is permanent and cannot be changed."}
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

        <footer className="mt-6 flex flex-col gap-2">
          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {isSignup ? "Creating..." : "Signing in..."}
              </>
            ) : isSignup ? (
              <>
                <UserPlus className="size-3.5" />
                Create account
              </>
            ) : (
              <>
                <LogIn className="size-3.5" />
                Log in
              </>
            )}
          </Button>
          {isSignup && password.length > 0 && password !== confirmPassword ? (
            // `text-error` — the theme token. `text-status-error`, which these
            // two lines used, is not defined in any theme, so both rendered in
            // the default text colour.
            <p className="text-xs text-error">Passwords do not match.</p>
          ) : null}
          {formError ? <p className="text-xs text-error">{formError}</p> : null}
        </footer>
      </form>
    </AuthSplitLayout>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Radius comes from `[data-panel-tabs] button` (surfaces.css SSOT), not
        // from a class here — same reason the track dropped its own.
        "inline-flex h-8 items-center justify-center gap-1.5 text-xs font-medium text-text-muted transition",
        active && "bg-bg-floating text-text-primary shadow-sm",
      )}
    >
      {icon}
      {children}
    </button>
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
    return { field: "handle", message: "This handle is already taken." };
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
