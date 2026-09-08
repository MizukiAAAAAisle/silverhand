import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiUpload, fetchAttachmentBytes, toPathSegment } from "./api";

const silverhand = {
  getBackendInfo: vi.fn(),
  backendRequest: vi.fn(),
  backendUpload: vi.fn(),
};

describe("renderer API proxy", () => {
  beforeEach(() => {
    silverhand.getBackendInfo.mockReset();
    silverhand.backendRequest.mockReset();
    silverhand.backendUpload.mockReset();
    vi.stubGlobal("window", { silverhand });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends ordinary API calls through the main-process proxy", async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ ok: true }),
    });

    await expect(
      api("/api/example", {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(silverhand.backendRequest).toHaveBeenCalledWith({
      path: "/api/example",
      method: "POST",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ a: 1 }),
    });
    expect(silverhand.getBackendInfo).not.toHaveBeenCalled();
  });

  it("surfaces proxy failures as ApiError without retrying legacy auth", async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ error: "unauthorized" }),
    });

    await expect(api("/api/example")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    } satisfies Partial<ApiError>);

    expect(silverhand.backendRequest).toHaveBeenCalledTimes(1);
  });

  it("serializes multipart uploads for the main-process proxy", async () => {
    const form = new FormData();
    form.set("title", "draft");
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "draft.txt", {
        type: "text/plain",
      }),
    );
    silverhand.backendUpload.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ id: "att-1" }),
    });

    await expect(apiUpload("/api/upload", form)).resolves.toEqual({
      id: "att-1",
    });

    expect(silverhand.backendUpload).toHaveBeenCalledTimes(1);
    const input = silverhand.backendUpload.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      path: "/api/upload",
      fields: [{ name: "title", value: "draft" }],
      files: [
        {
          fieldName: "file",
          filename: "draft.txt",
          contentType: "text/plain",
        },
      ],
    });
    expect(Array.from(input.files[0].bytes)).toEqual([1, 2, 3]);
  });
});

describe("ApiError — D4.a Commit 5d-fixup (Cindy P1-2): backend_unreachable kind", () => {
  beforeEach(() => {
    silverhand.getBackendInfo.mockReset();
    silverhand.backendRequest.mockReset();
    silverhand.backendUpload.mockReset();
    vi.stubGlobal("window", { silverhand });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('default kind for ordinary HTTP errors is "http" (regression bait)', async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 404,
      statusText: "Not Found",
      headers: {},
      bodyText: "{}",
    });
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("http");
    expect((caught as ApiError).status).toBe(404);
  });

  it('status: 0 from main-process proxy (network failure) → ApiError.kind = "backend_unreachable"', async () => {
    // Cindy 5d-fixup tighter constraint: `status: 0` MUST NOT fall
    // through as a generic HTTP error. The renderer's gate logic
    // branches on `err.kind === "backend_unreachable"`, so this
    // is the load-bearing pin for that contract. A regression that
    // dropped the special case in `assertOk` would surface as the
    // kind defaulting to `'http'` and the gate failing to render.
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 0,
      statusText: "Network Error",
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({
        error: "backend_unreachable",
        message: "fetch failed",
      }),
    });
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("backend_unreachable");
    expect((caught as ApiError).status).toBe(0);
    expect((caught as ApiError).statusText).toBe("Network Error");
    // Body is preserved verbatim — callers that want to render the
    // underlying error message can JSON.parse it.
    expect((caught as ApiError).body).toContain("backend_unreachable");
    expect((caught as ApiError).body).toContain("fetch failed");
  });

  it("status: 0 with empty statusText still surfaces as backend_unreachable (renderer copy fallback)", async () => {
    // Pin: even when the proxy doesn't supply statusText, the kind
    // discriminator survives. Renderer copy can still display
    // "Network Error" via a fallback constant.
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 0,
      statusText: "",
      headers: {},
      bodyText: "",
    });
    let caught: unknown;
    try {
      await api("/api/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("backend_unreachable");
    expect((caught as ApiError).status).toBe(0);
    // Constructor falls back to "Network Error" when statusText is
    // empty so the renderer always has something to show.
    expect((caught as ApiError).statusText).toBe("Network Error");
  });

  it("apiUpload also tags status: 0 as backend_unreachable (symmetric handling)", async () => {
    silverhand.backendUpload.mockResolvedValueOnce({
      status: 0,
      statusText: "Network Error",
      headers: {},
      bodyText: JSON.stringify({
        error: "backend_unreachable",
        message: "connect ECONNREFUSED",
      }),
    });
    const form = new FormData();
    form.set("field", "value");
    let caught: unknown;
    try {
      await apiUpload("/api/upload", form);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("backend_unreachable");
    expect((caught as ApiError).status).toBe(0);
  });

  it("ApiError constructor accepts explicit kind argument (forward-compat for callers)", async () => {
    // Direct construction — used by `authResultToUser` in
    // features/me/hooks.ts to forward a `result.status === 0`
    // signup/login result through the same typed channel.
    const err = new ApiError(0, "Network Error", "{}", "backend_unreachable");
    expect(err.kind).toBe("backend_unreachable");
    expect(err.message).toContain("Network Error");
  });
});

