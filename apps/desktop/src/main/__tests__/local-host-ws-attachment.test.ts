import { describe, expect, it } from "vitest";
import { describeLocalHostWsAttachment } from "../local-host/local-host-ws-attachment";

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
});
