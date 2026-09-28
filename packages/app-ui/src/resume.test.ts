import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  set: vi.fn(),
  invalidate: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("./platform", () => ({ getPlatform: () => ({ client: { getAuthState: mocks.auth } }) }));
vi.mock("./lib/query-client", () => ({
  queryClient: { setQueryData: mocks.set, invalidateQueries: mocks.invalidate },
}));
vi.mock("./lib/ws-client", () => ({ eventWsClient: { connect: mocks.connect } }));
vi.mock("./features/session/hooks", () => ({
  mapAuthStateToViewer: (state: { user: unknown }) => state.user,
}));
import { resumeApp } from "./resume";

describe("resumeApp", () => {
  it("refreshes the same authenticated viewer and snapshots without clearing the cache", async () => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ status: "authenticated", user: { id: "same-viewer" } });
    await resumeApp();
    expect(mocks.set).toHaveBeenCalledWith(["me"], { id: "same-viewer" });
    expect(mocks.connect).toHaveBeenCalledOnce();
    const filter = mocks.invalidate.mock.calls[0]![0].predicate;
    expect(filter({ queryKey: ["me"] })).toBe(false);
    expect(filter({ queryKey: ["messages", "channel"] })).toBe(true);
  });
  it("keeps the mounted viewer on transient network failure while retrying transport", async () => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ status: "backend_unreachable" });
    await resumeApp();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
});
