import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UserDto } from "@silverhand/shared";
import { Button } from "@/components/ui/button";
import { cacheViewer } from "@/features/session/hooks";
import { serverEnvironmentQuery } from "@/features/session/server-environment";
import { eventWsClient } from "@/lib/ws-client";
import { ProfileSetupForm } from "./profile-setup-form";
import { EmbeddedProfileSetup, setupTransport, type SetupState } from "./embedded-profile-setup";
import { t } from "@/lib/i18n";

export function EmbeddedProfileSetupGate({
  viewerId,
  children,
}: {
  viewerId: string;
  children: ReactNode;
}): JSX.Element {
  const qc = useQueryClient();
  const controller = useRef<EmbeddedProfileSetup | null>(null);
  const [state, setState] = useState<SetupState>({ phase: "checking", error: null });
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    const model = new EmbeddedProfileSetup({
      ...setupTransport,
      mode: async () => (await qc.fetchQuery(serverEnvironmentQuery)).mode,
      isCurrent: () => qc.getQueryData<UserDto>(["me"])?.id === viewerId,
      applyUser: (user) => {
        if (user.id !== viewerId) {
          throw new Error("Profile setup viewer mismatch");
        }
        cacheViewer(qc, user);
      },
      changed: (next) => {
        setState(next);
        if (next.phase === "required") {
          setShowForm(true);
        }
      },
    });
    controller.current = model;
    eventWsClient.connect();
    void model.read();
    let previous = eventWsClient.getStatus();
    const unsubscribe = eventWsClient.onStatus((status) => {
      if (status === "connected" && previous !== "connected") {
        void model.read();
      }
      previous = status;
    });
    return () => {
      model.dispose();
      unsubscribe();
      controller.current = null;
    };
  }, [qc, viewerId]);

  if (state.phase === "ready") {
    return <>{children}</>;
  }

  if (state.phase === "avatar-error" || state.phase === "uploading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg-base p-6 text-text-primary">
        <div className="flex max-w-105 flex-col gap-4">
          <h1 className="text-lg font-semibold">{t("appShell.profile.saved")}</h1>
          <p role="alert" className="text-sm text-text-muted">
            {state.error ?? t("appShell.profile.uploadingPhoto")}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={state.phase === "uploading"}
              onClick={() => void controller.current?.retryAvatar()}
            >
              {t("appShell.profile.retryPhoto")}
            </Button>
            <Button
              disabled={state.phase === "uploading"}
              onClick={() => controller.current?.continueWithoutAvatar()}
            >
              {t("appShell.profile.continueWithoutPhoto")}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {showForm ? (
        <ProfileSetupForm
          pending={state.phase !== "required"}
          error={state.error}
          onRetry={state.phase === "read-error" ? () => void controller.current?.read() : undefined}
          onSubmit={(values) => void controller.current?.submit(values)}
        />
      ) : (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg-base p-6 text-sm text-text-muted">
          <p role={state.error ? "alert" : "status"}>{state.error ?? t("common.loading")}</p>
          {state.phase === "read-error" ? (
            <Button onClick={() => void controller.current?.read()}>{t("common.retry")}</Button>
          ) : null}
        </div>
      )}
    </>
  );
}
