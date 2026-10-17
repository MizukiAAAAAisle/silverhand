import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { SpinnerIcon } from "@/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  appUpdateActions,
  closeAppUpdateDialog,
  useAppUpdateDialogOpen,
  useAppUpdateState,
} from "./app-update-store";
import { AppUpdateProgress, describeAppUpdate } from "./app-update-parts";

export function AppUpdateDialog(): JSX.Element | null {
  const state = useAppUpdateState();
  const open = useAppUpdateDialogOpen();
  if (!state) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAppUpdateDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Software update</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {state.status === "checking" ? (
              <SpinnerIcon aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
            ) : null}
            <span>{describeAppUpdate(state)}</span>
          </DialogDescription>
        </DialogHeader>
        {state.status === "downloading" ? <AppUpdateProgress state={state} /> : null}
        <DialogFooter>
          {state.status === "downloaded" ? (
            <>
              <Button variant="neutral" onClick={() => void appUpdateActions.install("on-quit")}>
                Install on Quit
              </Button>
              <Button variant="primary" onClick={() => void appUpdateActions.install("now")}>
                Restart and Install
              </Button>
            </>
          ) : state.status === "scheduled" ? (
            <Button variant="primary" onClick={() => void appUpdateActions.install("now")}>
              Restart Now
            </Button>
          ) : state.status === "available" || (state.status === "error" && state.version) ? (
            <Button variant="primary" onClick={() => void appUpdateActions.download()}>
              {state.status === "error" ? "Retry download" : "Download"}
            </Button>
          ) : state.status === "error" ? (
            <>
              <Button variant="neutral" onClick={() => void appUpdateActions.check()}>
                Try Again
              </Button>
              <Button variant="primary" onClick={closeAppUpdateDialog}>
                OK
              </Button>
            </>
          ) : state.status === "idle" && state.lastCheckedAt === null ? (
            <Button variant="primary" onClick={() => void appUpdateActions.check()}>
              Check for Updates
            </Button>
          ) : state.status === "idle" ? (
            <Button variant="primary" onClick={closeAppUpdateDialog}>
              OK
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
