import { describe, expect, it } from "vitest";
import {
  deriveRuntimePickerMode,
  runtimeChipDisabled,
  runtimeSectionHint,
} from "./runtime-detection-ui";

describe("deriveRuntimePickerMode", () => {
  it("no host chosen → no-host (precedes every async signal)", () => {
    expect(
      deriveRuntimePickerMode({
        hasHost: false,
        isHostAvailabilityLoading: false,
        hostAvailable: false,
        isLoading: true,
        isError: true,
      }),
    ).toBe("no-host");
  });

  it("host availability still resolving → probing, NEVER offline (freshness ≠ fact)", () => {
    // Regression: the `useHostAvailabilityMap` map returns `undefined` for
    // any hostId until the first status probe settles. Treating that gap as
    // offline flashed "Connect the computer to detect runtimes" for ~50ms
    // on every RuntimeConfigEditor edit-enter (Cindy #1472 round-7 HIGH).
    expect(
      deriveRuntimePickerMode({
        hasHost: true,
        isHostAvailabilityLoading: true,
        hostAvailable: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe("probing");
  });

  it("settled + host disconnected → offline (only after availability is a fact)", () => {
    expect(
      deriveRuntimePickerMode({
        hasHost: true,
        isHostAvailabilityLoading: false,
        hostAvailable: false,
        isLoading: false,
        isError: false,
      }),
    ).toBe("offline");
  });

  it("available + loading → probing", () => {
    expect(
      deriveRuntimePickerMode({
        hasHost: true,
        isHostAvailabilityLoading: false,
        hostAvailable: true,
        isLoading: true,
        isError: false,
      }),
    ).toBe("probing");
  });

  it("available + error → probe-failed (transport unknown-for-all)", () => {
    expect(
      deriveRuntimePickerMode({
        hasHost: true,
        isHostAvailabilityLoading: false,
        hostAvailable: true,
        isLoading: false,
        isError: true,
      }),
    ).toBe("probe-failed");
  });

  it("available + fresh result → detected", () => {
    expect(
      deriveRuntimePickerMode({
        hasHost: true,
        isHostAvailabilityLoading: false,
        hostAvailable: true,
        isLoading: false,
        isError: false,
      }),
    ).toBe("detected");
  });
});

describe("runtimeChipDisabled — the false-negative guard", () => {
  it("disables only a deterministically-absent runtime in the detected mode", () => {
    expect(runtimeChipDisabled("detected", "absent")).toBe(true);
  });

  it("never disables present / present_unverified / unknown", () => {
    expect(runtimeChipDisabled("detected", "present")).toBe(false);
    expect(runtimeChipDisabled("detected", "present_unverified")).toBe(false);
    // `unknown` is a probe hiccup, not an install verdict — must stay pickable.
    expect(runtimeChipDisabled("detected", "unknown")).toBe(false);
  });

  it("never disables in a non-detected mode, even if a stale state reads absent", () => {
    // A probe gap (offline / probing / probe-failed / no-host) must not trap
    // an installed runtime — this is the exact false-negative #1376 kills.
    for (const mode of ["no-host", "offline", "probing", "probe-failed"] as const) {
      expect(runtimeChipDisabled(mode, "absent")).toBe(false);
    }
  });

  it("treats a missing state entry as non-disabling", () => {
    expect(runtimeChipDisabled("detected", undefined)).toBe(false);
  });
});

describe("runtimeSectionHint", () => {
  it("offline / probe-failed carry a hint; the rest stay quiet", () => {
    expect(runtimeSectionHint("offline")).toMatch(/Connect/);
    expect(runtimeSectionHint("probe-failed")).toMatch(/Recheck/);
    expect(runtimeSectionHint("no-host")).toBeNull();
    expect(runtimeSectionHint("probing")).toBeNull();
    expect(runtimeSectionHint("detected")).toBeNull();
  });
});
