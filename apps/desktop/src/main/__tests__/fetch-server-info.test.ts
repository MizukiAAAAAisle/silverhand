import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchServerInfoWithRetry } from "../fetch-server-info.js";

const url = "https://example.test/api/server/info";
function response(status: number, body: unknown, statusText = "Bad Gateway"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText,
  });
}

describe("fetchServerInfoWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns server info without retrying the first successful attempt", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { signup_enabled: false }));
    await expect(fetchServerInfoWithRetry({ url, fetcher })).resolves.toEqual({
      signup_enabled: false,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries fetch failures after the actual boot delays, without fetching early", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(response(200, { signup_enabled: true }));
    const result = fetchServerInfoWithRetry({ url, fetcher });
    await vi.advanceTimersByTimeAsync(249);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(749);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ signup_enabled: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "boot retry budget", retryDelaysMs: undefined, attempts: 3 },
    { name: "periodic single probe", retryDelaysMs: [], attempts: 1 },
  ])("surfaces the final HTTP error for $name", async ({ retryDelaysMs, attempts }) => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => response(503, "upstream unavailable", "Unavailable"));
    const result = fetchServerInfoWithRetry({ url, fetcher, retryDelaysMs });
    const rejected = expect(result).rejects.toThrow("503 Unavailable: upstream unavailable");
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(attempts);
  });

  it.each([{ unexpected: "shape" }, "<html>not JSON</html>"])(
    "does not retry a successful HTTP response that is not server info: %j",
    async (body) => {
      const fetcher = vi.fn().mockResolvedValue(response(200, body));
      await expect(fetchServerInfoWithRetry({ url, fetcher })).rejects.toThrow(
        "invalid server info response",
      );
      await vi.runAllTimersAsync();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["before request", "during retry"] as const)(
    "cancels %s without another fetch",
    async (when) => {
      const controller = new AbortController();
      const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      if (when === "before request") controller.abort();
      const result = fetchServerInfoWithRetry({ url, fetcher, signal: controller.signal });
      const rejected = expect(result).rejects.toThrow(/aborted/);
      if (when === "during retry") {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, { signal: controller.signal });
        controller.abort();
      }
      // Cancellation must settle before the retry clock advances.
      await rejected;
      await vi.runAllTimersAsync();
      expect(fetcher).toHaveBeenCalledTimes(when === "before request" ? 0 : 1);
    },
  );
});
