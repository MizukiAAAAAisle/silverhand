import { describe, expect, it } from "vitest";
import { describeLocalHostWsAttachment } from "../local-host-ws-attachment";

describe("describeLocalHostWsAttachment (#task:1630 / #task:2343)", () => {
  it("a local registry observer with nothing attached is observable-but-empty, NOT unobservable", () => {
    // Falsifier for shortcut (2): deriving `observable` from the timestamp. "Nothing
    // attached yet" is a value INSIDE the observable arm.
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: true, attachedAt: null }),
    ).toEqual({ observable: true, attached_at: null });
  });

  it("a local registry observer with an attach timestamp surfaces it", () => {
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: true, attachedAt: 1_700 }),
    ).toEqual({ observable: true, attached_at: 1_700 });
  });

  it("no local observer is unobservable and never leaks a timestamp", () => {
    // with an out-of-process backend (Rust embedded OR remote) there is no
    // in-process registry to read. Even if a caller hands a number, the no-observer case
    // must not promote to observable.
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: false, attachedAt: null }),
    ).toEqual({ observable: false });
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: false, attachedAt: 1_700 }),
    ).toEqual({ observable: false });
  });

  it("observability tracks the CAPABILITY (local observer), not deployment kind", () => {
    // Same timestamp, two capability answers — the property this producer exists to hold.
    // #task:2343: it is NOT derived from backend.kind; a Rust embedded backend is
    // out-of-process and reports no local observer, exactly like remote.
    const attachedAt = 42;
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: true, attachedAt }).observable,
    ).toBe(true);
    expect(
      describeLocalHostWsAttachment({ hasLocalRegistryObserver: false, attachedAt }).observable,
    ).toBe(false);
  });
});
