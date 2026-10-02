import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Architecture scan, not a behavior test: the shared layers stay domain-neutral,
// so nothing under them may import a feature. Domain UI that needs feature data
// belongs in that feature (see readme.md).

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SHARED_LAYERS = ["components", "hooks", "lib", "navigation", "icons"];
const FEATURE_IMPORT = /(?:from\s+|import\(\s*)["'](?:@\/features\/|(?:\.\.\/)+features\/)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function offenders(): string[] {
  return SHARED_LAYERS.flatMap((layer) => walk(join(ROOT, layer)))
    .filter((file) => FEATURE_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).split(sep).join("/"))
    .sort();
}

describe("shared layers never import features", () => {
  it("no shared-layer module imports @/features", () => {
    expect(offenders()).toEqual([]);
  });
});
