import { useEffect, useState, type JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLeaveWorkspace } from "./hooks";

/**
 * Confirm modal for self-leaving a workspace from the right-click menu. A menu
 * closes on select, so its destructive action cannot fall back to the inline
 * confirm the Settings danger zone uses — it hands off to a modal instead.
 *
 * Leave is NOT styled as danger (no red): it removes only the caller's own
 * membership and destroys no content, so it is not the irreversible act red is
 * reserved for (the owner's Delete). Access is not freely restored — rejoining
 * the workspace re-seeds no channel membership — but the copy stays terse ("all
 * its channels") per shiki rather than spelling out the rare private-channel
 * orphaning, since the content itself survives. Do NOT reintroduce a "re-invite
 * restores access" line: it is false for channels. The confirm reads as a
 * primary action, not an error.
 *
 * On success the workspaces list invalidation drops the row and the selection
 * effect bounces away; this dialog only needs to close. On failure it stays
 * open and surfaces the error inline — the same reason SwitchRuntimeConfirmDialog
 * keeps its error in-modal (a parent-level error would sit under the overlay).
 */
export function LeaveWorkspaceConfirmDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  workspaceId: string;
  workspaceName: string;
}): JSX.Element {
  const leaveWorkspace = useLeaveWorkspace();
  const [error, setError] = useState<string | null>(null);
  const pending = leaveWorkspace.isPending;

  // Clear a stale error whenever the dialog is (re)opened for a fresh attempt.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const onConfirm = () => {
    setError(null);
    leaveWorkspace.mutate(workspaceId, {
      onSuccess: () => onOpenChange(false),
      onError: () => setError("Could not leave this workspace. Try again."),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{`Leave ${workspaceName}?`}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-sm leading-relaxed text-text-muted">
          You leave this workspace and all its channels.
        </DialogDescription>
        {error ? (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="cancel" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending}>
            {pending ? "Leaving…" : "Leave workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
