import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import desktopPackage from "../../../package.json";

const mainRoot = fileURLToPath(new URL("..", import.meta.url));
const preloadRoot = fileURLToPath(new URL("../../preload", import.meta.url));
const rendererRoot = fileURLToPath(new URL("../../renderer", import.meta.url));
const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));

const allowedBackendImports = ["HostWsAttachment"];

const allowedServerImports: string[] = [];

const cataloguedIpcHandlers = [
  "attachment:openExternal",
  "attachment:save",
  "auth:getState",
  "auth:login",
  "auth:logout",
  "auth:signup",
  "backend:info",
  "backend:request",
  "backend:upload",
  "badge:setCount",
  "dialog:pickDirectory",
  "eventWs:diagnostic",
  "export:copyPng",
  "export:savePng",
  "hosts:revoke",
  "hosts:rotate",
  "hosts:proxyConfig:get",
  "hosts:proxyConfig:set",
  "notification:show",
  "notification:dismiss",
  "partialApply:get",
  "partialApply:retry",
  "profile:clear",
  "profile:get",
  "profile:saveWithTest",
  "settings:saveServerUrl",
  "shell:openExternal",
].sort();

interface SourceFile {
  path: string;
  content: string;
}

function sourceFiles(root: string, extensions: ReadonlySet<string>): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(fullPath);
        continue;
      }
      if (!entry.isFile() || /\.test\.tsx?$/.test(entry.name)) continue;
      const ext = entry.name.endsWith(".tsx") ? ".tsx" : entry.name.endsWith(".ts") ? ".ts" : "";
      if (!extensions.has(ext)) continue;
      out.push({ path: fullPath, content: readFileSync(fullPath, "utf8") });
    }
  };
  visit(root);
  return out;
}

function stripComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importedPackageSymbols(source: SourceFile, packageName: string): string[] {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbols: string[] = [];
  const statements = source.content.matchAll(
    new RegExp(
      `import\\s+(?:type\\s+)?\\{([^;]*?)\\}\\s+from\\s+['"]${escapedPackageName}['"]`,
      "g",
    ),
  );
  for (const match of statements) {
    for (const part of stripComments(match[1] ?? "").split(",")) {
      const symbol = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (symbol) symbols.push(symbol);
    }
  }
  const allBackendImports = [
    ...source.content.matchAll(
      new RegExp(`import\\s+[^;]*from\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`, "g"),
    ),
  ];
  const unsupportedBackendImports = [
    ...source.content.matchAll(
      new RegExp(
        `import\\s+(?:type\\s+)?(?:\\*\\s+as\\s+\\w+|[A-Za-z_$][\\w$]*(?:\\s*,\\s*(?:\\*\\s+as\\s+\\w+|\\{[^;]*\\}))?)\\s+from\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`,
        "g",
      ),
    ),
    ...source.content.matchAll(
      new RegExp(`import\\s+['"]${escapedPackageName}(?:\\/[^'"]*)?['"]`, "g"),
    ),
  ];
  if (unsupportedBackendImports.length > 0) {
    symbols.push(`UNPARSED:${source.path}`);
  }
  if (allBackendImports.length > 0 && symbols.length === 0) {
    symbols.push(`UNPARSED:${source.path}`);
  }
  return symbols;
}

