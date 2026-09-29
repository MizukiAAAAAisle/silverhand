import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function config(value: string | undefined) {
  vi.stubEnv("SILVERHAND_DEFAULT_SERVER_URL", value);
  vi.resetModules();
  return (await import("../capacitor.config")).default;
}

it.each([undefined, "", "   "])("has no default when env is %j", async (value) => {
  expect((await config(value)).plugins?.SilverhandClient).toEqual({});
});

it("passes the build default only to the native client plugin", async () => {
  const result = await config(" https://Example.com:8443/ ");
  expect(result.appId).toBe("com.silverhand.ios");
  expect(result.plugins?.SilverhandClient).toEqual({
    defaultServerURL: "https://Example.com:8443/",
  });
  expect(result.server).toBeUndefined();
});

it.each([
  "bad",
  "http://server.example",
  "https://user:pw@server.example",
  "https://@server.example",
  "https://server.example/api",
  "https://server.example/a/..",
  "https://server.example?query",
  "https://server.example#",
  "https://server.example\\path",
  "https://server.example:0",
])("rejects an invalid build default: %s", async (value) => {
  await expect(config(value)).rejects.toThrow("SILVERHAND_DEFAULT_SERVER_URL");
});
