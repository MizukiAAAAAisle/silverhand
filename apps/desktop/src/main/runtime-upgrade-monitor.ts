import {
  classifyDesktopServerApiCompatibility,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
  UpgradeRequiredBodySchema,
  type DesktopApiAdvertisement,
} from "@silverhand/shared";

export interface RuntimeUpgradeMonitorDeps {
  /** Fetch the current `desktop_api` advertisement (server-info, exempt path). */
  probe: () => Promise<DesktopApiAdvertisement | undefined>;
  /** Fired at most once per latch period when the pair is client_too_old. */
  notify: () => void;
  log?: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
  } | null;
}

export interface RuntimeUpgradeMonitor {
  /**
   * REST arm: feed every non-2xx proxy response. Only a 426 whose body
   * parses as UpgradeRequiredBody counts as a suspect; anything else
   * (network errors, 401/403, unrelated 426s with foreign bodies) is
   * ignored here.
   */
  onRestResponse(status: number, bodyText: string | undefined): void;
  /**
   * Advertisement arm: feed the `desktop_api` block whenever main serves a
   * backend:info discovery request (reconnect-driven — the primary path —
   * or the renderer's idle 30s poll). This is the authoritative broadcast
   * itself, so no probe is needed — it is classified directly. Undefined
   * (pre-epoch server) never promotes.
   */
  onAdvertisement(advertised: DesktopApiAdvertisement | undefined): void;
  /** Re-arm after the pair is compatible again (new build / server rollback). */
  reset(): void;
}

export function createRuntimeUpgradeMonitor(
  deps: RuntimeUpgradeMonitorDeps,
): RuntimeUpgradeMonitor {
  let latched = false;
  let probing = false;

  const suspect = (source: "rest"): void => {
    if (latched || probing) return;
    probing = true;
    void (async () => {
      try {
        const advertised = await deps.probe();
        const compatibility = classifyDesktopServerApiCompatibility({
          clientEpoch: DESKTOP_SERVER_API_EPOCH,
          minimumClientEpoch: advertised?.minimum_client_epoch ?? 0,
          serverEpoch: advertised?.current_epoch ?? 0,
          minimumServerEpoch: MINIMUM_SERVER_API_EPOCH,
        });
        if (compatibility === "client_too_old" && !latched) {
          latched = true;
          deps.log?.info(
            { source, minimum_client_epoch: advertised?.minimum_client_epoch },
            "runtime upgrade requirement confirmed by server-info probe",
          );
          deps.notify();
        }
      } catch (err) {
        // Probe unreachable: do nothing — an unreachable server is the
        // backend_unreachable story, not an upgrade requirement. The next
        // suspect re-probes.
        deps.log?.warn({ err, source }, "runtime upgrade probe failed");
      } finally {
        probing = false;
      }
    })();
  };

  return {
    onRestResponse(status, bodyText) {
      if (latched || status !== 426 || bodyText === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return;
      }
      if (!UpgradeRequiredBodySchema.safeParse(parsed).success) return;
      suspect("rest");
    },
    onAdvertisement(advertised) {
      if (latched) return;
      const compatibility = classifyDesktopServerApiCompatibility({
        clientEpoch: DESKTOP_SERVER_API_EPOCH,
        minimumClientEpoch: advertised?.minimum_client_epoch ?? 0,
        serverEpoch: advertised?.current_epoch ?? 0,
        minimumServerEpoch: MINIMUM_SERVER_API_EPOCH,
      });
      if (compatibility !== "client_too_old") return;
      latched = true;
      deps.log?.info(
        {
          source: "backend_info",
          minimum_client_epoch: advertised?.minimum_client_epoch,
        },
        "runtime upgrade requirement observed in server advertisement",
      );
      deps.notify();
    },
    reset() {
      latched = false;
    },
  };
}
