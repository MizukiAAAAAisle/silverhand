import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path) && !/\.test\./.test(path)
        ? [path]
        : [];
  });
}

describe("shared client package boundaries", () => {
  it.each(["client", "app-ui"])("%s has no host, Electron, Node or application imports", (pkg) => {
    const offenders: string[] = [];
    const root = join(repo, "packages", pkg, "src");
    for (const file of files(root)) {
      const ast = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function walk(node: ts.Node): void {
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier;
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            node.expression.getText(ast) === "require")
        )
          specifier = node.arguments[0];
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text;
          if (
            name.startsWith("node:") ||
            builtins.has(name) ||
            /^(electron|@silverhand\/(desktop|host|silverhand-daemon))($|\/)/.test(name) ||
            (name.startsWith(".") && !resolve(dirname(file), name).startsWith(root + "/"))
          ) {
            offenders.push(`${file}: ${name}`);
          }
        }
        if (ts.isPropertyAccessExpression(node) && node.getText(ast) === "window.silverhand")
          offenders.push(`${file}: window.silverhand`);
        ts.forEachChild(node, walk);
      }
      walk(ast);
    }
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(repo, "packages", pkg, "package.json"), "utf8"));
    expect(
      Object.keys(manifest.dependencies).filter((name) =>
        /^(electron|@silverhand\/(desktop|host|silverhand-daemon))$/.test(name),
      ),
    ).toEqual([]);
  });
});
