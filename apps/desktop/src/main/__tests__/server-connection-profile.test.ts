import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearServerConnectionProfile,
  readServerConnectionProfile,
  readServerConnectionProfileViewOrNull,
  writeServerConnectionProfile,
} from "../server-connection-profile.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const fixtureParent = process.env.SILVERHAND_DIR;
if (!fixtureParent) throw new Error("profile tests require an isolated SILVERHAND_DIR");

describe("server profile storage", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    mkdirSync(fixtureParent, { recursive: true });
    root = mkdtempSync(join(fixtureParent, "profile-"));
    path = join(root, "desktop", "server-profile.bin");
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.mocked(renameSync).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes private plaintext JSON and reads the same literal profile", () => {
    const expected = {
      version: 1,
      server_url: "https://backend.example.test",
      created_at: 1_000,
      updated_at: 1_000,
    };
    expect(
      writeServerConnectionProfile({ profilePath: path, serverUrl: expected.server_url }),
    ).toEqual({ ok: true, profile: expected });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expected);
    expect(readServerConnectionProfile({ profilePath: path })).toEqual({
      ok: true,
      profile: expected,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path))).toEqual(["server-profile.bin"]);
  });

  it("advances generations for changed and unchanged URLs, preserving creation time on disk", () => {
    for (const [index, url] of [
      "https://first.example.test",
      "https://second.example.test",
      "https://second.example.test",
      "https://third.example.test",
    ].entries()) {
      vi.setSystemTime(1_000 + index);
      expect(writeServerConnectionProfile({ profilePath: path, serverUrl: url }).ok).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: index + 1,
        server_url: url,
        created_at: 1_000,
        updated_at: 1_000 + index,
      });
      if (index === 0) chmodSync(path, 0o644);
      else expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["not-json{", /.+/],
    ['{"version":1}', /server_url/],
  ])("reports corrupt bytes %s without replacing them", (bytes, diagnostic) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
    const logger = { warn: vi.fn(), info: vi.fn() };
    expect(readServerConnectionProfile({ profilePath: path, logger })).toMatchObject({
      ok: false,
      reason: "parse_failed",
      detail: expect.stringMatching(diagnostic),
    });
    expect(readServerConnectionProfileViewOrNull({ profilePath: path })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path }),
      expect.any(String),
    );
  });

  it("returns write_failed if the parent cannot be created", () => {
    const parentFile = join(root, "not-a-directory");
    writeFileSync(parentFile, "original");
    expect(
      writeServerConnectionProfile({
        profilePath: join(parentFile, "profile.bin"),
        serverUrl: "https://example.test",
      }),
    ).toMatchObject({ ok: false, reason: "write_failed" });
    expect(readFileSync(parentFile, "utf8")).toBe("original");
  });

  it("keeps old committed bytes and removes staging files when rename fails", () => {
    expect(
      writeServerConnectionProfile({ profilePath: path, serverUrl: "https://old.example.test" }).ok,
    ).toBe(true);
    const before = readFileSync(path);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("controlled rename failure");
    });
    vi.setSystemTime(2_000);
    expect(
      writeServerConnectionProfile({ profilePath: path, serverUrl: "https://new.example.test" }),
    ).toMatchObject({
      ok: false,
      reason: "write_failed",
      detail: expect.stringContaining("controlled rename failure"),
    });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(["server-profile.bin"]);
  });

  it("exposes only the renderer-safe view of a persisted profile", () => {
    expect(
      writeServerConnectionProfile({ profilePath: path, serverUrl: "https://example.test" }).ok,
    ).toBe(true);
    expect(readServerConnectionProfileViewOrNull({ profilePath: path })).toEqual({
      server_url: "https://example.test",
      updated_at: 1_000,
    });
  });

  it("clears a real file and reports absence consistently before and after repeated clear", () => {
    const options = { profilePath: path };
    expect(clearServerConnectionProfile(options)).toEqual({ ok: true, cleared: false });
    expect(readServerConnectionProfile(options)).toEqual({ ok: false, reason: "not_found" });
    expect(readServerConnectionProfileViewOrNull(options)).toBeNull();
    expect(writeServerConnectionProfile({ ...options, serverUrl: "https://example.test" }).ok).toBe(
      true,
    );
    expect(existsSync(path)).toBe(true);
    expect(clearServerConnectionProfile(options)).toEqual({ ok: true, cleared: true });
    expect(existsSync(path)).toBe(false);
    expect(clearServerConnectionProfile(options)).toEqual({ ok: true, cleared: false });
    expect(readServerConnectionProfile(options)).toEqual({ ok: false, reason: "not_found" });
    expect(readServerConnectionProfileViewOrNull(options)).toBeNull();
  });
});
