import { useId, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiPaths,
  ChangePasswordInputSchema,
  ChangePasswordResponseSchema,
  PasswordStatusResponseSchema,
} from "@silverhand/shared";
import { api, ApiError } from "@/lib/api";
import { primaryAction } from "@/components/common/primary-action";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function ChangePasswordForm({ userId }: { userId: string }): JSX.Element | null {
  const id = useId();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["password-status", userId],
    queryFn: async () => PasswordStatusResponseSchema.parse(await api(apiPaths.mePassword)),
  });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  // Collapsed by default: changing a password is a rare action, so it stays
  // out of the way until the viewer opens it.
  const [open, setOpen] = useState(false);

  if (!status.data?.has_password) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || uncertain) return;
    const parsed = ChangePasswordInputSchema.safeParse({
      current_password: current,
      new_password: next,
    });
    if (!parsed.success) {
      setError("Use your current password and a new password of 8–1024 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      // Deliberately no mutation cache or automatic retry for password plaintext.
      ChangePasswordResponseSchema.parse(
        await api(apiPaths.mePassword, { method: "POST", body: JSON.stringify(parsed.data) }),
      );
      setCurrent("");
      setNext("");
      setConfirm("");
      // Main clears only the session that issued this request. Re-read rather
      // than logging out again: a new login may have happened while awaiting it.
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) {
        setError("Current password was rejected or changed. Check it and try again.");
      } else if (cause instanceof ApiError && cause.status === 422) {
        setError("The password does not meet the requirements.");
      } else {
        setUncertain(true);
        setCurrent("");
        setNext("");
        setConfirm("");
        setError(
          "Could not confirm the change. Do not resubmit; log out and sign in with your new password. If it was not saved, use your previous password.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex max-w-sm flex-col">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Change password
      </button>
      {open ? (
        <form onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-3">
          <Label htmlFor={`${id}-current`}>Current password</Label>
          <Input
            id={`${id}-current`}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={pending || uncertain}
            required
            maxLength={1024}
          />
          <Label htmlFor={`${id}-new`}>New password</Label>
          <Input
            id={`${id}-new`}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={pending || uncertain}
            required
            minLength={8}
            maxLength={1024}
          />
          <Label htmlFor={`${id}-confirm`}>Confirm new password</Label>
          <Input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending || uncertain}
            required
            maxLength={1024}
          />
          {error && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            {...primaryAction("self-start")}
            disabled={pending || uncertain || !current || !next || !confirm}
          >
            {pending ? "Saving…" : "Change password"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
