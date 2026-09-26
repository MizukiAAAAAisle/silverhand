import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageScript = fileURLToPath(new URL("../../../../../scripts/package.sh", import.meta.url));

// Artifact identity/signature and module graph are checked by the executable
// package.sh release gate, for both profiles (see docs/testing.md).
describe("release package CLI admission, before any build", () => {
  it.each(["../release", "/tmp", ".", ""])("rejects unsafe output name %j", (name) => {
    const result = spawnSync("bash", [packageScript, "--output-dir", name], { encoding: "utf8" });
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toContain("simple directory name");
  });

  it.each([
    [],
    ["--server-url", "http://localhost:18080"],
    ["--server-url", "https://example.com/path"],
    ["--server-url", "https://example.com/?query=1"],
    ["--server-url", "http://example.com"],
  ])("refuses invalid remote-only destination %j", (...args) => {
    const result = spawnSync("bash", [packageScript, "--remote-only", ...args], {
      encoding: "utf8",
      env: { ...process.env, SILVERHAND_ALLOW_INSECURE_REMOTE: "0" },
    });
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toMatch(/requires --server-url|invalid --server-url/);
  });
});
