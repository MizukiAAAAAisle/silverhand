import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("main-process backend HTTP seam (#task:1761)", () => {
  it("index.ts routes all backend HTTP through backendFetch (single raw call site: the seam itself)", () => {
    const source = readFileSync(join(__dirname, "index.ts"), "utf8");
    const rawCallSites = source.match(/fetchBackendWithNetworkPolicy\(fetch,/g);
    expect(rawCallSites).toHaveLength(1);
    // And that one site lives inside the seam function.
    const seamBody = source.slice(
      source.indexOf("function backendFetch("),
      source.indexOf("function backendFetch(") + 1200,
    );
    expect(seamBody).toContain("fetchBackendWithNetworkPolicy(fetch,");
    expect(seamBody).toContain("CLIENT_INFO_HEADER");
    // Round-2: the ADMISSION header is the dedicated constant-valued one and
    // must be set unconditionally inside the seam.
    expect(seamBody).toContain("DESKTOP_API_EPOCH_HEADER");
  });
});
