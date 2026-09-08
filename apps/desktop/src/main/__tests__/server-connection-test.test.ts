/**
 * Coverage:
 *   - Each success arm: loopback_ok, system_ca_verified, insecure_dev_remote.
 *   - classify_rejected mirrors the classifier's failure surface
 *     (smoke-test one case; the classifier itself has its own
 *     deep test file).
 *   - tls_failed maps via classifyTlsError — pin one expired / one
 *     hostname mismatch / one chain invalid case so a future refactor
 *     of the mapper doesn't silently drop one of the three buckets.
 *   - http_failed conveys status, statusText, body.
 *   - network_failed for thrown non-TLS errors.
 *   - invalid_response for non-JSON body and for JSON that doesn't
 *     match ServerInfoSchema.
 */
import { describe, expect, it, vi } from "vitest";
import { probeServerInfo, type FetcherFn } from "../server-connection-test.js";

function fakeFetch(handler: FetcherFn): FetcherFn {
  return handler;
}

function jsonFetcher(body: unknown, status = 200): FetcherFn {
  return fakeFetch(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    text: async () => JSON.stringify(body),
  }));
}

describe("probeServerInfo — success arms", () => {
  it("returns loopback_ok for a 127.0.0.1 URL with a valid ServerInfo body", async () => {
    const result = await probeServerInfo({
      serverUrl: "http://127.0.0.1:7321",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: true }),
    });
    expect(result).toEqual({
      ok: true,
      kind: "loopback_ok",
      info: { signup_enabled: true },
      // D4.a Commit 5 — canonical origin string is included on every
      // success arm. For a no-port url the origin keeps the explicit
      // port; for `http://127.0.0.1:7321` (no path) the origin === input.
      originUrl: "http://127.0.0.1:7321",
    });
  });

  it("returns system_ca_verified for an https remote with a valid body", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://backend.example.test",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: false }),
    });
    expect(result).toEqual({
      ok: true,
      kind: "system_ca_verified",
      info: { signup_enabled: false },
      originUrl: "https://backend.example.test",
    });
  });

  it("returns insecure_dev_remote for an http remote ONLY with the dev flag", async () => {
    const result = await probeServerInfo({
      serverUrl: "http://10.0.0.5:8080",
      allowInsecureRemote: true,
      fetcher: jsonFetcher({ signup_enabled: true }),
    });
    expect(result).toEqual({
      ok: true,
      kind: "insecure_dev_remote",
      info: { signup_enabled: true },
      originUrl: "http://10.0.0.5:8080",
    });
  });

  // D4.a Commit 5 — canonical origin pins. The Setup Wizard / Settings
  // UI persist `originUrl` (NOT the raw user input), so the rest of the
  // desktop main process never sees a non-canonical round-trip. These
  // tests pin the canonical-form transformation across:
  //   - explicit default port (https on 443) gets dropped,
  //   - trailing slash on origin gets dropped,
  //   - mixed-case scheme/host get lowercased by URL parsing.
  it("canonicalizes the origin: explicit default port is dropped", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://backend.example.test:443",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.originUrl).toBe("https://backend.example.test");
  });

  it("canonicalizes the origin: trailing slash is dropped", async () => {
    const result = await probeServerInfo({
      serverUrl: "http://127.0.0.1:7321/",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.originUrl).toBe("http://127.0.0.1:7321");
  });

  it("canonicalizes the origin: mixed-case scheme and host are lowercased", async () => {
    const result = await probeServerInfo({
      serverUrl: "HTTPS://Backend.Example.Test",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.originUrl).toBe("https://backend.example.test");
  });

  it("targets `/api/server/info` against the input base URL", async () => {
    const calls: string[] = [];
    const fetcher: FetcherFn = async (input) => {
      calls.push(input);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ signup_enabled: false }),
      };
    };
    await probeServerInfo({
      serverUrl: "https://backend.example.test",
      allowInsecureRemote: false,
      fetcher,
    });
    expect(calls).toEqual(["https://backend.example.test/api/server/info"]);
  });
});

