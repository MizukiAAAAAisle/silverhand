import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mount: vi.fn(),
  configure: vi.fn(),
  profile: vi.fn(),
  save: vi.fn(),
  listen: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  setProperty: vi.fn(),
  removeProperty: vi.fn(),
}));

vi.mock("@silverhand/app-ui", () => ({
  mountApp: h.mount,
  configurePlatform: h.configure,
  resumeApp: vi.fn(),
}));

vi.mock("./bridge", () => ({
  nativeBridge: { getProfile: h.profile, saveProfile: h.save, addListener: h.listen },
}));

vi.mock("./platform", () => ({ createIOSPlatform: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("document", {
    getElementById: () => ({}),
    documentElement: { style: { setProperty: h.setProperty, removeProperty: h.removeProperty } },
  });
});

describe("iOS entry", () => {
  it("uses keyboard spacing only while the native keyboard is docked", async () => {
    h.profile.mockResolvedValue({});
    await import("./main");
    await vi.waitFor(() => expect(h.mount).toHaveBeenCalled());
    const listener = h.listen.mock.calls.find(([event]) => event === "keyboardChanged")![1];
    listener({ docked: true });
    expect(h.setProperty).toHaveBeenLastCalledWith("--input-safe-area-bottom", "0px");
    listener({ docked: false });
    expect(h.removeProperty).toHaveBeenLastCalledWith("--input-safe-area-bottom");
    expect(h.mount).toHaveBeenCalledTimes(1);
  });

  it.each(["https://silverhand.ai", "https://my-server.example"])(
    "opens the shared login directly for %s without rewriting its profile",
    async (url) => {
      h.profile.mockResolvedValue({ server_url: url, updated_at: 0 });
      await import("./main");
      await vi.waitFor(() =>
        expect(h.mount).toHaveBeenCalledWith({}, { loginFirst: true, showServerAddress: true }),
      );
      expect(h.save).not.toHaveBeenCalled();
    },
  );
});
