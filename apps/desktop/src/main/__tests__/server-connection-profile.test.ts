/**
 * Unit tests for the desktop server-connection-profile storage primitive.
 *
 * V1 local profile storage is intentionally a 0600 plaintext JSON file:
 * desktop is inside the local trust boundary and this profile carries
 * connection metadata, not a bearer credential. These tests pin the file
 * hygiene that still matters: mode 0600, redacted IPC view, typed parse
 * failures, and atomic temp-file cleanup.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearServerConnectionProfile,
  readServerConnectionProfile,
  readServerConnectionProfileViewOrNull,
  writeServerConnectionProfile,
} from "../server-connection-profile.js";

// #task:1598 — the leaf takes the RESOLVED profile path; tests build it
// the way the desktop resolver does.
const serverConnectionProfilePath = (root: string) => join(root, "desktop", "server-profile.bin");

describe("server-connection-profile storage", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "d4a-profile-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("readServerConnectionProfile", () => {
    it("returns not_found when no file exists", () => {
      const result = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns parse_failed when content is not JSON", () => {
      const path = serverConnectionProfilePath(root);
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "http://127.0.0.1:7321",
      });
      writeFileSync(path, "not-json{", { mode: 0o600 });

      const result = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("parse_failed");
    });

    it("returns parse_failed when schema does not match", () => {
      const path = serverConnectionProfilePath(root);
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "http://127.0.0.1:7321",
      });
      writeFileSync(path, '{"version":1}', { mode: 0o600 });

      const result = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("parse_failed");
      if (result.reason !== "parse_failed") throw new Error("unreachable");
      expect(result.detail).toContain("server_url");
    });
  });

  describe("writeServerConnectionProfile", () => {
    it("round-trips: write then read returns the same profile", () => {
      const writeResult = writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://backend.example.test",
        now: () => 1716800000000,
      });
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) throw new Error("unreachable");
      expect(writeResult.profile).toEqual({
        version: 1,
        server_url: "https://backend.example.test",
        created_at: 1716800000000,
        updated_at: 1716800000000,
      });

      const readResult = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) throw new Error("unreachable");
      expect(readResult.profile).toEqual(writeResult.profile);
    });

    it("preserves created_at on overwrite and bumps updated_at AND increments version generation", () => {
      const firstWrite = writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://first.example.test",
        now: () => 1000,
      });
      expect(firstWrite.ok).toBe(true);
      if (!firstWrite.ok) throw new Error("unreachable");
      expect(firstWrite.profile.version).toBe(1);

      const secondWrite = writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://second.example.test",
        now: () => 2000,
      });
      expect(secondWrite.ok).toBe(true);
      if (!secondWrite.ok) throw new Error("unreachable");
      expect(secondWrite.profile).toEqual({
        version: 2,
        server_url: "https://second.example.test",
        created_at: 1000,
        updated_at: 2000,
      });
    });

    it("bumps version on overwrite even when the URL did not change", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://same.example.test",
        now: () => 1000,
      });
      const second = writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://same.example.test",
        now: () => 2000,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.profile.version).toBe(2);
    });

    it("keeps version monotonic across many sequential overwrites", () => {
      let last = 0;
      for (let i = 0; i < 5; i++) {
        const r = writeServerConnectionProfile({
          profilePath: serverConnectionProfilePath(root),
          serverUrl: `https://x${i}.example.test`,
          now: () => 1000 + i,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error("unreachable");
        expect(r.profile.version).toBe(i + 1);
        expect(r.profile.version).toBeGreaterThan(last);
        last = r.profile.version;
      }
    });

    it("writes file with mode 0600", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
      });
      const mode = statSync(serverConnectionProfilePath(root)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("leaves no temp file behind after a successful write", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
      });
      expect(readdirSync(join(root, "desktop"))).toEqual(["server-profile.bin"]);
    });

    it("reports write_failed when the desktop directory cannot be created", () => {
      const rootFile = join(root, "not-a-dir");
      writeFileSync(rootFile, "x");
      const result = writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(rootFile),
        serverUrl: "https://example.test",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("write_failed");
    });
  });

  describe("readServerConnectionProfileViewOrNull", () => {
    it("returns null when no profile exists", () => {
      expect(
        readServerConnectionProfileViewOrNull({ profilePath: serverConnectionProfilePath(root) }),
      ).toBeNull();
    });

    it("returns a redacted view (only server_url + updated_at)", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
        now: () => 4242,
      });
      const view = readServerConnectionProfileViewOrNull({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(view).toEqual({
        server_url: "https://example.test",
        updated_at: 4242,
      });
      expect(Object.keys(view ?? {}).sort()).toEqual(["server_url", "updated_at"]);
    });
  });

  describe("clearServerConnectionProfile", () => {
    it("is idempotent: reports cleared:false when no file exists", () => {
      const result = clearServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result).toEqual({ ok: true, cleared: false });
    });

    it("reports cleared:true when it removes a real file", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
      });
      const path = serverConnectionProfilePath(root);
      expect(existsSync(path)).toBe(true);
      const result = clearServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result).toEqual({ ok: true, cleared: true });
      expect(existsSync(path)).toBe(false);
    });

    it("subsequent reads return not_found after a successful clear", () => {
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
      });
      clearServerConnectionProfile({ profilePath: serverConnectionProfilePath(root) });
      const result = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
      });
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });
  });

  describe("logger seam", () => {
    it("emits a warn line when parse fails", () => {
      const path = serverConnectionProfilePath(root);
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: "https://example.test",
      });
      writeFileSync(path, "not-json{", { mode: 0o600 });

      const warn = vi.fn();
      const result = readServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        logger: { warn, info: vi.fn() },
      });
      expect(result.ok).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      const [payload, msg] = warn.mock.calls[0]!;
      expect(payload).toHaveProperty("path");
      expect(typeof msg).toBe("string");
    });
  });

  describe("on-disk bytes contract", () => {
    it("persists plaintext JSON because V1 local profiles use 0600 local-file policy", () => {
      const url = "https://very-distinctive-string.example.test";
      writeServerConnectionProfile({
        profilePath: serverConnectionProfilePath(root),
        serverUrl: url,
      });
      const onDisk = readFileSync(serverConnectionProfilePath(root), "utf8");
      expect(onDisk).toContain(url);
      expect(JSON.parse(onDisk)).toMatchObject({ server_url: url });
    });
  });
});