describe("probeServerInfo — classify_rejected mirrors the classifier", () => {
  it("returns classify_rejected for a non-loopback http URL without the dev flag", async () => {
    const result = await probeServerInfo({
      serverUrl: "http://10.0.0.5",
      allowInsecureRemote: false,
      // fetcher should never run — if it does, the test will see
      // the wrong outcome kind anyway.
      fetcher: fakeFetch(async () => {
        throw new Error("fetcher should not be called when classifier rejects");
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("classify_rejected");
    if (result.kind !== "classify_rejected") throw new Error("unreachable");
    expect(result.reason).toBe("insecure_remote_http_disallowed");
    expect(typeof result.message).toBe("string");
  });

  it("returns classify_rejected for an obfuscated loopback even with the dev flag", async () => {
    // Cindy D4.a Commit 1 invariant: obfuscated loopback is rejected
    // outright regardless of `allowInsecureRemote`.
    const result = await probeServerInfo({
      serverUrl: "http://127.000.000.001",
      allowInsecureRemote: true,
      fetcher: fakeFetch(async () => {
        throw new Error("fetcher should not be called for obfuscated loopback");
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("classify_rejected");
    if (result.kind !== "classify_rejected") throw new Error("unreachable");
    expect(result.reason).toBe("obfuscated_loopback_disallowed");
  });
});

describe("probeServerInfo — TLS-failed mapping", () => {
  function errFetcher(err: unknown): FetcherFn {
    return fakeFetch(async () => {
      throw err;
    });
  }

  it("maps CERT_HAS_EXPIRED → tls_failed/host_tls_expired", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://expired.example.test",
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: "CERT_HAS_EXPIRED" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("tls_failed");
    if (result.kind !== "tls_failed") throw new Error("unreachable");
    expect(result.code).toBe("host_tls_expired");
  });

  it("maps ERR_TLS_CERT_ALTNAME_INVALID → tls_failed/host_tls_hostname_mismatch", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://wrong-name.example.test",
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("tls_failed");
    if (result.kind !== "tls_failed") throw new Error("unreachable");
    expect(result.code).toBe("host_tls_hostname_mismatch");
  });

  it("maps DEPTH_ZERO_SELF_SIGNED_CERT → tls_failed/host_tls_chain_invalid", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://selfsigned.example.test",
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("tls_failed");
    if (result.kind !== "tls_failed") throw new Error("unreachable");
    expect(result.code).toBe("host_tls_chain_invalid");
  });

  it("descends through cause-chain — outer wrapper + inner expired → host_tls_expired", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://wrapped.example.test",
      allowInsecureRemote: false,
      fetcher: errFetcher({
        code: "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
        cause: { code: "CERT_HAS_EXPIRED" },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("tls_failed");
    if (result.kind !== "tls_failed") throw new Error("unreachable");
    expect(result.code).toBe("host_tls_expired");
  });
});

describe("probeServerInfo — http_failed", () => {
  it("returns http_failed with status / statusText / body for a 404", async () => {
    const fetcher: FetcherFn = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "route not registered",
    });
    const result = await probeServerInfo({
      serverUrl: "https://backend.example.test",
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result).toEqual({
      ok: false,
      kind: "http_failed",
      status: 404,
      statusText: "Not Found",
      bodyText: "route not registered",
    });
  });
});

describe("probeServerInfo — network_failed", () => {
  it("maps a non-TLS thrown error to network_failed with the error message", async () => {
    const result = await probeServerInfo({
      serverUrl: "https://unreachable.example.test",
      allowInsecureRemote: false,
      fetcher: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    expect(result.message).toContain("ECONNREFUSED");
  });
});

describe("probeServerInfo — invalid_response", () => {
  it("returns invalid_response when body is not valid JSON", async () => {
    const fetcher: FetcherFn = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html>not silverhand</html>",
    });
    const result = await probeServerInfo({
      serverUrl: "https://something-else.example.test",
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid_response");
  });

  it("returns invalid_response when body is JSON but does not match ServerInfo schema", async () => {
    const fetcher = jsonFetcher({ unexpected: "shape" });
    const result = await probeServerInfo({
      serverUrl: "https://something-else.example.test",
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid_response");
    if (result.kind !== "invalid_response") throw new Error("unreachable");
    expect(result.message).toContain("signup_enabled");
  });
});

describe("probeServerInfo — AbortSignal + timeout race", () => {
  it("passes an AbortSignal to the fetcher (internal controller, not the caller's)", async () => {
    // Cindy D4.a Commit 2 fixup: probeServerInfo now owns an
    // internal AbortController so it can race a timeout against the
    // caller-supplied signal. The fetcher receives the INTERNAL
    // signal; the caller's signal is wired in as a listener. Pin
    // that the seam still passes *some* signal so the fetcher has
    // a way to be aborted.
    const ac = new AbortController();
    const seen: AbortSignal[] = [];
    const fetcher: FetcherFn = async (_input, init) => {
      if (init?.signal) seen.push(init.signal);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ signup_enabled: false }),
      };
    };
    await probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher,
      signal: ac.signal,
      timeoutMs: null, // disable internal timeout for this test
    });
    expect(seen.length).toBe(1);
    // It is NOT the caller's signal (we wrap), but it IS an AbortSignal.
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]).not.toBe(ac.signal);
  });

  it("aborts the inner fetch when the caller-supplied signal aborts", async () => {
    const ac = new AbortController();
    let innerSignal: AbortSignal | undefined;
    const fetcher: FetcherFn = (_input, init) => {
      innerSignal = init?.signal;
      // Hang forever unless aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };
    const pending = probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher,
      signal: ac.signal,
      timeoutMs: null,
    });
    // Give the fetcher a microtask to register the listener.
    await Promise.resolve();
    ac.abort();
    const result = await pending;
    expect(innerSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    // Caller-canceled message — must NOT lie about a timeout.
    expect(result.message.toLowerCase()).toContain("cancel");
    expect(result.message.toLowerCase()).not.toContain("timed out");
  });

  it("aborts when the internal timeout fires before the fetch completes", async () => {
    let innerSignal: AbortSignal | undefined;
    const fetcher: FetcherFn = (_input, init) => {
      innerSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };
    const result = await probeServerInfo({
      serverUrl: "https://blackhole.example.test",
      allowInsecureRemote: false,
      fetcher,
      timeoutMs: 5, // fire almost immediately
    });
    expect(innerSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    // Honest timeout copy — distinguishes black-hole from caller-cancel.
    expect(result.message.toLowerCase()).toMatch(/timed out/);
    expect(result.message).toContain("5 ms");
    expect(result.message).toContain("blackhole.example.test");
  });

  it("caller abort BEFORE timeout fires reports caller-cancel, not timeout", async () => {
    const ac = new AbortController();
    const fetcher: FetcherFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const pending = probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher,
      signal: ac.signal,
      timeoutMs: 60_000, // long — caller should win
    });
    await Promise.resolve();
    ac.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    expect(result.message.toLowerCase()).toContain("cancel");
    expect(result.message.toLowerCase()).not.toContain("timed out");
  });

  it("caller signal that is ALREADY aborted at entry reports caller-cancel", async () => {
    const ac = new AbortController();
    ac.abort();
    let fetchEntered = false;
    const fetcher: FetcherFn = (_input, init) => {
      fetchEntered = true;
      // fetch must see an aborted signal immediately; node fetch
      // would throw synchronously, so simulate that.
      if (init?.signal?.aborted) {
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
      });
    };
    const result = await probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher,
      signal: ac.signal,
      timeoutMs: 60_000,
    });
    // We still call fetch — but the inner signal is already aborted.
    expect(fetchEntered).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    expect(result.message.toLowerCase()).toContain("cancel");
  });

  it("non-abort error that happens to coincide with caller signal still falls through to underlying message", async () => {
    // Defensive: if the fetcher throws a plain ECONNREFUSED (NOT an
    // AbortError) and the caller never canceled and the timeout
    // never fired, the message must be the underlying error — we
    // must NOT silently relabel it as "canceled" or "timed out".
    const fetcher: FetcherFn = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1234"), {
        code: "ECONNREFUSED",
      });
    };
    const result = await probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher,
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("network_failed");
    if (result.kind !== "network_failed") throw new Error("unreachable");
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message.toLowerCase()).not.toContain("cancel");
    expect(result.message.toLowerCase()).not.toContain("timed out");
  });

  it("clears the internal timeout after a fast successful response (no lingering timer)", async () => {
    // We can't directly observe the timer, but we can observe
    // setTimeout / clearTimeout via spies. The probe MUST call
    // clearTimeout in `finally` so a fast response does not leave
    // the timer pending (which would later abort a no-longer-active
    // request and, in real Node, hold the event loop open).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await probeServerInfo({
        serverUrl: "https://x.example.test",
        allowInsecureRemote: false,
        fetcher: jsonFetcher({ signup_enabled: true }),
        timeoutMs: 60_000,
      });
      // The probe must have armed exactly one timeout AND cleared it.
      const armedHandles = setTimeoutSpy.mock.results
        .filter((r) => r.type === "return")
        .map((r) => r.value);
      expect(armedHandles.length).toBeGreaterThanOrEqual(1);
      // Every armed handle must have been cleared.
      const clearedHandles = clearTimeoutSpy.mock.calls.map((c) => c[0]);
      for (const h of armedHandles) {
        expect(clearedHandles).toContain(h);
      }
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("removes the caller-signal abort listener after fetch completes (no lingering listener)", async () => {
    // Pin: when the request finishes cleanly, the caller's signal
    // must not retain a reference to our internal listener. If we
    // forgot to detach in `finally`, a long-lived caller AbortSignal
    // would accumulate listeners over many probes.
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    await probeServerInfo({
      serverUrl: "https://x.example.test",
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: true }),
      signal: ac.signal,
      timeoutMs: 60_000,
    });
    const added = addSpy.mock.calls.filter((c) => c[0] === "abort").length;
    const removed = removeSpy.mock.calls.filter((c) => c[0] === "abort").length;
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});
