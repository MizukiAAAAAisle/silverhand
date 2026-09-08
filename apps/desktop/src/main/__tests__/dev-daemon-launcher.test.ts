import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { desktopDaemonLauncher } from "../daemon-launcher.js";

const repo = resolve(__dirname, "../../../../..");

describe("Desktop dev daemon package launcher", () => {
  it("preserves the packaged launcher and builds the dev package before Desktop starts", () => {
    expect(
      desktopDaemonLauncher({
        isPackaged: true,
        appPath: "/app",
        resourcesPath: "/Resources",
        execPath: "/Electron",
      }),
    ).toEqual({
      command: "/Electron",
      args: ["/Resources/silverhand-daemon/daemon.mjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(
      desktopDaemonLauncher({
        isPackaged: false,
        appPath: "/repo/apps/desktop",
        resourcesPath: "/unused",
        execPath: "/Electron",
      }),
    ).toEqual({
      command: "/Electron",
      args: ["/repo/packages/silverhand-daemon/dist/daemon.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const script = readFileSync(join(repo, "scripts/dev.sh"), "utf8");
    expect(script.indexOf("pnpm --filter @silverhand-ai/daemon build")).toBeGreaterThan(-1);
    expect(script.indexOf("pnpm --filter @silverhand-ai/daemon build")).toBeLessThan(
      script.indexOf("exec pnpm"),
    );
  });
});
