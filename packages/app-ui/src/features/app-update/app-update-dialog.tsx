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
import { t } from "@/lib/i18n";

export function AppUpdateDialog(): JSX.Element | null {
  const state = useAppUpdateState();
  const open = useAppUpdateDialogOpen();
  if (!state) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAppUpdateDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("appUpdate.softwareUpdate")}</DialogTitle>
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
                {t("appUpdate.installOnQuit")}
              </Button>
              <Button variant="primary" onClick={() => void appUpdateActions.install("now")}>
                {t("appUpdate.restartAndInstall")}
              </Button>
            </>
          ) : state.status === "scheduled" ? (
            <Button variant="primary" onClick={() => void appUpdateActions.install("now")}>
              {t("appUpdate.restartNow")}
            </Button>
          ) : state.status === "available" || (state.status === "error" && state.version) ? (
            <Button variant="primary" onClick={() => void appUpdateActions.download()}>
              {state.status === "error" ? t("appUpdate.retryDownload") : t("appUpdate.download")}
            </Button>
          ) : state.status === "error" ? (
            <>
              <Button variant="neutral" onClick={() => void appUpdateActions.check()}>
                {t("appUpdate.tryAgain")}
              </Button>
              <Button variant="primary" onClick={closeAppUpdateDialog}>
                OK
              </Button>
            </>
          ) : state.status === "idle" && state.lastCheckedAt === null ? (
            <Button variant="primary" onClick={() => void appUpdateActions.check()}>
              {t("appUpdate.checkForUpdates")}
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
