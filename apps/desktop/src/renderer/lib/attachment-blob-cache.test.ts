import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fetchAttachmentBlob: vi.fn(),
}));

import { fetchAttachmentBlob } from "./api";
import {
  __resetAttachmentBlobCacheForTest,
  bumpAttachmentBlobEpoch,
  bumpAttachmentRevision,
  getAttachmentBlobUrl,
  loadAttachmentBlobUrl,
  readAttachmentToken,
  releaseAttachmentPreview,
  setAttachmentBlobUrl,
} from "./attachment-blob-cache";

const fetchMock = vi.mocked(fetchAttachmentBlob);
const revokeObjectURL = vi.fn();

function blob(url: string) {
  return { url, contentType: "image/png", filename: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });
  __resetAttachmentBlobCacheForTest();
  revokeObjectURL.mockClear();
  // Default: each fetch returns a URL stamped with the token it was served under.
  fetchMock.mockImplementation(async (id: string) => blob(`blob:${id}@${readAttachmentToken(id)}`));
});

afterEach(() => {
  __resetAttachmentBlobCacheForTest();
  vi.unstubAllGlobals();
});

describe("attachment-blob-cache — generation token (#task:1769)", () => {
  it("reads back a cached url only at its own generation token", async () => {
    const url = await loadAttachmentBlobUrl("att1");
    expect(url).toBe("blob:att1@0:0");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:att1@0:0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("de-dupes concurrent loads for the same id + token", async () => {
    let resolve!: (v: ReturnType<typeof blob>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const p1 = loadAttachmentBlobUrl("att1");
    const p2 = loadAttachmentBlobUrl("att1");
    resolve(blob("blob:once"));
    expect(await p1).toBe("blob:once");
    expect(await p2).toBe("blob:once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a revision bump makes the cached entry a stale MISS (does not revoke the displayed url)", async () => {
    await loadAttachmentBlobUrl("att1");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:att1@0:0");

    bumpAttachmentRevision("att1", 1);
    // Stale entry is a miss so a fresh load refetches...
    expect(getAttachmentBlobUrl("att1")).toBeUndefined();
    // ...but the old url is NOT revoked — a displayed <img> keeps working until
    // the fresher url replaces it.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    const fresh = await loadAttachmentBlobUrl("att1");
    expect(fresh).toBe("blob:att1@0:1");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:att1@0:1");
    // Replacing the entry for the same id revokes the superseded url.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:att1@0:0");
  });

  it("bumpAttachmentRevision is idempotent — a non-newer revision is ignored", () => {
    bumpAttachmentRevision("att1", 2);
    expect(readAttachmentToken("att1")).toBe("0:2");
    bumpAttachmentRevision("att1", 2); // equal → no-op
    bumpAttachmentRevision("att1", 1); // older → no-op
    expect(readAttachmentToken("att1")).toBe("0:2");
  });

  it("the epoch bump coarse-invalidates EVERY cached blob (gap recovery)", async () => {
    await loadAttachmentBlobUrl("att1");
    await loadAttachmentBlobUrl("att2");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:att1@0:0");
    expect(getAttachmentBlobUrl("att2")).toBe("blob:att2@0:0");

    bumpAttachmentBlobEpoch();

    // Both are misses now — the dropped event's id is unknowable.
    expect(getAttachmentBlobUrl("att1")).toBeUndefined();
    expect(getAttachmentBlobUrl("att2")).toBeUndefined();
    expect(await loadAttachmentBlobUrl("att1")).toBe("blob:att1@1:0");
  });

  it("a late fetch resolving after the token moved does NOT write back stale bytes", async () => {
    let resolveStale!: (v: ReturnType<typeof blob>) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));

    const inflight = loadAttachmentBlobUrl("att1"); // fetch started at token 0:0
    bumpAttachmentRevision("att1", 1); // token → 0:1 while the fetch is in flight
    resolveStale(blob("blob:stale")); // the stale fetch finally lands

    // It revokes its own now-stale url and re-drives to the current generation.
    const resolved = await inflight;
    expect(resolved).toBe("blob:att1@0:1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:att1@0:1");
  });

  it("setAttachmentBlobUrl records a known revision so a redelivered event is a no-op", () => {
    setAttachmentBlobUrl("att1", "blob:seed", 4);
    expect(readAttachmentToken("att1")).toBe("0:4");
    expect(getAttachmentBlobUrl("att1")).toBe("blob:seed");
    // A redelivered attachment_changed for the same revision changes nothing.
    bumpAttachmentRevision("att1", 4);
    expect(getAttachmentBlobUrl("att1")).toBe("blob:seed");
  });

  it("releaseAttachmentPreview revokes and drops the entry", async () => {
    await loadAttachmentBlobUrl("att1");
    releaseAttachmentPreview("att1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:att1@0:0");
    expect(getAttachmentBlobUrl("att1")).toBeUndefined();
  });
});
