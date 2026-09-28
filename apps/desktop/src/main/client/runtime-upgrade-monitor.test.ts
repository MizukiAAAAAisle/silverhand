import { describe, expect, it, vi } from "vitest";
import { DESKTOP_SERVER_API_EPOCH, type DesktopApiAdvertisement } from "@silverhand/shared";
import { createRuntimeUpgradeMonitor } from "./runtime-upgrade-monitor.js";

const UPGRADE_BODY = JSON.stringify({
  error: "upgrade_required",
  reason: "client_too_old",
  server_api_epoch: DESKTOP_SERVER_API_EPOCH + 1,
  minimum_client_epoch: DESKTOP_SERVER_API_EPOCH + 1,
});

function tooOldAdvertisement(): DesktopApiAdvertisement {
  return {
    current_epoch: DESKTOP_SERVER_API_EPOCH + 1,
    minimum_client_epoch: DESKTOP_SERVER_API_EPOCH + 1,
  };
}

function compatibleAdvertisement(): DesktopApiAdvertisement {
  return {
    current_epoch: DESKTOP_SERVER_API_EPOCH,
    minimum_client_epoch: DESKTOP_SERVER_API_EPOCH,
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("runtime upgrade monitor (#task:1763)", () => {
  it("REST 426 with a valid body probes, confirms, notifies once, and latches", async () => {
    const probe = vi.fn(async () => tooOldAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // Latched: further suspects are inert on both arms.
    m.onRestResponse(426, UPGRADE_BODY);
    m.onAdvertisement(tooOldAdvertisement());
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an authoritative advertisement below minimum promotes directly (no probe)", () => {
    const probe = vi.fn(async () => tooOldAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onAdvertisement(tooOldAdvertisement());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    // compatible or pre-epoch advertisements never promote
    const quietNotify = vi.fn();
    const m2 = createRuntimeUpgradeMonitor({ probe, notify: quietNotify });
    m2.onAdvertisement(compatibleAdvertisement());
    m2.onAdvertisement(undefined);
    expect(quietNotify).not.toHaveBeenCalled();
  });

  it("unrelated signals never probe: non-426 status, malformed body, foreign 426 body", async () => {
    const probe = vi.fn(async () => tooOldAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(401, UPGRADE_BODY);
    m.onRestResponse(403, UPGRADE_BODY);
    m.onRestResponse(0, undefined);
    m.onRestResponse(426, undefined);
    m.onRestResponse(426, "not json");
    m.onRestResponse(426, JSON.stringify({ ...JSON.parse(UPGRADE_BODY), error: "something_else" }));
    // a business route could theoretically return 426 with a foreign shape
    m.onRestResponse(426, JSON.stringify({ ...JSON.parse(UPGRADE_BODY), reason: "other" }));
    await flush();
    expect(probe).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a spoofed 426 against a compatible server probes but does NOT notify", async () => {
    const probe = vi.fn(async () => compatibleAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("probe failure is inert (unreachable != upgrade) and the next suspect re-probes", async () => {
    const probe = vi
      .fn<() => Promise<DesktopApiAdvertisement | undefined>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(tooOldAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("concurrent REST suspects coalesce into one in-flight probe", async () => {
    let resolveProbe: (a: DesktopApiAdvertisement) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<DesktopApiAdvertisement>((r) => {
          resolveProbe = r;
        }),
    );
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    m.onRestResponse(426, UPGRADE_BODY);
    m.onRestResponse(426, UPGRADE_BODY);
    expect(probe).toHaveBeenCalledTimes(1);
    resolveProbe(tooOldAdvertisement());
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reset() re-arms after a compatible cycle", async () => {
    const probe = vi.fn(async () => tooOldAdvertisement());
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    m.reset();
    m.onAdvertisement(tooOldAdvertisement());
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("pre-epoch missing advertisement (undefined) never confirms client_too_old", async () => {
    const probe = vi.fn(async () => undefined);
    const notify = vi.fn();
    const m = createRuntimeUpgradeMonitor({ probe, notify });
    m.onRestResponse(426, UPGRADE_BODY);
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });
});
