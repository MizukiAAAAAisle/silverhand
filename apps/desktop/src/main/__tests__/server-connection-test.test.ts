import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeServerInfo } from "../server-connection-test.js";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connection probe", () => {
  it.each([
    ["http://127.0.0.1:7321/", false, true, "loopback_ok", "http://127.0.0.1:7321"],
    [
      "https://backend.example.test",
      false,
      false,
      "system_ca_verified",
      "https://backend.example.test",
    ],
    [
      "HTTPS://Backend.Example.Test:443/",
      false,
      false,
      "system_ca_verified",
      "https://backend.example.test",
    ],
    ["http://10.0.0.5:8080", true, true, "insecure_dev_remote", "http://10.0.0.5:8080"],
  ] as const)(
    "probes %s and returns the persistable origin",
    async (serverUrl, allowInsecureRemote, signup_enabled, kind, originUrl) => {
      fetchMock.mockResolvedValue(Response.json({ signup_enabled }));
      expect(await probeServerInfo({ serverUrl, allowInsecureRemote })).toEqual({
        ok: true,
        kind,
        info: { signup_enabled },
        originUrl,
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(originUrl + "/api/server/info", {
        signal: expect.any(AbortSignal),
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["http://10.0.0.5", false, "insecure_remote_http_disallowed"],
    ["http://127.000.000.001", true, "obfuscated_loopback_disallowed"],
  ] as const)(
    "rejects %s before any network I/O",
    async (serverUrl, allowInsecureRemote, reason) => {
      fetchMock.mockResolvedValue(Response.json({ signup_enabled: true }));
      expect(await probeServerInfo({ serverUrl, allowInsecureRemote })).toMatchObject({
        ok: false,
        kind: "classify_rejected",
        reason,
        message: expect.any(String),
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [{ code: "CERT_HAS_EXPIRED" }, "host_tls_expired"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "host_tls_hostname_mismatch"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "host_tls_chain_invalid"],
    [
      { code: "ERR_SSL_CERTIFICATE_VERIFY_FAILED", cause: { code: "CERT_HAS_EXPIRED" } },
      "host_tls_expired",
    ],
  ] as const)("maps TLS failure %j", async (error, code) => {
    fetchMock.mockRejectedValue(error);
    expect(
      await probeServerInfo({
        serverUrl: "https://backend.example.test",
        allowInsecureRemote: false,
      }),
    ).toMatchObject({ ok: false, kind: "tls_failed", code });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves HTTP status and diagnostic body", async () => {
    fetchMock.mockResolvedValue(
      new Response("route not registered", { status: 404, statusText: "Not Found" }),
    );
    expect(
      await probeServerInfo({
        serverUrl: "https://backend.example.test",
        allowInsecureRemote: false,
      }),
    ).toEqual({
      ok: false,
      kind: "http_failed",
      status: 404,
      statusText: "Not Found",
      bodyText: "route not registered",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Error("connect ECONNREFUSED"), "socket unavailable"])(
    "preserves underlying non-TLS failure %s",
    async (error) => {
      fetchMock.mockRejectedValue(error);
      const result = await probeServerInfo({
        serverUrl: "https://backend.example.test",
        allowInsecureRemote: false,
      });
      expect(result).toEqual({
        ok: false,
        kind: "network_failed",
        message: error instanceof Error ? error.message : error,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["<html>not silverhand</html>", /not valid JSON/],
    [JSON.stringify({ unexpected: "shape" }), /signup_enabled/],
  ])("rejects invalid response body %s", async (body, diagnostic) => {
    fetchMock.mockResolvedValue(new Response(body));
    expect(
      await probeServerInfo({
        serverUrl: "https://backend.example.test",
        allowInsecureRemote: false,
      }),
    ).toMatchObject({
      ok: false,
      kind: "invalid_response",
      message: expect.stringMatching(diagnostic),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an unresponsive fetch at the production 10-second deadline, not earlier", async () => {
    let signal!: AbortSignal;
    fetchMock.mockImplementation((_url, init) => {
      signal = init!.signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const settled = vi.fn();
    const pending = probeServerInfo({
      serverUrl: "https://blackhole.example.test",
      allowInsecureRemote: false,
    }).then((result) => {
      settled(result);
      return result;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({
      ok: false,
      kind: "network_failed",
      message:
        "Request to https://blackhole.example.test/api/server/info timed out after 10000 ms.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
