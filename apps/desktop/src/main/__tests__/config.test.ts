import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDesktopAppPaths } from "@silverhand/shared/app-data-layout";
import {
  electronUserDataPath,
  loadOrCreateServerConfig,
  shouldRedirectElectronUserData,
  silverhandDir,
  writeServerConfig,
} from "../config.js";

const fixtureParent = process.env.SILVERHAND_DIR;
if (!fixtureParent) throw new Error("config tests require an isolated SILVERHAND_DIR");

describe("desktop config storage", () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(fixtureParent, { recursive: true });
    root = mkdtempSync(join(fixtureParent, "config-"));
    vi.stubEnv("SILVERHAND_DIR", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates new embedded config without retired credentials", async () => {
    const config = await loadOrCreateServerConfig();
    expect(config.auth_token).toBeUndefined();
    const raw = JSON.parse(
      readFileSync(resolveDesktopAppPaths(root).embeddedServer.serverConfig, "utf8"),
    );
    expect(raw).not.toHaveProperty("auth_token");
    expect(raw).toMatchObject({ mode: "embedded", url: "http://127.0.0.1:0", refresh_token: null });
  });

  it("reads legacy fields but strips retired credentials and generated origins on rewrite", async () => {
    const path = resolveDesktopAppPaths(root).embeddedServer.serverConfig;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mode: "embedded",
        url: "http://127.0.0.1:4321",
        auth_token: "a".repeat(32),
        refresh_token: null,
        event_ws_allowed_origins: ["http://127.0.0.1:1111"],
        child_sessions: {
          max_concurrent_per_parent: null,
          spawn_cooldown_seconds: null,
          max_depth: 1,
        },
      }),
      { mode: 0o600 },
    );
    const config = await loadOrCreateServerConfig();
    expect(config.auth_token).toBe("a".repeat(32));
    expect(config.event_ws_allowed_origins).toEqual(["http://127.0.0.1:1111"]);
    await writeServerConfig(config);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).not.toHaveProperty("auth_token");
    expect(raw).not.toHaveProperty("event_ws_allowed_origins");
    expect(raw).toMatchObject({
      mode: "embedded",
      url: "http://127.0.0.1:4321",
      refresh_token: null,
      child_sessions: { max_depth: 1 },
    });
  });

  it("places Electron userData beneath the configured root", () => {
    expect(electronUserDataPath()).toBe(join(root, "desktop", "electron-user-data"));
  });
});

describe("Desktop root and Electron redirect policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, "", "   ", "/x/y", " /x/y "])(
    "handles SILVERHAND_DIR=%s without touching disk",
    (value) => {
      vi.stubEnv("SILVERHAND_DIR", value);
      const configured = value !== undefined && value.trim() !== "";
      expect(silverhandDir()).toBe(configured ? "/x/y" : join(homedir(), ".silverhand"));
      expect(shouldRedirectElectronUserData()).toBe(configured);
    },
  );
});