describe("desktop protocol purity catalogue", () => {
  it("fails loud on unsupported backend import forms mixed with named imports", () => {
    const imports = importedPackageSymbols(
      {
        path: "example.ts",
        content: `
        import { startBackend } from '@silverhand/backend';
        import * as backend from '@silverhand/backend';
      `,
      },
      "@silverhand/backend",
    );

    expect(imports).toContain("startBackend");
    expect(imports).toContain("UNPARSED:example.ts");
  });

  it("keeps direct @silverhand/backend imports fenced to the embedded boot path allowlist", () => {
    const imports = sourceFiles(mainRoot, new Set([".ts"]))
      .flatMap((source) => importedPackageSymbols(source, "@silverhand/backend"))
      .sort();

    expect(imports).toEqual(allowedBackendImports);
  });

  it("keeps direct @silverhand/server imports fenced to the embedded boot path allowlist", () => {
    const imports = sourceFiles(mainRoot, new Set([".ts"]))
      .flatMap((source) => importedPackageSymbols(source, "@silverhand/server"))
      .sort();

    expect(imports).toEqual(allowedServerImports);
  });

  it("bundles shared utilities without a TS server build dependency", () => {
    const config = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");

    expect(config).toMatch(/const workspaceDeps = \[[\s\S]*'@silverhand\/shared'[\s\S]*\];/);
    expect(config).not.toContain("'@silverhand/server'");
  });

  it("both profiles use the same shared Node logger without a server stub", () => {
    const config = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
    expect(config).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(config).not.toMatch(/remote-only-server-stub\.ts/);
    expect(readFileSync(join(mainRoot, "index.ts"), "utf8")).toContain(
      "@silverhand/shared/node-file-logger",
    );
  });

  it("#task:2343 P0-10: remote-only build aliases the embedded-launcher seam to a stub with no embedded value imports", () => {
    // The construction seam: `index.ts` reaches ALL embedded runtime (migrator, Rust
    // launcher, sidecar verifier) ONLY through `./embedded-launcher.js`, which the
    // remote-only build aliases to `embedded-launcher.remote-only.ts`. That stub must NOT
    // statically import `@silverhand/backend` (→ `better-sqlite3`) or bring the launcher/
    // sidecar VALUE modules into the graph — its only cross-module references are
    // type-only. This is what makes the remote-only bundle scan (no
    // launcher/sidecar/migrator/better-sqlite3) hold at construction, not by a runtime flag.
    const config = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
    const seamStub = readFileSync(join(mainRoot, "embedded-launcher.remote-only.ts"), "utf8");
    expect(config).toMatch(/embedded-launcher\.js/);
    expect(config).toMatch(/embedded-launcher\.remote-only\.ts/);
    // The stub carries NO value import of the embedded packages/modules — only `import
    // type` is allowed (erased at build). Assert there is no non-type import of the
    // forbidden specifiers.
    expect(seamStub).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@silverhand\/backend'/m);
    expect(seamStub).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'@silverhand\/server'/m);
    // Real index.ts imports the embedded runtime through the seam, not the value modules
    // directly (the only remaining `embedded-rust-backend`/`rust-backend-sidecar` mentions
    // in index.ts must be `import type`).
    const indexSrc = readFileSync(join(mainRoot, "index.ts"), "utf8");
    expect(indexSrc).toMatch(/from '\.\/embedded-launcher\.js'/);
    expect(indexSrc).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'\.\/rust-backend-sidecar\.js'/m);
  });

  it("remote-only package config excludes embedded backend/native runtime packages", () => {
    const config = readFileSync(join(desktopRoot, "electron-builder.remote-only.yml"), "utf8");
    const packageScript = readFileSync(join(desktopRoot, "../../scripts/package.sh"), "utf8");
    const afterPackScript = readFileSync(join(desktopRoot, "scripts/afterPack.cjs"), "utf8");
    const remoteOnlyPackage = readFileSync(join(desktopRoot, "package.remote-only.json"), "utf8");

    expect(config).toMatch(/appId:\s*com\.silverhand\.desktop/);
    expect(config).toMatch(/productName:\s*Silverhand-remote-server/);
    expect(config).toMatch(/artifactName:\s*\$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
    expect(config).toMatch(/output:\s*release-remote-server/);
    for (const dep of [
      "@hono",
      "hono",
      "better-sqlite3",
      "@node-rs/argon2",
      "@node-rs/argon2-darwin-arm64",
    ]) {
      expect(config).toContain(`!node_modules/${dep}`);
    }
    expect(config).not.toMatch(/^asarUnpack:/m);
    expect(packageScript).toMatch(/--remote-only/);
    expect(packageScript).toMatch(/--server-url/);
    expect(packageScript).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(config).toMatch(/package\.remote-only\.json/);
    expect(remoteOnlyPackage).toContain('"zod"');
    expect(remoteOnlyPackage).not.toMatch(
      /@hono|hono|better-sqlite3|@node-rs\/argon2|@silverhand\/server|@silverhand\/backend/,
    );
    expect(afterPackScript).toMatch(/rewriteRemoteOnlyAsar/);
    expect(afterPackScript).toMatch(/SILVERHAND_DESKTOP_REMOTE_ONLY/);
    expect(afterPackScript).toMatch(/package\.remote-only\.generated\.json/);
    expect(afterPackScript).toMatch(/ElectronAsarIntegrity/);

    const versionSmoke = packageScript.indexOf('verify_packaged_app_version "$PACKAGED_APP_PATH"');
    const signatureSmoke = packageScript.indexOf(
      'verify_packaged_code_signature "$PACKAGED_APP_PATH"',
    );
    const artifactHandoff = packageScript.indexOf(
      'echo "[package] artifacts in apps/desktop/$ARTIFACT_OUTPUT_DIR/"',
    );
    expect(versionSmoke).toBeGreaterThan(-1);
    expect(signatureSmoke).toBeGreaterThan(versionSmoke);
    expect(artifactHandoff).toBeGreaterThan(signatureSmoke);
    expect(packageScript).toMatch(/codesign --verify --deep --strict --verbose=2/);
  });

  it("keeps bundled workspace packages out of packaged app runtime dependencies", () => {
    const workspaceRuntimeDeps = Object.keys(desktopPackage.dependencies)
      .filter((name) => name.startsWith("@silverhand/"))
      .sort();

    expect(workspaceRuntimeDeps).toEqual([]);
  });

  it("keeps packaged runtime dependencies limited to main/backend requires", () => {
    // electron-builder copies production dependencies into app.asar. Renderer
    // libraries are Vite-bundled into out/renderer, and build plugins run before
    // packaging; listing either as runtime dependencies ships duplicate dead
    // node_modules and inflates the DMG.
    expect(Object.keys(desktopPackage.dependencies).sort()).toEqual(["zod"]);
    expect(desktopPackage.devDependencies).toHaveProperty("mermaid");
    expect(desktopPackage.devDependencies).toHaveProperty("@tailwindcss/vite");
    expect(desktopPackage.devDependencies).toHaveProperty("lucide-react");
  });

  it("keeps main IPC handlers in sync with the protocol-purity catalogue", () => {
    // registrations go through the guarded registrar rather than
    // the Electron object. The scan must NOT key on the receiver's local
    // variable name: a future module writing `registrar.handle('new:channel')`
    // would silently escape the catalogue. Match any `.handle(<string>)` in
    // production main instead — today nothing else in main calls `.handle`
    // with a string first argument, so an unexpected match is a signal to
    // classify explicitly, not to widen the pattern.
    const channels = sourceFiles(mainRoot, new Set([".ts"]))
      .flatMap((source) =>
        [...source.content.matchAll(/\.handle\(\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1]),
      )
      .sort();

    expect(channels).toEqual(cataloguedIpcHandlers);
  });

  it("keeps renderer code from importing backend internals directly", () => {
    const offenders = sourceFiles(rendererRoot, new Set([".ts", ".tsx"]))
      .filter((source) => /from\s+['"]@silverhand\/backend(?:\/[^'"]*)?['"]/.test(source.content))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  it("contains no renderer-facing BackendInfo auth_token consumers", () => {
    const offenders = [
      ...sourceFiles(preloadRoot, new Set([".ts"])),
      ...sourceFiles(rendererRoot, new Set([".ts", ".tsx"])),
    ]
      .filter((source) => /\bauth_token\b|\.auth_token\b/.test(source.content))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  it("mints the attachment discriminant only in the unit-tested producer (#task:1630)", () => {
    const producerFile = join(mainRoot, "local-host-ws-attachment.ts");
    const inlineMints = sourceFiles(mainRoot, new Set([".ts"]))
      .filter((source) => source.path !== producerFile)
      .filter((source) => /observable:/.test(stripComments(source.content)))
      .map((source) => source.path);

    expect(inlineMints).toEqual([]);
    expect(readFileSync(join(mainRoot, "index.ts"), "utf8")).toMatch(
      /describeLocalHostWsAttachment\(\{\s*\n?\s*hasLocalRegistryObserver:/,
    );
  });

  it("no longer has any getEmbeddedHostWsController() call site — the in-process registry observer is gone (#task:2343)", () => {
    const callSites = sourceFiles(mainRoot, new Set([".ts"])).flatMap((source) =>
      [
        ...stripComments(source.content).matchAll(
          /(?<!function\s)getEmbeddedHostWsController\(\)/g,
        ),
      ].map(() => source.path),
    );

    expect(callSites.length).toBe(0);
  });

  it("#task:2343 P1-18: the dead in-process/outbound-socket concepts are DELETED, not left as forever-dead shells", () => {
    // With the out-of-process Rust embedded backend these lost their last legitimate
    // caller and were removed (not left as residual): the deployment-arm discriminant
    // helper `requireBackendKind`, the in-process CLI launcher `resolveSilverhandCliLauncher`,
    // and the local-outbound-frame-socket concept (`DaemonPaths.localOutboundSocketPath`
    // field + `localOutboundSocketPathForStartupPlan`). The daemon still receives an
    // explicit `localOutboundSocketPath: null` spawn option — that is the PROOF of
    // no-fallback, not a live use — so we pin the DEAD identifiers to zero, allowing the
    // single `localOutboundSocketPath: null` no-fallback assertion.
    const deadIdentifiers = [
      /\brequireBackendKind\b/g,
      /\bresolveSilverhandCliLauncher\b/g,
      /\blocalOutboundSocketPathForStartupPlan\b/g,
    ];
    for (const pattern of deadIdentifiers) {
      const hits = sourceFiles(mainRoot, new Set([".ts"])).flatMap((source) =>
        [...stripComments(source.content).matchAll(pattern)].map(() => source.path),
      );
      expect({ pattern: pattern.source, hits }).toEqual({
        pattern: pattern.source,
        hits: [],
      });
    }

    // The ONLY surviving `localOutboundSocketPath` mention in main source is the
    // no-fallback spawn option pinned to `null` (the daemon-arm proof for #task:2343 P1-19);
    // there is no `DaemonPaths` field / assignment reintroducing the concept.
    const outboundMentions = sourceFiles(mainRoot, new Set([".ts"])).flatMap((source) =>
      [...stripComments(source.content).matchAll(/localOutboundSocketPath[^\n]*/g)].map((m) => ({
        path: source.path,
        text: m[0].trim(),
      })),
    );
    for (const mention of outboundMentions) {
      expect(mention.text).toMatch(/localOutboundSocketPath:\s*null/);
    }
  });
});
