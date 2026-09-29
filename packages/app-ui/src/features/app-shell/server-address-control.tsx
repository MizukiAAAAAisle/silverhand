import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Pencil, RotateCw } from "lucide-react";
import { getPlatform } from "@/platform";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { validateServerUrlDraft } from "@/features/settings-shell/model/server-url-validation";
import { describeProfileSaveForGate } from "./backend-unreachable-gate";

/** Login always offers an escape to a different self-hosted origin. */
export function ServerAddressControl({
  status,
  onRetry,
  checking = false,
  disabled = false,
  onEditingChange,
}: {
  status?: string;
  checking?: boolean;
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
    <section className="mb-5 space-y-2 text-sm" aria-label="Server connection">
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
          <div className="grid grid-cols-2 gap-3">
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
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 break-all text-text-muted">{url}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Change server"
            title="Change server"
            disabled={saving || disabled}
            onClick={() => {
              setDraft(url);
              setEditing(true);
              onEditingChange?.(true);
            }}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
      {checking ? (
        <div role="status" className="flex items-center gap-2 py-2 text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Checking server…
        </div>
      ) : status ? (
        <div className="space-y-3 rounded-(--control-radius) border border-border bg-bg-inset p-3">
          <div role="alert" className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-text-primary">
                {/TLS|SSL|certificate|secure connection/i.test(status)
                  ? "Secure connection failed"
                  : "Cannot connect to server"}
              </p>
              <p className="text-xs leading-relaxed text-text-secondary">
                {/TLS|SSL|certificate|secure connection/i.test(status)
                  ? "The server’s secure connection could not be verified. Sign-in is unavailable until the connection is restored."
                  : "Check your connection or change the server address, then try again."}
              </p>
            </div>
          </div>
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer py-1 focus-outline">Technical details</summary>
            <p className="mt-1 break-words leading-relaxed">{status.replace(/^Error:\s*/, "")}</p>
          </details>
          {onRetry && (
            <Button type="button" variant="neutral" className="min-h-11 w-full" onClick={onRetry}>
              <RotateCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          )}
        </div>
      ) : null}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </section>
  );
}
