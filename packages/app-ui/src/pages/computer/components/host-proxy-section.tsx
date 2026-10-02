import { ProxySkeleton } from "./computer-skeletons";
import { Check, CheckCircle2, Loader2, Save } from "lucide-react";
import { useEffect, useState, type FormEvent, type JSX } from "react";
import type { HostStatusResponse, RuntimeKind } from "@silverhand/shared";
import { RUNTIME_ORDER_LIST, runtimeLabel } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import {
  useHostProxyConfigQuery,
  useSaveHostProxyConfigMutation,
  isHostProxyOfflineError,
  type HostProxyConfig,
} from "../../../features/computers/hooks/hooks";
import { computerCopy } from "../../../features/computers/model/computer-copy";
import { HostSection, Banner } from "./host-section";

/** The proxy form lists every known runtime kind (availability-agnostic:
 *  proxying is a host-network concern, not a "can we spawn it" concern),
 *  in the shared catalog's canonical display order — so a new runtime can't
 *  silently drop out of the form and the label matches every other surface. */
export const PROXY_RUNTIMES: readonly RuntimeKind[] = RUNTIME_ORDER_LIST;

/* ─── Proxy (daemon-host local) ─────────────────────────────────── */
export function ProxySection({
  hostId,
  availability,
}: {
  hostId: string;
  availability: HostStatusResponse["availability"];
}): JSX.Element {
  // Proxy config is host-local truth: the backend can only read/write it by
  // dispatching to a *live* daemon, so the section is editable strictly on
  // the availability axis (NOT the old kind/`isLocalSelf` axis — a remote
  // user-managed computer edits its own proxy just fine while online). When
  // offline, read and write are both unavailable, so we collapse to a single
  // short hint rather than showing a stale/locked form.
  const online = availability === "available";
  const query = useHostProxyConfigQuery(hostId, { enabled: online });
  const saveMutation = useSaveHostProxyConfigMutation(hostId);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyRuntimes, setProxyRuntimes] = useState<Set<RuntimeKind>>(() => new Set());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed local form state from the daemon-served config. Re-runs
  // whenever the cached config refetches — keeps the form coherent if
  // another window writes the file (a rare path; renderer is the only
  // writer today, but the snapshot is shared so we still react to it).
  useEffect(() => {
    if (!query.data) return;
    setProxyUrl(query.data.proxy_url ?? "");
    setProxyRuntimes(new Set(query.data.proxy_runtimes));
    setError(null);
    setSaved(false);
  }, [query.data]);

  if (!online) {
    return (
      <HostSection title={computerCopy.proxyTitle} collapsible defaultOpen={false}>
        <p className="text-sm text-text-muted">{computerCopy.proxyOfflineHint}</p>
      </HostSection>
    );
  }

  const toggleRuntime = (kind: RuntimeKind, checked: boolean): void => {
    setSaved(false);
    setError(null);
    setProxyRuntimes((prev) => {
      const next = new Set(prev);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const proxyEnabled = proxyUrl.trim().length > 0;
  const allChecked = PROXY_RUNTIMES.every((kind) => proxyRuntimes.has(kind));

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    // Stable canonical order driven by `PROXY_RUNTIMES` so the
    // persisted file doesn't churn just because the user clicked
    // checkboxes in a different sequence.
    const orderedRuntimes = PROXY_RUNTIMES.filter((kind) => proxyRuntimes.has(kind));
    const config: HostProxyConfig = {
      proxy_url: proxyUrl.trim() ? proxyUrl.trim() : null,
      proxy_runtimes: orderedRuntimes,
    };
    try {
      await saveMutation.mutateAsync(config);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      // config-or-throw: a raced `computer_offline` rejects here (went offline
      // between load and save) — show the same connect hint once, without
      // caching offline anywhere. Any other failure surfaces inline.
      if (isHostProxyOfflineError(err)) {
        setError(computerCopy.proxyOfflineHint);
      } else {
        setError(
          err instanceof Error && err.message
            ? `Could not save proxy settings. (${err.message})`
            : "Could not save proxy settings. Please try again.",
        );
      }
    }
  };

  const settingsLoading = query.isLoading;
  const saving = saveMutation.isPending;

  return (
    <HostSection title={computerCopy.proxyTitle} collapsible defaultOpen={false}>
      {settingsLoading ? (
        <ProxySkeleton />
      ) : query.isError ? (
        // config-or-throw: a raced `computer_offline` (went unreachable
        // between the availability gate and the GET landing) propagates as a
        // query error — classify it and show the same short connect hint;
        // any other failure is a real load error. Durable offline is the
        // availability gate above, not this branch.
        isHostProxyOfflineError(query.error) ? (
          <Banner tone="muted">{computerCopy.proxyOfflineHint}</Banner>
        ) : (
          <Banner tone="error">
            Could not load proxy settings.
            {query.error instanceof Error ? ` (${query.error.message})` : ""}
          </Banner>
        )
      ) : (
        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="proxy-url">Proxy URL</Label>
            {/* v6.9 (#task:917, shiki computer-pane review): proxy URLs
                are host:port / scheme strings — make the input read as a
                config value, not prose. `font-mono` on the field itself
                keeps it readable across themes; the `data-host-proxy-url`
                hook lets forza6 layer HUD-specific weight/tracking
                without forking the input. */}
            <Input
              id="proxy-url"
              data-host-proxy-url
              className="font-mono"
              value={proxyUrl}
              onChange={(event) => {
                setProxyUrl(event.target.value);
                setSaved(false);
                setError(null);
              }}
              placeholder="http://127.0.0.1:7897"
              disabled={settingsLoading}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Enabled runtimes</Label>
              <button
                type="button"
                disabled={!proxyEnabled}
                className="text-xs font-medium text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setSaved(false);
                  setError(null);
                  setProxyRuntimes(allChecked ? new Set() : new Set(PROXY_RUNTIMES));
                }}
              >
                {allChecked ? "Clear all" : "Select all"}
              </button>
            </div>

            <div className={cn("grid gap-2 sm:grid-cols-2", !proxyEnabled && "opacity-55")}>
              {PROXY_RUNTIMES.map((kind) => {
                const checked = proxyRuntimes.has(kind);
                return (
                  <label
                    key={kind}
                    // v6.9.2 #task:917 (shiki "runtime 选中 background 和
                    // border 不搭"): the generic `border-accent` + `bg-row-
                    // selected` pair lands as pink-border + acid-lime fill
                    // in forza6 — two high-sat hues fighting. The
                    // `data-runtime-tile` + `data-checked` hooks let
                    // forza6 swap the border (and inner check fill) to
                    // ink-black so the tile reads as a poster-sticker
                    // family member (lime ground + 1px ink stroke) instead
                    // of clashing complements. Other themes keep the
                    // accent border untouched.
                    data-runtime-tile
                    data-checked={checked || undefined}
                    className={cn(
                      // Keep the sr-only checkbox inside this tile's scroll coordinates.
                      // Otherwise focusing it can scroll the root document.
                      "relative flex min-w-0 items-center gap-3 rounded-(--control-radius) border px-3 py-2 transition-colors",
                      proxyEnabled ? "cursor-pointer" : "cursor-not-allowed",
                      checked
                        ? "border-accent bg-(--bg-row-selected,var(--bg-selected)) text-text-on-selected"
                        : "border-border-subtle bg-bg-floating hover:bg-(--bg-hover)",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={(event) => toggleRuntime(kind, event.target.checked)}
                      disabled={!proxyEnabled}
                    />
                    <span
                      data-runtime-tile-check
                      data-checked={checked || undefined}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-(--control-radius) border",
                        checked
                          ? "border-accent bg-accent text-text-on-accent"
                          : "border-border-subtle bg-bg-floating text-transparent",
                      )}
                      aria-hidden
                    >
                      <Check className="size-3" />
                    </span>
                    <AgentAvatar runtime={kind} size={AVATAR_PX.sm} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm font-medium",
                        !checked && "text-text-primary",
                      )}
                    >
                      {runtimeLabel(kind)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-(length:--text-meta)",
                        !checked && "text-text-muted",
                      )}
                    >
                      {kind}
                    </span>
                  </label>
                );
              })}
            </div>
            {!proxyEnabled ? (
              <p className="text-xs text-text-muted">Add a Proxy URL before selecting runtimes.</p>
            ) : null}
          </div>

          {/* Save row sits inline with the form content rather than
              pinned to a sticky footer — the original bottom anchor
              was off-screen on shorter viewports and easy to miss. */}
          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="min-w-0 text-xs">
              {error ? (
                <span className="text-error">{error}</span>
              ) : saved ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="size-3.5" />
                  Saved
                </span>
              ) : null}
            </div>
            <Button
              type="submit"
              variant="primary"
              className="gap-2"
              disabled={saving || settingsLoading}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saving ? "Saving..." : "Save settings"}
            </Button>
          </div>
        </form>
      )}
    </HostSection>
  );
}
