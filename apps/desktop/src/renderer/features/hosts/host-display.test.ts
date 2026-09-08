import { describe, expect, it } from "vitest";
import type { HostDto } from "@silverhand/shared";
import {
  computerUnavailableLabel,
  hostDisplayName,
  isComputerAvailable,
  resolveComputerName,
  UNKNOWN_COMPUTER_LABEL,
} from "./host-display";

function makeHost(partial: Partial<HostDto>): HostDto {
  return {
    id: "host_1",
    name: "mbp14",
    kind: "local",
    created_at: 0,
    revoked_at: null,
    last_seen_at: null,
    activated_at: null,
    finalized_at: null,
    connected_host_name: null,
    provisioning_source: "system",
    status: "active",
    placeable: true,
    creator_user_id: null,
    display_label: null,
    ...partial,
  } as HostDto;
}

describe("hostDisplayName", () => {
  it("prefers the user rename (display_label) over the stable name", () => {
    expect(hostDisplayName(makeHost({ name: "mbp14", display_label: "Work laptop" }))).toBe(
      "Work laptop",
    );
  });

  it("falls back to name when display_label is null", () => {
    expect(hostDisplayName(makeHost({ name: "mbp14", display_label: null }))).toBe("mbp14");
  });

  it("falls back to name when display_label is whitespace-only", () => {
    expect(hostDisplayName(makeHost({ name: "mbp14", display_label: "   " }))).toBe("mbp14");
  });
});

describe("resolveComputerName", () => {
  it("resolves a known host to its display name", () => {
    expect(resolveComputerName(makeHost({ display_label: "Work laptop" }))).toBe("Work laptop");
  });

  it("returns the restrained fallback for an unknown/deleted host", () => {
    expect(resolveComputerName(undefined)).toBe(UNKNOWN_COMPUTER_LABEL);
  });
});

describe("isComputerAvailable", () => {
  it("is true only when the daemon reports available", () => {
    expect(isComputerAvailable("available")).toBe(true);
  });

  it("is false for offline / unreachable / revoked", () => {
    expect(isComputerAvailable("disconnected")).toBe(false);
    expect(isComputerAvailable("unreachable")).toBe(false);
    expect(isComputerAvailable("revoked")).toBe(false);
  });

  it("is false while the probe is still loading (undefined)", () => {
    expect(isComputerAvailable(undefined)).toBe(false);
  });
});

describe("computerUnavailableLabel", () => {
  it("has no badge for an available computer", () => {
    expect(computerUnavailableLabel("available")).toBeNull();
  });

  it("surfaces a distinct, non-empty badge for each unavailable reason", () => {
    const labels = [
      computerUnavailableLabel("disconnected"),
      computerUnavailableLabel("unreachable"),
      computerUnavailableLabel("revoked"),
    ];
    for (const l of labels) {
      expect(l).not.toBeNull();
      expect(l!.length).toBeGreaterThan(0);
    }
    // The three reasons must not collapse to one badge.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("shows a non-empty loading badge while the status probe is in flight", () => {
    const l = computerUnavailableLabel(undefined);
    expect(l).not.toBeNull();
    expect(l!.length).toBeGreaterThan(0);
  });
});
