import { describe, expect, it, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { clearPersistedDesktopSession } from "../client/desktop-session-storage";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  unlinkSync: vi.fn(),
}));

describe("session deletion failure", () => {
  it("propagates EACCES instead of reporting credential cleanup success", () => {
    const error = Object.assign(new Error("access denied"), { code: "EACCES" });
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => clearPersistedDesktopSession({ sessionPath: "/isolated/session" })).toThrow(error);
  });

  it("treats only ENOENT as already cleared", () => {
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() => clearPersistedDesktopSession({ sessionPath: "/isolated/session" })).not.toThrow();
  });
});
