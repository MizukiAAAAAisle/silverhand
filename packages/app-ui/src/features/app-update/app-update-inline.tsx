import type { JSX } from "react";
import type { AppUpdateState } from "@silverhand/client";
import { Button } from "@/components/ui/button";
import { RefreshIcon, SpinnerIcon } from "@/icons";
import { appUpdateActions } from "./app-update-store";
import { AppUpdateProgress, describeAppUpdate } from "./app-update-parts";
import { t } from "@/lib/i18n";

function inlineStatus(state: AppUpdateState): string | null {
  switch (state.status) {
    case "idle":
      return state.lastCheckedAt === null ? null : t("appUpdate.noNewerVersionIs");
    case "downloaded":
    case "scheduled":
      return t("appUpdate.readyRestart", { version: state.version });
    default:
      return describeAppUpdate(state);
  }
}

/**
 * The whole update, run in place: a boot gate has no app behind it, so the
 * user never leaves the card. Installing on quit is not offered for the same reason.
 */
export function AppUpdateInline({
  state,
  onRecheck,
}: {
  state: AppUpdateState;
  /** Re-probes the server; a rollback can make this build compatible again. */
  onRecheck: () => void;
}): JSX.Element {
  const status = inlineStatus(state);
  const busy =
    state.status === "checking" || state.status === "downloading" || state.status === "installing";
  const recheck = (
    <Button type="button" variant="neutral" size="sm" onClick={onRecheck}>
      <RefreshIcon className="size-3.5" />
      {t("appUpdate.checkAgain")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {status ? (
        <p className="flex items-center gap-2 text-xs text-text-primary" role="status">
          {state.status === "checking" || state.status === "installing" ? (
            <SpinnerIcon aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : null}
          <span>{status}</span>
        </p>
      ) : null}
      {state.status === "downloading" ? <AppUpdateProgress state={state} /> : null}
      {busy ? null : (
        <div className="flex gap-2">
          {state.status === "downloaded" || state.status === "scheduled" ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void appUpdateActions.install("now")}
            >
              {t("appUpdate.restartAndInstall")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void appUpdateActions.update()}
              >
                {state.status === "error" ? t("appUpdate.tryAgain") : t("common.update")}
              </Button>
              {recheck}
            </>
          )}
        </div>
      )}
    </div>
  );
}
