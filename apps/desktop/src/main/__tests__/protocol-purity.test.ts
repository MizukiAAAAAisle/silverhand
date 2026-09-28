import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { createRequire } from "node:module";
import desktopPackage from "../../../package.json";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const packagingRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { load: parseYaml } = packagingRequire("js-yaml") as {
  load: (text: string) => Record<string, unknown>;
};

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mainRoot = join(desktopRoot, "src/main");
const preloadRoot = join(desktopRoot, "src/preload");
const rendererRoot = join(desktopRoot, "src/renderer");

function sourceFiles(root: string): ts.SourceFile[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    if (!entry.isFile() || !/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) return [];
    return [ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)];
  });
}

function find<T>(files: ts.SourceFile[], visit: (node: ts.Node) => T | undefined): T[] {
  const found: T[] = [];
  const walk = (node: ts.Node) => {
    const value = visit(node);
    if (value !== undefined) found.push(value);
    ts.forEachChild(node, walk);
  };
  files.forEach(walk);
  return found;
}

function importedModule(node: ts.Node): string | undefined {
  let specifier: ts.Node | undefined;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    specifier = node.moduleSpecifier;
  } else if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    specifier = node.moduleReference.expression;
  } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    specifier = node.argument.literal;
  } else if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    specifier = node.arguments[0];
  }
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

function literalChannels(files: ts.SourceFile[], method: string): string[] {
  return find(files, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== method
    )
      return;
    const channel = node.arguments[0];
    return channel && ts.isStringLiteralLike(channel) ? channel.text : undefined;
  }).sort();
}

describe("Desktop architecture boundaries (no renderer execution)", () => {
  it.each([
    mainRoot,
    preloadRoot,
    rendererRoot,
    join(desktopRoot, "../../packages/app-ui/src"),
    join(desktopRoot, "../../packages/client/src"),
  ])("does not import retired backend/server packages from %s", (root) => {
    const offenders = find(sourceFiles(root), (node) => {
      const module = importedModule(node);
      return module && /^@silverhand\/(?:backend|server)(?:\/|$)/.test(module)
        ? { path: relative(desktopRoot, node.getSourceFile().fileName), module }
        : undefined;
    });
    expect(offenders).toEqual([]);
  });

  it.each(["0", "1"])("evaluates the real build profile remoteOnly=%s", (remoteOnly) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadConfigFromFile } from "electron-vite";
      const { config } = await loadConfigFromFile(
        { command: "build", mode: "production" }, "electron.vite.config.ts", process.cwd());
      console.log(JSON.stringify({ main: config.main, preload: config.preload }));
    `,
      ],
      {
        cwd: desktopRoot,
        encoding: "utf8",
        env: { ...process.env, SILVERHAND_DESKTOP_REMOTE_ONLY: remoteOnly },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout);
    for (const part of [config.main, config.preload]) {
      expect(part.define.__SILVERHAND_DESKTOP_REMOTE_ONLY__).toBe(String(remoteOnly === "1"));
      expect(part.build.externalizeDeps.exclude).toContain("@silverhand/shared");
    }
  });

  it("remote-only package config excludes embedded backend/native runtime packages", () => {
    const config = parseYaml(
      readFileSync(join(desktopRoot, "electron-builder.remote-only.yml"), "utf8"),
    );
    expect(config).toMatchObject({
      appId: "com.silverhand.desktop",
      productName: "Silverhand-remote-server",
      artifactName: "${productName}-${version}-${arch}.${ext}",
      directories: { output: "release-remote-server" },
    });
    for (const dep of [
      "@silverhand",
      "@hono",
      "hono",
      "better-sqlite3",
      "@node-rs/argon2",
      "@node-rs/argon2-darwin-arm64",
    ]) {
      expect(config.files).toContain(`!node_modules/${dep}`);
      expect(config.files).toContain(`!node_modules/${dep}/**`);
    }
    expect(config).not.toHaveProperty("asarUnpack");
    expect(config.files).toContainEqual({
      from: "package.remote-only.generated.json",
      to: "package.json",
    });
  });

  it("ships only the unbundled zod runtime dependency in either package profile", () => {
    const remotePackage = JSON.parse(
      readFileSync(join(desktopRoot, "package.remote-only.json"), "utf8"),
    );
    for (const pkg of [desktopPackage, remotePackage]) {
      expect(Object.keys(pkg.dependencies).sort()).toEqual(["zod"]);
    }
    // The canonical Desktop manifest supplies the generated remote version.
    expect(remotePackage).not.toHaveProperty("version");
  });

  it("registers each literal preload request exactly once in main", () => {
    const registrations = literalChannels(sourceFiles(mainRoot), "handle");
    const requests = literalChannels(sourceFiles(preloadRoot), "invoke");
    expect(registrations.length).toBeGreaterThan(0);
    expect(new Set(registrations).size).toBe(registrations.length);
    expect(registrations).toEqual([...new Set(requests)].sort());
  });

  it("does not expose or consume auth_token in preload/renderer code", () => {
    const offenders = find([...sourceFiles(preloadRoot), ...sourceFiles(rendererRoot)], (node) =>
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "auth_token"
        ? relative(desktopRoot, node.getSourceFile().fileName)
        : undefined,
    );
    expect(offenders).toEqual([]);
  });
});