describe("fetchAttachmentBytes — no-blob-URL contract for open/save paths", () => {
  beforeEach(() => {
    silverhand.getBackendInfo.mockReset();
    silverhand.backendRequest.mockReset();
    silverhand.backendUpload.mockReset();
    vi.stubGlobal("window", { silverhand });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // vi.spyOn attaches transparently and is restored by
    // `vi.restoreAllMocks()`; do NOT `delete URL.createObjectURL`
    // — the descriptor is `configurable` on modern Node so a delete
    // would remove the native implementation for the rest of the
    // worker's test files.
    vi.restoreAllMocks();
  });

  it("fetches the attachment through backendRequest with responseType=arrayBuffer", async () => {
    // Falsifier for a regression that switched back to `fetchBackendBlob`
    // (which constructs a Blob + createObjectURL). This handler ships
    // bytes to IPC — it MUST bypass the display-URL builder entirely.
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
      },
      bodyBytes: new Uint8Array([1, 2, 3, 4]),
    });

    const result = await fetchAttachmentBytes("att_1");

    expect(silverhand.backendRequest).toHaveBeenCalledWith({
      path: "/api/attachments/att_1",
      responseType: "arrayBuffer",
    });
    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("report.pdf");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("returns an OWNED Uint8Array — mutating the transport buffer afterwards does NOT corrupt the result", async () => {
    // Load-bearing pin for the leak fix: if we returned a view over
    // the transport's underlying buffer, downstream consumers (IPC
    // handoff, file write) could observe mutation, and the transport
    // itself would be pinned in memory until every consumer released
    // its reference. Defensive copy = owned lifetime.
    const transport = new Uint8Array([9, 8, 7, 6]);
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream" },
      bodyBytes: transport,
    });

    const { bytes } = await fetchAttachmentBytes("att_2");

    // Overwrite the transport bytes; the returned array must not
    // observe the mutation.
    transport.fill(0);
    expect(Array.from(bytes)).toEqual([9, 8, 7, 6]);
    // And the underlying buffers must not be the same reference.
    expect(bytes.buffer).not.toBe(transport.buffer);
  });

  it("never calls URL.createObjectURL — leak-surface guard", async () => {
    // The whole point of `fetchAttachmentBytes` is to avoid the
    // `URL.createObjectURL` round-trip that `fetchAttachmentBlob`
    // performs for `<img src>` display. `vi.spyOn` wraps the native
    // implementation transparently and is restored by
    // `vi.restoreAllMocks()` in `afterEach`.
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
      bodyBytes: new Uint8Array([1, 2, 3]),
    });

    await fetchAttachmentBytes("att_3");

    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("empty body still returns a well-formed owned Uint8Array (no throw, length 0)", async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream" },
      bodyBytes: undefined,
    });

    const { bytes } = await fetchAttachmentBytes("att_empty");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(0);
  });

  it("surfaces backend errors as ApiError (no silent fallthrough)", async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 404,
      statusText: "Not Found",
      headers: {},
      bodyText: "{}",
    });

    await expect(fetchAttachmentBytes("missing")).rejects.toBeInstanceOf(ApiError);
  });
});

// A request path is built from ids that can arrive out of a URL the user pasted,
// so "stays inside one path segment" is a security contract, not tidiness: main
// resolves the path with `new URL(path, backendUrl)`, which applies WHATWG
// normalization. The check is a SHAPE check on purpose — the renderer does not
// re-implement the backend's id grammar.
describe("toPathSegment", () => {
  it("passes an ordinary id through", () => {
    expect(toPathSegment("kQ7v_2bXaZ0mAbCd")).toBe("kQ7v_2bXaZ0mAbCd");
  });

  it("escapes separators so they cannot open a segment or a query", () => {
    expect(toPathSegment("a/b")).toBe("a%2Fb");
    expect(toPathSegment("a?b=1")).toBe("a%3Fb%3D1");
    expect(toPathSegment("a#b")).toBe("a%23b");
  });

  it("rejects the segments that normalization would erase or escape", () => {
    // `encodeURIComponent` leaves both of these untouched, so encoding alone is
    // a false fix: `/api/tasks/..` resolves to `/api/`.
    expect(toPathSegment(".")).toBeNull();
    expect(toPathSegment("..")).toBeNull();
    // Empty would drop the segment entirely, collapsing onto the collection.
    expect(toPathSegment("")).toBeNull();
  });

  it("renders percent-encoded dot segments inert instead of trusting them", () => {
    // WHATWG reads `%2e%2e` as a dot segment too — but `%` is itself escaped, so
    // the pasted spelling can never reach the parser as one.
    expect(toPathSegment("%2E%2E")).toBe("%252E%252E");
    expect(toPathSegment("..%2F..")).toBe("..%252F..");
  });
});
