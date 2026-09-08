import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fetchBackendBlob: vi.fn(),
}));

import { fetchBackendBlob } from "./api";
import { clearAvatarBlobCache, getAvatarBlobUrl, loadAvatarBlobUrl } from "./avatar-blob-cache";

const fetchMock = vi.mocked(fetchBackendBlob);
const revokeObjectURL = vi.fn();

// Each successful fetch returns a distinct object URL derived from the path so
// tests can assert identity + which url got revoked.
function blob(path: string) {
  return { url: `blob:${path}`, contentType: "image/png", filename: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });
  clearAvatarBlobCache();
  revokeObjectURL.mockClear();
  fetchMock.mockImplementation(async (path: string) => blob(path));
});

afterEach(() => {
  clearAvatarBlobCache();
  vi.unstubAllGlobals();
});

describe("avatar-blob-cache — app-session avatar cache (#task:1321)", () => {
  it("fetches an avatar_url once and reuses it (the core repro: no refetch)", async () => {
    const first = await loadAvatarBlobUrl("/a?v=1");
    const second = await loadAvatarBlobUrl("/a?v=1");
    expect(first).toBe("blob:/a?v=1");
    expect(second).toBe("blob:/a?v=1");
    // The whole point: one network fetch for the session, not one per caller.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("de-dupes concurrent fetches for the same url (screen full of one author)", async () => {
    let resolve!: (v: ReturnType<typeof blob>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const p1 = loadAvatarBlobUrl("/a?v=1");
    const p2 = loadAvatarBlobUrl("/a?v=1");
    resolve(blob("/a?v=1"));
    expect(await p1).toBe("blob:/a?v=1");
    expect(await p2).toBe("blob:/a?v=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getAvatarBlobUrl peeks synchronously: undefined before, url after", async () => {
    expect(getAvatarBlobUrl("/a?v=1")).toBeUndefined();
    await loadAvatarBlobUrl("/a?v=1");
    expect(getAvatarBlobUrl("/a?v=1")).toBe("blob:/a?v=1");
  });

  it("a changed avatar (?v bump) is a new key → fresh fetch, old still cached", async () => {
    await loadAvatarBlobUrl("/a?v=1");
    const bumped = await loadAvatarBlobUrl("/a?v=2");
    expect(bumped).toBe("blob:/a?v=2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAvatarBlobUrl("/a?v=1")).toBe("blob:/a?v=1");
    expect(getAvatarBlobUrl("/a?v=2")).toBe("blob:/a?v=2");
  });

  it("a fetch failure resolves null, is NOT cached, and retries next call", async () => {
    fetchMock.mockRejectedValueOnce(new Error("500"));
    expect(await loadAvatarBlobUrl("/a?v=1")).toBeNull();
    expect(getAvatarBlobUrl("/a?v=1")).toBeUndefined();
    // A later call retries (not stuck on a cached negative) and succeeds.
    expect(await loadAvatarBlobUrl("/a?v=1")).toBe("blob:/a?v=1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearAvatarBlobCache revokes every cached url and forces a refetch", async () => {
    await loadAvatarBlobUrl("/a?v=1");
    await loadAvatarBlobUrl("/b?v=1");
    clearAvatarBlobCache();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:/a?v=1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:/b?v=1");
    expect(getAvatarBlobUrl("/a?v=1")).toBeUndefined();
    // Post-clear the same url refetches (session was reset, e.g. logout).
    await loadAvatarBlobUrl("/a?v=1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never evicts: every distinct avatar stays cached for the whole session (once-per-session contract)", async () => {
    // The contract is "same avatar fetched exactly once for the session" — no
    // size cap that could silently re-fetch a previously-seen avatar. Load many
    // distinct avatars, then assert the FIRST one is still cached (no eviction)
    // and re-requesting it does not re-fetch.
    const N = 500;
    for (let i = 0; i < N; i++) {
      await loadAvatarBlobUrl(`/x?v=${i}`);
    }
    expect(getAvatarBlobUrl("/x?v=0")).toBe("blob:/x?v=0");
    expect(revokeObjectURL).not.toHaveBeenCalled(); // nothing evicted
    fetchMock.mockClear();
    expect(await loadAvatarBlobUrl("/x?v=0")).toBe("blob:/x?v=0");
    expect(fetchMock).not.toHaveBeenCalled(); // served from cache, no refetch
  });

  it("session isolation: an in-flight fetch that resolves AFTER clear does not repopulate the cache (Cindy blocking)", async () => {
    // The leak: logout mid-fetch. The old viewer's slow avatar request must not
    // write its blob into the next viewer's session.
    let resolve!: (v: ReturnType<typeof blob>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));

    const inflightPromise = loadAvatarBlobUrl("/a?v=1"); // starts in generation N
    clearAvatarBlobCache(); // logout → generation N+1, cache emptied
    resolve(blob("/a?v=1")); // the stale fetch finally lands

    // It resolves to null, revokes its own object URL, and does NOT cache.
    expect(await inflightPromise).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:/a?v=1");
    expect(getAvatarBlobUrl("/a?v=1")).toBeUndefined();

    // The new session refetches the same avatar cleanly (fresh generation).
    expect(await loadAvatarBlobUrl("/a?v=1")).toBe("blob:/a?v=1");
    expect(getAvatarBlobUrl("/a?v=1")).toBe("blob:/a?v=1");
  });
});
