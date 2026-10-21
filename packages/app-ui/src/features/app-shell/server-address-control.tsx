import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorIcon, RetryIcon, SpinnerIcon } from "@/icons";
import { getPlatform } from "@/platform";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { validateServerUrlDraft } from "@/features/settings/model/server-url-validation";
import {
  refreshServerEnvironment,
  useServerEnvironment,
} from "@/features/session/server-environment";
import { describeProfileSaveForGate } from "./backend-unreachable-gate";
import { t } from "@/lib/i18n";

/** Remote-only auth gates offer an escape to a different self-hosted origin. */
export function ServerAddressControl({
  onRetry,
  disabled = false,
  onEditingChange,
}: {
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onRetry?: () => void;
}) {
  const qc = useQueryClient();
  const environment = useServerEnvironment();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const url = environment.data?.url ?? "";
  const error = saveError ?? (environment.isError ? t("appShell.server.readFailed") : null);

  const save = async () => {
    if (saving || disabled) return;
    setSaving(true);
    setSaveError(null);
    try {
      const policy = await getPlatform().client.getConnectionPolicy();
      if (
        validateServerUrlDraft(draft, { allowInsecureRemote: policy.allow_insecure_remote })
          .kind !== "ok"
      ) {
        setSaveError(t("appShell.server.invalid"));
        return;
      }
      const result = await getPlatform().client.saveServerConnectionProfile({
        serverUrl: draft.trim(),
      });
      if (result.ok) {
        await refreshServerEnvironment(qc);
        setEditing(false);
        onEditingChange?.(false);
        onRetry?.();
      } else {
        const message = describeProfileSaveForGate(result);
        setSaveError(message.description ?? message.title);
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-2 text-sm" aria-label={t("appShell.server.address")}>
      {editing ? (
        <>
          <Label htmlFor="login-server">{t("appShell.server.address")}</Label>
          <Input
            id="login-server"
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving || disabled}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void save();
              }
            }}
          />
          <div className="grid grid-cols-2 gap-3 md:flex md:justify-end md:gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={saving || disabled}
              onClick={() => {
                void save();
              }}
            >
              {saving ? t("common.checking") : t("common.save")}
            </Button>
            <Button
              type="button"
              variant="cancel"
              size="sm"
              disabled={saving || disabled}
              onClick={() => {
                setEditing(false);
                setSaveError(null);
                onEditingChange?.(false);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-w-0 items-baseline gap-2 text-text-muted">
          <span className="shrink-0">{t("appShell.server.label")}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={url}>
            {url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : t("appShell.server.notSet")}
          </span>
          <button
            type="button"
            aria-label={t("appShell.server.change")}
            className="shrink-0 font-medium text-text-primary underline underline-offset-3 hover:text-text-secondary focus-outline disabled:opacity-50 max-md:min-h-11"
            disabled={saving || disabled}
            onClick={() => {
              setDraft(url);
              setEditing(true);
              onEditingChange?.(true);
            }}
          >
            {t("common.change")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Connection state for the auth gate. Reads as part of the server row it
 *  describes, below the form, rather than as a banner over it. */
export function ServerConnectionStatus({
  status,
  checking = false,
  onRetry,
}: {
  status?: string;
  checking?: boolean;
  onRetry?: () => void;
}) {
  if (checking) {
    return (
      <div role="status" className="mt-3 flex items-center gap-2 text-xs text-text-muted">
        <SpinnerIcon className="size-3.5 animate-spin" aria-hidden="true" />
        {t("appShell.server.checking")}
      </div>
    );
  }
  if (!status) {
    return null;
  }

  const secure = /TLS|SSL|certificate|secure connection/i.test(status);

  return (
    <section
      className="mt-3 flex flex-col gap-2 text-xs"
      aria-label={t("appShell.server.connection")}
    >
      <div role="alert" className="flex items-start gap-2">
        <ErrorIcon className="mt-px size-3.5 shrink-0 text-error" aria-hidden="true" />
        <p className="min-w-0 leading-relaxed text-text-secondary">
          <span className="font-medium text-text-primary">
            {secure ? t("appShell.server.secureFailed") : t("appShell.server.cannotConnect")}
          </span>{" "}
          {secure ? t("appShell.server.signInUnavailable") : t("appShell.server.checkConnection")}
        </p>
      </div>
      <div className="flex items-start justify-between gap-3 pl-5.5">
        <details className="min-w-0 text-text-muted">
          <summary className="cursor-pointer focus-outline">{t("common.technicalDetails")}</summary>
          <p className="mt-1 break-words leading-relaxed">{status.replace(/^Error:\s*/, "")}</p>
        </details>
        {onRetry && (
          <Button type="button" variant="neutral" size="sm" className="shrink-0" onClick={onRetry}>
            <RetryIcon className="size-3.5" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        )}
      </div>
    </section>
  );
}
