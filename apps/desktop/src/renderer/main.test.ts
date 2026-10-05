import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ remoteOnly: false, mount: vi.fn(), configure: vi.fn() }));
vi.mock("@silverhand/app-ui", () => ({ mountApp: h.mount, configurePlatform: h.configure }));
vi.mock("../build-flags", () => ({
  get DESKTOP_REMOTE_ONLY() {
    return h.remoteOnly;
  },
}));
vi.mock("./platform", () => ({ createDesktopPlatform: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("document", { getElementById: () => ({}) });
  vi.stubGlobal("window", {
    silverhand: { onFullScreenChange: vi.fn() },
    location: { reload: vi.fn() },
  });
});

it.each([true, false])(
  "desktop remoteOnly=%s controls the auth server editor",
  async (remoteOnly) => {
    h.remoteOnly = remoteOnly;
    await import("./main");
    expect(h.mount).toHaveBeenCalledWith({}, { showServerAddress: remoteOnly });
  },
);
