import { useEffect, useId, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiPaths } from "@silverhand/shared";
import { api, ApiError } from "@/lib/api";
import { useLogout } from "@/features/session/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

interface Blocker {
  id: string;
  name: string;
}
interface Blockers {
  agents: Blocker[];
  workspaces: Blocker[];
}
interface Preflight {
  available: boolean;
  blockers: Blockers | null;
}

function BlockerList({ blockers }: { blockers: Blockers }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-xs text-text-muted">
      <p>Resolve the following before deleting:</p>
      <ul className="list-disc pl-4">
        {blockers.workspaces.map((w) => (
          <li key={w.id}>{`Transfer ownership of or delete the workspace “${w.name}”`}</li>
        ))}
        {blockers.agents.map((a) => (
          <li key={a.id}>{`Delete the agent @${a.name}`}</li>
        ))}
      </ul>
    </div>
  );
}

/** Settings › Account danger zone. Not offered in embedded mode. */
export function DeleteAccountSection({ handle }: { handle: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const preflight = useQuery({
    queryKey: ["account-deletion"],
    queryFn: () => api<Preflight>(apiPaths.meDeletion),
  });
  if (!preflight.data?.available) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-secondary">Delete account</p>
        <p className="text-(length:--text-meta) text-text-muted">
          Permanently delete this account.
        </p>
      </div>
      <Button
        type="button"
        variant="destructive-outline"
        onClick={() => {
          void preflight.refetch();
          setOpen(true);
        }}
      >
        Delete account…
      </Button>
      <DeleteAccountDialog
        open={open}
        onOpenChange={setOpen}
        handle={handle}
        blockers={preflight.data.blockers}
      />
    </div>
  );
}

function DeleteAccountDialog({
  open,
  onOpenChange,
  handle,
  blockers,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  handle: string;
  blockers: Blockers | null;
}): JSX.Element {
  const id = useId();
  const logout = useLogout();
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Blockers | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setTyped("");
    setError(null);
    setConflict(null);
  }, [open]);

  const shown = conflict ?? blockers;
  const blocked = !!shown && (shown.agents.length > 0 || shown.workspaces.length > 0);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await api(apiPaths.me, {
        method: "DELETE",
        body: JSON.stringify({ password, handle: typed }),
      });
      // Sessions are already revoked server-side; logout clears the local session.
      await logout.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          setConflict((JSON.parse(err.body) as { blockers: Blockers }).blockers);
        } catch {
          setError("Your account still owns workspaces or agents.");
        }
      } else if (err instanceof ApiError && err.status === 403) {
        setError("Password or handle is incorrect.");
      } else {
        setError("Could not delete your account. Try again.");
      }
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete your account?</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-sm leading-relaxed text-text-muted">
          Account data, memberships, and computers will be removed. Messages and attachments remain
          in their conversations. This action cannot be undone.
        </DialogDescription>
        {blocked && shown ? (
          <BlockerList blockers={shown} />
        ) : (
          <form
            id={`${id}-form`}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor={`${id}-password`}>Password</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
              required
              maxLength={1024}
            />
            <Label htmlFor={`${id}-handle`}>{`Type your handle “${handle}” to confirm`}</Label>
            <Input
              id={`${id}-handle`}
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={pending}
              required
            />
          </form>
        )}
        {error ? (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="cancel" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {blocked ? null : (
            <Button
              variant="destructive"
              type="submit"
              form={`${id}-form`}
              disabled={pending || !password || typed !== handle}
            >
              {pending ? "Deleting…" : "Delete account"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
