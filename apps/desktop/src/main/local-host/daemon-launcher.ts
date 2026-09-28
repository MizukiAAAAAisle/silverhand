import { join, resolve } from "node:path";

/** Dev builds the complete daemon package in scripts/dev.sh. Keep the CLI
 * beside the daemon so launcher resolution stays local to the deployed bundle.
 * Packaged Desktop keeps its existing Resources layout. */
export function desktopDaemonLauncher(input: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  execPath: string;
}): { command: string; args: string[]; env: Record<string, string> } {
  const entry = input.isPackaged
    ? join(input.resourcesPath, "silverhand-daemon", "daemon.mjs")
    : join(resolve(input.appPath, "../.."), "packages/silverhand-daemon/dist/daemon.js");
  return {
    command: input.execPath,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
