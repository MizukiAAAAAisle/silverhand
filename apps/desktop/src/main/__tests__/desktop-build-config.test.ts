import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveBootProfile } from "../shell/desktop-build-config.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(20);
});
afterEach(() => vi.useRealTimers());

describe("resolveEffectiveBootProfile", () => {
  it("keeps a saved profile ahead of the package-time default URL", () => {
    const result = resolveEffectiveBootProfile({
      savedProfileView: {
        server_url: "https://saved.example.test",
        updated_at: 10,
      },
      packagedDefaultServerUrl: "https://default.example.test",
      allowInsecureRemote: false,
      remoteOnly: true,
    });

    expect(result).toEqual({
      source: "saved_profile",
      profileView: {
        server_url: "https://saved.example.test",
        updated_at: 10,
      },
      warning: null,
    });
  });

  it("uses the package-time default URL when no profile is saved", () => {
    const result = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "HTTPS://Default.Example.Test/",
      allowInsecureRemote: false,
      remoteOnly: true,
    });

    expect(result).toEqual({
      source: "packaged_default",
      profileView: {
        server_url: "https://default.example.test",
        updated_at: 20,
      },
      warning: null,
    });
  });

  it("accepts package-time http remote only when the build explicitly allows it", () => {
    const rejected = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "http://203.0.113.10:8080",
      allowInsecureRemote: false,
      remoteOnly: true,
    });
    expect(rejected.source).toBe("none");
    expect(rejected.profileView).toBeNull();
    expect(rejected.warning?.reason).toBe("packaged_default_invalid");

    const accepted = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "http://203.0.113.10:8080",
      allowInsecureRemote: true,
      remoteOnly: true,
    });
    expect(accepted).toEqual({
      source: "packaged_default",
      profileView: {
        server_url: "http://203.0.113.10:8080",
        updated_at: 20,
      },
      warning: null,
    });
  });

  it("rejects a loopback package-time default in remote-only builds", () => {
    const result = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "http://127.0.0.1:7321",
      allowInsecureRemote: false,
      remoteOnly: true,
    });

    expect(result.profileView).toBeNull();
    expect(result.source).toBe("none");
    expect(result.warning?.reason).toBe("packaged_default_loopback_remote_only");
  });

  it("allows a loopback package-time default for normal embedded-capable builds", () => {
    const result = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "http://127.0.0.1:7321",
      allowInsecureRemote: false,
      remoteOnly: false,
    });

    expect(result).toEqual({
      source: "packaged_default",
      profileView: {
        server_url: "http://127.0.0.1:7321",
        updated_at: 20,
      },
      warning: null,
    });
  });

  it("surfaces invalid package-time defaults as warnings instead of rewriting saved state", () => {
    const result = resolveEffectiveBootProfile({
      savedProfileView: null,
      packagedDefaultServerUrl: "https://backend.example.test/path",
      allowInsecureRemote: false,
      remoteOnly: false,
    });

    expect(result.source).toBe("none");
    expect(result.profileView).toBeNull();
    expect(result.warning?.reason).toBe("packaged_default_invalid");
  });
});
