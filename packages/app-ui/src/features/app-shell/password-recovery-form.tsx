import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PasswordRecoveryRequestInputSchema,
  PasswordRecoveryResetInputSchema,
} from "@silverhand/shared";
import { SpinnerIcon } from "@/icons";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getPlatform } from "@/platform";

type Step = "email" | "reset";

/**
 * Email recovery-code password reset against the server selected when the flow
 * opened. A successful reset returns to the login page without signing in.
 */
export function PasswordRecoveryForm({
  enabled,
  initialEmail,
  onDone,
  onCancel,
}: {
  enabled: boolean;
  initialEmail: string;
  onDone: (email: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Answers that arrive after the form closed belong to no flow.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const emailTrimmed = email.trim();

  async function call(action: "request" | "reset", body: unknown) {
    const result = await getPlatform().client.passwordRecovery({
      action,
      body: JSON.stringify(body),
    });
    let parsed: { error_code?: string } = {};
    try {
      parsed = JSON.parse(result.bodyText);
    } catch {
      // not JSON
    }
    return { status: result.status, code: parsed.error_code };
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    const input = PasswordRecoveryRequestInputSchema.safeParse({ email: emailTrimmed });
    if (!input.success || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await call("request", input.data);
      if (!alive.current) return;
      if (result.status === 202) {
        setStep("reset");
        setNotice("If this email belongs to an account, a 6-digit code has been sent to it.");
      } else {
        setError(failureMessage(result.status, result.code));
      }
    } catch {
      if (alive.current) setError("Could not reach the server. Try again.");
    } finally {
      if (alive.current) setPending(false);
    }
  }

  async function reset(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    const input = PasswordRecoveryResetInputSchema.safeParse({
      email: emailTrimmed,
      code: code.trim(),
      new_password: password,
    });
    if (!input.success) {
      setError("Enter the 6-digit code and a new password of at least 8 characters.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await call("reset", input.data);
      if (!alive.current) return;
      if (result.status === 200) onDone(emailTrimmed);
      else setError(failureMessage(result.status, result.code));
    } catch {
      if (alive.current) setError("Could not reach the server. Try again.");
    } finally {
      if (alive.current) setPending(false);
    }
  }

  const back = (
    <button
      type="button"
      className="font-medium text-text-primary underline underline-offset-3 hover:text-text-secondary focus-outline"
      onClick={onCancel}
    >
      Back to log in
    </button>
  );

  if (!enabled) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          Password recovery is not enabled on this server. Contact your administrator to reset your
          password.
        </p>
        <p className="text-sm text-text-muted">{back}</p>
      </div>
    );
  }

  return step === "email" ? (
    <form onSubmit={(event) => void requestCode(event)} className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Enter the email of your account. We will send a code to reset your password.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-email">Email</Label>
        <Input
          id="recovery-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          spellCheck={false}
          placeholder="you@example.com"
          autoFocus
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full justify-center"
        disabled={pending || emailTrimmed.length === 0}
      >
        {pending ? <SpinnerIcon className="size-3.5 animate-spin" /> : null}
        Send code
      </Button>
      {error ? <p className="text-xs text-error">{error}</p> : null}
      <p className="text-sm text-text-muted">{back}</p>
    </form>
  ) : (
    <form onSubmit={(event) => void reset(event)} className="flex flex-col gap-4">
      {notice ? <p className="text-sm text-text-muted">{notice}</p> : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-code">Code</Label>
        <Input
          id="recovery-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6-digit code"
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-password">New password</Label>
        <Input
          id="recovery-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-confirm">Confirm password</Label>
        <Input
          id="recovery-confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          placeholder="Repeat password"
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full justify-center"
        disabled={pending || code.length !== 6 || password.length < 8 || confirm.length === 0}
      >
        {pending ? <SpinnerIcon className="size-3.5 animate-spin" /> : null}
        Reset password
      </Button>
      {error ? <p className="text-xs text-error">{error}</p> : null}
      <p className="text-sm text-text-muted">
        <button
          type="button"
          className="font-medium text-text-primary underline underline-offset-3 hover:text-text-secondary focus-outline disabled:opacity-50"
          disabled={pending}
          onClick={() => void requestCode()}
        >
          Send a new code
        </button>
        <span className="mx-2">·</span>
        {back}
      </p>
    </form>
  );
}

function failureMessage(status: number, code: string | undefined): string {
  switch (code) {
    case "invalid_or_expired_code":
      return "The code is invalid or has expired. Request a new code.";
    case "password_recovery_disabled":
      return "Password recovery is not enabled on this server. Contact your administrator.";
    case "password_recovery_busy":
    case "rate_limited":
      return "Too many requests. Try again in a minute.";
  }
  if (status === 409) return "The server connection changed. Start again.";
  if (status === 0) return "Could not reach the server. Try again.";
  if (status === 422) return "Check the email and password fields.";
  return "Something went wrong. Try again.";
}
