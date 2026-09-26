import { describe, expect, it, vi } from "vitest";
import {
  configureRendererBackendNetwork,
  fetchBackendWithNetworkPolicy,
} from "../renderer-backend-network.js";

describe("configureRendererBackendNetwork", () => {
  it("routes REST fetch and Chromium from the same backend network policy", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const response = await fetchBackendWithNetworkPolicy(
      fetchImpl,
      "https://silverhand.example.test/readyz",
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://silverhand.example.test/readyz", undefined);
    expect(response.status).toBe(204);
  });

  it("forces the renderer session onto the same direct path as main-process fetch", async () => {
    const calls: string[] = [];
    const setProxy = vi.fn(async () => {
      calls.push("set");
    });
    const resolveProxy = vi.fn(async () => {
      calls.push("resolve");
      return "DIRECT";
    });

    await expect(
      configureRendererBackendNetwork({
        session: { setProxy, resolveProxy },
        backendUrl: "https://silverhand.example.test/api/server/info",
      }),
    ).resolves.toEqual({
      backendOrigin: "https://silverhand.example.test",
      resolvedProxy: "DIRECT",
    });
    expect(setProxy).toHaveBeenCalledWith({
      mode: "direct",
    });
    expect(resolveProxy).toHaveBeenCalledWith("https://silverhand.example.test");
    expect(calls).toEqual(["set", "resolve"]);
  });

  it("fails loudly if Chromium still resolves the backend through a proxy", async () => {
    await expect(
      configureRendererBackendNetwork({
        session: {
          setProxy: vi.fn(async () => undefined),
          resolveProxy: vi.fn(async () => "SOCKS5 127.0.0.1:7897"),
        },
        backendUrl: "https://silverhand.example.test",
      }),
    ).rejects.toThrow("did not resolve DIRECT");
  });
});
