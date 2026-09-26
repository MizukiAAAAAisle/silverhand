import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClientInfoHeader } from "@silverhand/shared";

const mocked = vi.hoisted(() => ({ getVersion: vi.fn() }));
vi.mock("electron", () => ({ app: { getVersion: mocked.getVersion } }));

describe("desktopClientInfoHeaderValue (#task:1530)", () => {
  let dir: string;
  let desktopClientInfoHeaderValue: typeof import("./client-info.js").desktopClientInfoHeaderValue;

  beforeEach(async () => {
    vi.resetModules();
    mocked.getVersion.mockReset().mockReturnValue("0.1.0");
    ({ desktopClientInfoHeaderValue } = await import("./client-info.js"));
    const root = process.env.SILVERHAND_DIR;
    if (!root) throw new Error("client-info test requires isolated SILVERHAND_DIR");
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, "client-info-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("assembles a header the server bounded-parser accepts as valid", () => {
    const header = desktopClientInfoHeaderValue(join(dir, "installation_id"));
    expect(header).toBeTruthy();
    const parsed = parseClientInfoHeader(header!);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      expect(parsed.value).toMatchObject({
        client_surface: "desktop",
        // build defines are absent in the test env → typeof-guard fallbacks
        deployment: "embedded",
        app_version: "0.1.0",
        build_commit: "dev",
        build_dirty: false,
        platform: process.platform,
        arch: process.arch,
      });
      expect(parsed.value.installation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(parsed.value.installation_id).toBe(
        readFileSync(join(dir, "installation_id"), "utf8").trim(),
      );
    }
  });

  it("is fail-open: an unrepresentable version yields null, never throws", () => {
    mocked.getVersion.mockReturnValue("has space (invalid)");
    const warn = vi.fn();
    expect(desktopClientInfoHeaderValue(join(dir, "installation_id"), { warn })).toBeNull();
    expect(desktopClientInfoHeaderValue(join(dir, "installation_id"), { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("memoizes the assembled header across calls", () => {
    const first = desktopClientInfoHeaderValue(join(dir, "installation_id"));
    mocked.getVersion.mockReturnValue("0.2.0");
    const second = desktopClientInfoHeaderValue(join(dir, "installation_id"));
    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(mocked.getVersion).toHaveBeenCalledTimes(1);
  });
});
