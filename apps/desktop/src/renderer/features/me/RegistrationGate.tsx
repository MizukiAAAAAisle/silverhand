import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2, LogIn, UserPlus } from 'lucide-react';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';
import { cn } from '@/lib/cn';
import { useLoginUser, useSignupUser } from './hooks';

export interface RegistrationGateProps {
  signupEnabled: boolean;
}

type AuthMode = 'signup' | 'login';

/**
 * Full-screen desktop auth gate. The renderer never receives the
 * `user_token`: submit calls an IPC method, main performs `/auth/*`,
 * persists the main-owned 0600 local session file, and returns only
 * the resolved user.
 */
export function RegistrationGate({
  signupEnabled,
}: RegistrationGateProps): JSX.Element {
  const signup = useSignupUser();
  const login = useLoginUser();
  const [mode, setMode] = useState<AuthMode>(signupEnabled ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!signupEnabled) setMode('login');
  }, [signupEnabled]);

  useEffect(() => {
    emailInputRef.current?.focus();
  }, []);

  const submitting = signup.isPending || login.isPending;
  const emailTrimmed = email.trim();
  const displayNameTrimmed = displayName.trim();
  const isSignup = mode === 'signup';
  const canSubmit =
    !submitting
    && emailTrimmed.length > 0
    && password.length >= (isSignup ? 8 : 1)
    && (!isSignup || password === confirmPassword);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      if (isSignup) {
        await signup.mutateAsync({
          email: emailTrimmed,
          password,
          display_name:
            displayNameTrimmed.length > 0 ? displayNameTrimmed : undefined,
        });
      } else {
        await login.mutateAsync({ email: emailTrimmed, password });
      }
    } catch (err) {
      setError(authErrorMessage(err));
    }
  };

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
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md border border-border-subtle bg-bg-row-hover text-text-secondary">
              <KeyRound className="size-4" />
            </span>
            <h1 className="text-base font-semibold leading-tight">
              {isSignup ? 'Create your account' : 'Sign in'}
            </h1>
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            {isSignup
              ? 'Use an email and password for this Silverhand backend.'
              : 'Sign in to continue to this Silverhand backend.'}
          </p>
        </header>

        {signupEnabled ? (
          <div className="mb-5 grid grid-cols-2 rounded-md border border-border-subtle bg-bg-row-hover p-0.5">
            <ModeButton
              active={isSignup}
              onClick={() => setMode('signup')}
              icon={<UserPlus className="size-3.5" />}
            >
              Sign up
            </ModeButton>
            <ModeButton
              active={!isSignup}
              onClick={() => setMode('login')}
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
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
            />
          </div>

          {isSignup ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-display">Display name</Label>
              <Input
                id="auth-display"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
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
              onChange={e => setPassword(e.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              placeholder={isSignup ? 'At least 8 characters' : 'Password'}
            />
          </div>

          {isSignup ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-confirm">Confirm password</Label>
              <Input
                id="auth-confirm"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="Repeat password"
              />
            </div>
          ) : null}
        </div>

        <footer className="mt-6 flex flex-col gap-2">
          <Button
            type="submit"
            disabled={!canSubmit}
            {...primaryAction('w-full justify-center')}
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {isSignup ? 'Creating...' : 'Signing in...'}
              </>
            ) : isSignup ? (
              <>
                <UserPlus className="size-3.5" />
                Create account
              </>
            ) : (
              <>
                <LogIn className="size-3.5" />
                Sign in
              </>
            )}
          </Button>
          {isSignup && password.length > 0 && password !== confirmPassword ? (
            <p className="text-xs text-status-error">Passwords do not match.</p>
          ) : null}
          {error ? (
            <p className="text-xs text-status-error">{error}</p>
          ) : null}
        </footer>
      </form>
    </main>
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
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-[4px] text-xs font-medium text-text-muted transition',
        active && 'bg-bg-floating text-text-primary shadow-sm',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function authErrorMessage(err: unknown): string {
  const apiErr = err as { body?: string; message?: string };
  let parsed: { error?: string; error_code?: string; code?: string } = {};
  try {
    parsed = JSON.parse(apiErr.body ?? '{}');
  } catch {
    // not JSON — fall through.
  }
  if (parsed.error_code === 'auth_failed' || parsed.code === 'auth_failed') {
    return 'Email or password is incorrect.';
  }
  if (parsed.error === 'invalid input') {
    return 'Check the email and password fields.';
  }
  return parsed.error ?? apiErr.message ?? 'Authentication failed.';
}
