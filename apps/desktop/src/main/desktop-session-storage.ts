import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DesktopSessionStorageLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export function clearPersistedDesktopSession(opts: {
  sessionPath: string;
  logger?: DesktopSessionStorageLogger | null;
}): void {
  try {
    unlinkSync(opts.sessionPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      opts.logger?.warn({ err }, "failed to remove desktop auth session file");
    }
  }
}

export function loadPersistedDesktopSessionToken(opts: {
  sessionPath: string;
  logger?: DesktopSessionStorageLogger | null;
}): string | null {
  if (!existsSync(opts.sessionPath)) return null;
  try {
    const token = readFileSync(opts.sessionPath, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    opts.logger?.warn({ err }, "failed to read desktop auth session file; clearing");
    clearPersistedDesktopSession(opts);
    return null;
  }
}

export function persistDesktopSessionToken(opts: {
  sessionPath: string;
  token: string;
  logger?: DesktopSessionStorageLogger | null;
}): void {
  mkdirSync(dirname(opts.sessionPath), { recursive: true });
  writeFileSync(opts.sessionPath, opts.token, { mode: 0o600 });
  try {
    chmodSync(opts.sessionPath, 0o600);
  } catch (err) {
    opts.logger?.warn({ err }, "failed to chmod desktop auth session file");
  }
}
