import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPersistedDesktopSession,
  loadPersistedDesktopSessionToken,
  persistDesktopSessionToken,
} from "../client/desktop-session-storage.js";

const desktopSessionPath = (root: string) => join(root, "desktop", "session.bin");

describe("desktop-session-storage", () => {
  let root: string;

  beforeEach(() => {
    const artifacts = process.env.SILVERHAND_DIR;
    if (!artifacts) throw new Error("session storage test requires isolated SILVERHAND_DIR");
    mkdirSync(artifacts, { recursive: true });
    root = mkdtempSync(join(artifacts, "desktop-session-storage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stores the session bearer as a 0600 plaintext local file", () => {
    persistDesktopSessionToken({
      sessionPath: desktopSessionPath(root),
      token: "session-token-plain",
    });

    const path = desktopSessionPath(root);
    expect(readFileSync(path, "utf8")).toBe("session-token-plain");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    persistDesktopSessionToken({ sessionPath: path, token: "replacement-token" });
    expect(readFileSync(path, "utf8")).toBe("replacement-token");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("loads a persisted token and trims trailing whitespace", () => {
    persistDesktopSessionToken({ sessionPath: desktopSessionPath(root), token: "abc\n" });
    expect(loadPersistedDesktopSessionToken({ sessionPath: desktopSessionPath(root) })).toBe("abc");
  });

  it("treats missing or empty files as no token", () => {
    expect(loadPersistedDesktopSessionToken({ sessionPath: desktopSessionPath(root) })).toBeNull();

    persistDesktopSessionToken({ sessionPath: desktopSessionPath(root), token: "" });
    expect(loadPersistedDesktopSessionToken({ sessionPath: desktopSessionPath(root) })).toBeNull();
  });

  it("clears idempotently", () => {
    persistDesktopSessionToken({ sessionPath: desktopSessionPath(root), token: "abc" });
    clearPersistedDesktopSession({ sessionPath: desktopSessionPath(root) });
    expect(existsSync(desktopSessionPath(root))).toBe(false);

    const warn = vi.fn();
    clearPersistedDesktopSession({
      sessionPath: desktopSessionPath(root),
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when an existing session path cannot be read", () => {
    const path = desktopSessionPath(root);
    mkdirSync(path, { recursive: true });
    const warn = vi.fn();

    expect(
      loadPersistedDesktopSessionToken({
        sessionPath: desktopSessionPath(root),
        logger: { warn },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
