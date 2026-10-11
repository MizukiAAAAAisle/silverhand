import type { JSX } from "react";
import type { AppUpdateState } from "@silverhand/client";
import { Button } from "@/components/ui/button";
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

function describe(state: AppUpdateState): string {
  switch (state.status) {
    case "idle":
      return state.lastCheckedAt === null
        ? "Silverhand has not checked for updates yet."
        : "Silverhand is up to date.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Silverhand ${state.version} is available.`;
    case "downloading":
      return `Downloading Silverhand ${state.version}…`;
    case "downloaded":
      return `Silverhand ${state.version} is ready to install. Restart now, or install it the next time you quit.`;
    case "installing":
      return `Preparing Silverhand ${state.version}…`;
    case "scheduled":
      return `Silverhand ${state.version} will be installed when you quit.`;
    case "error":
      return state.message;
  }
}

function progressPercent(state: Extract<AppUpdateState, { status: "downloading" }>): number | null {
  if (!state.total) return null;
  return Math.min(100, Math.round((state.transferred / state.total) * 100));
}

export function AppUpdateDialog(): JSX.Element | null {
  const state = useAppUpdateState();
  const open = useAppUpdateDialogOpen();
  if (!state) return null;
  const percent = state.status === "downloading" ? progressPercent(state) : null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAppUpdateDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Software update</DialogTitle>
          <DialogDescription>{describe(state)}</DialogDescription>
        </DialogHeader>
        {state.status === "downloading" ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 w-full overflow-hidden rounded-full bg-bg-hover"
          >
            <div
              className="h-full bg-(--accent) transition-[width]"
              style={{ width: `${percent ?? 0}%` }}
            />
          </div>
        ) : null}
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
          ) : state.status === "idle" || state.status === "error" ? (
            <Button variant="neutral" onClick={() => void appUpdateActions.check()}>
              Check again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
