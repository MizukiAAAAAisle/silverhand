import { useEffect, useState } from "react";
import { ErrorIcon, RetryIcon, SpinnerIcon } from "@/icons";
import { getPlatform } from "@/platform";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { validateServerUrlDraft } from "@/features/settings/model/server-url-validation";
import { describeProfileSaveForGate } from "./backend-unreachable-gate";

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
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getPlatform()
      .client.getConnectionInfo()
      .then((info) => {
        if (!cancelled) {
          setUrl(info?.url ?? "");
          setDraft(info?.url ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not read server address.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const save = async () => {
    if (saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      const policy = await getPlatform().client.getConnectionPolicy();
      if (
        validateServerUrlDraft(draft, { allowInsecureRemote: policy.allow_insecure_remote })
          .kind !== "ok"
      ) {
        setError("Enter a valid HTTPS server address.");
        return;
      }
      const result = await getPlatform().client.saveServerConnectionProfile({
        serverUrl: draft.trim(),
      });
      if (result.ok) {
        setUrl(result.profile.server_url);
        setEditing(false);
        onEditingChange?.(false);
        onRetry?.();
      } else {
        const message = describeProfileSaveForGate(result);
        setError(message.description ?? message.title);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-2 text-sm" aria-label="Server address">
      {editing ? (
        <>
          <Label htmlFor="login-server">Server address</Label>
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
              {saving ? "Checking…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="cancel"
              size="sm"
              disabled={saving || disabled}
              onClick={() => {
                setEditing(false);
                setError(null);
                onEditingChange?.(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-w-0 items-baseline gap-2 text-text-muted">
          <span className="shrink-0">Server</span>
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={url}>
            {url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "Not set"}
          </span>
          <button
            type="button"
            aria-label="Change server"
            className="shrink-0 font-medium text-text-primary underline underline-offset-3 hover:text-text-secondary focus-outline disabled:opacity-50 max-md:min-h-11"
            disabled={saving || disabled}
            onClick={() => {
              setDraft(url);
              setEditing(true);
              onEditingChange?.(true);
            }}
          >
            Change
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
        Checking server…
      </div>
    );
  }
  if (!status) {
    return null;
  }

  const secure = /TLS|SSL|certificate|secure connection/i.test(status);

  return (
    <section className="mt-3 flex flex-col gap-2 text-xs" aria-label="Server connection">
      <div role="alert" className="flex items-start gap-2">
        <ErrorIcon className="mt-px size-3.5 shrink-0 text-error" aria-hidden="true" />
        <p className="min-w-0 leading-relaxed text-text-secondary">
          <span className="font-medium text-text-primary">
            {secure ? "Secure connection failed." : "Cannot connect to server."}
          </span>{" "}
          {secure
            ? "Sign-in is unavailable until the connection can be verified."
            : "Check your connection or change the server address."}
        </p>
      </div>
      <div className="flex items-start justify-between gap-3 pl-5.5">
        <details className="min-w-0 text-text-muted">
          <summary className="cursor-pointer focus-outline">Technical details</summary>
          <p className="mt-1 break-words leading-relaxed">{status.replace(/^Error:\s*/, "")}</p>
        </details>
        {onRetry && (
          <Button type="button" variant="neutral" size="sm" className="shrink-0" onClick={onRetry}>
            <RetryIcon className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}
