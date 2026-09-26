import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import ts from "typescript";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, fn);
    },
  },
}));

import { createGuardedIpcRegistrar } from "./guarded-ipc.js";
import { resolveRendererEntry, type RendererEntry } from "../renderer-entry.js";

/**
 * #task:1762 — IPC sender validation behavior.
 *
 * Only messages from the app's own renderer top frame, loaded from the
 * resolved renderer entry, may reach a handler. Everything else is refused
 * BEFORE the listener runs — `handle` throws, `on` silently drops.
 */

const ENTRY_FILE = "/Applications/Silverhand.app/Contents/Resources/app/out/renderer/index.html";
const DEV_ENTRY = { kind: "dev-server" as const, url: "http://localhost:5173" };
const FILE_ENTRY = { kind: "packaged-file" as const, filePath: ENTRY_FILE };
const entryUrl = pathToFileURL(ENTRY_FILE).toString();

function fakeWebContents(id: number): WebContents & { mainFrame: { url: string } } {
  const mainFrame = { url: entryUrl };
  return { id, mainFrame } as unknown as WebContents & { mainFrame: { url: string } };
}

function event(sender: WebContents, frame: { url: string } | null): IpcMainInvokeEvent {
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("guarded IPC registrar — sender validation", () => {
  it("serves a message from the renderer top frame at the packaged entry (and runs the listener)", () => {
    const wc = fakeWebContents(1);
    const listener = vi.fn(() => "ok");
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => wc,
      entry: FILE_ENTRY,
    });
    ipc.handle("probe", listener);
    const message = event(wc, wc.mainFrame);
    const result = handlers.get("probe")!(message, "payload", 42);
    expect(result).toBe("ok");
    expect(listener).toHaveBeenCalledExactlyOnceWith(message, "payload", 42);
  });

  it("serves a packaged entry URL carrying a HashRouter fragment and query", () => {
    const wc = fakeWebContents(1);
    wc.mainFrame.url = `${entryUrl}?x=1#/c/abcdef`;
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => wc,
      entry: FILE_ENTRY,
    });
    ipc.handle("probe", () => "ok");
    expect(handlers.get("probe")!(event(wc, wc.mainFrame))).toBe("ok");
  });

  it("serves a dev-server top frame on any path of the same origin", () => {
    const wc = fakeWebContents(1);
    wc.mainFrame.url = "http://localhost:5173/index.html#/c/x";
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => wc,
      entry: DEV_ENTRY,
    });
    ipc.handle("probe", () => "ok");
    expect(handlers.get("probe")!(event(wc, wc.mainFrame))).toBe("ok");
  });

  it("refuses BEFORE the listener runs: foreign webContents, subframe, null frame, foreign urls", () => {
    const wc = fakeWebContents(1);
    const foreign = fakeWebContents(2);
    const listener = vi.fn();
    const warn = vi.fn();
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => wc,
      entry: FILE_ENTRY,
      log: { warn },
    });
    ipc.handle("probe", listener);
    const call = handlers.get("probe")!;

    // another WebContents in the process
    expect(() => call(event(foreign, foreign.mainFrame))).toThrow();
    // a subframe of the right WebContents
    expect(() => call(event(wc, { url: entryUrl }))).toThrow();
    // unknown / destroyed frame
    expect(() => call(event(wc, null))).toThrow();
    // arbitrary local file with the preload attached
    expect(() =>
      call(event(wc, Object.assign(wc.mainFrame, { url: "file:///tmp/evil.html" }))),
    ).toThrow();
    // side effects never happened
    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    // logs carry ids/verdicts only — never the URL (its hash names workspaces)
    for (const [payload] of warn.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain("index.html");
      expect(JSON.stringify(payload)).not.toContain("evil.html");
      // diagnostics carry a coarse protocol class, never a path
      expect(["file", "http", "other", "malformed", "missing"]).toContain(
        (payload as { source_kind?: string }).source_kind,
      );
    }
  });

  it("refuses when no renderer exists yet", () => {
    const wc = fakeWebContents(1);
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => null,
      entry: FILE_ENTRY,
    });
    ipc.handle("probe", () => "ok");
    expect(() => handlers.get("probe")!(event(wc, wc.mainFrame))).toThrow();
  });

  it("`on` fails closed: the callback never runs and nothing throws at the sender", () => {
    const wc = fakeWebContents(1);
    const foreign = fakeWebContents(2);
    const listener = vi.fn();
    const ipc = createGuardedIpcRegistrar({
      resolveRendererWebContents: () => wc,
      entry: FILE_ENTRY,
    });
    ipc.on("fire", listener);
    const call = listeners.get("fire")!;
    expect(() => call(event(foreign, foreign.mainFrame))).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    // the legitimate sender still gets through
    call(event(wc, wc.mainFrame));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("renderer entry URL contract", () => {
  function expectRefused(url: string, entry: RendererEntry): void {
    const wc = fakeWebContents(1);
    wc.mainFrame.url = url;
    const listener = vi.fn();
    createGuardedIpcRegistrar({ resolveRendererWebContents: () => wc, entry }).handle(
      "url-probe",
      listener,
    );
    expect(() => handlers.get("url-probe")!(event(wc, wc.mainFrame))).toThrow();
    expect(listener).not.toHaveBeenCalled();
  }
  it("rejects malformed, empty, and cross-origin URLs on both entry kinds", () => {
    for (const bad of ["", "not a url", "://", "http://evil.test/index.html"]) {
      expectRefused(bad, FILE_ENTRY);
      expectRefused(bad, DEV_ENTRY);
    }
    // a file URL must never satisfy the dev contract, nor vice versa
    expectRefused(entryUrl, DEV_ENTRY);
    expectRefused("http://localhost:5173/", FILE_ENTRY);
    expectRefused(
      pathToFileURL(ENTRY_FILE.replace("index.html", "other.html")).toString(),
      FILE_ENTRY,
    );
  });

  it("rejects opaque-origin dev URLs on both sides of the contract", () => {
    // resolver fails loud
    for (const bad of ["data:text/html,<p>x", "silverhand://app", "not a url"]) {
      expect(() =>
        resolveRendererEntry({ devServerUrl: bad, mainDirname: "/x/out/main" }),
      ).toThrow();
    }
    expectRefused("data:text/html,<p>evil", { kind: "dev-server", url: "data:text/html,<p>x" });
  });

  it("derives dev vs packaged from the same resolver the window loader uses", () => {
    expect(
      resolveRendererEntry({ devServerUrl: "http://localhost:5173", mainDirname: "/x/out/main" }),
    ).toEqual({ kind: "dev-server", url: "http://localhost:5173" });
    // blank/whitespace env is treated as absent (packaged)
    expect(resolveRendererEntry({ devServerUrl: "  ", mainDirname: "/x/out/main" }).kind).toBe(
      "packaged-file",
    );
    expect(resolveRendererEntry({ devServerUrl: undefined, mainDirname: "/x/out/main" })).toEqual({
      kind: "packaged-file",
      filePath: "/x/out/renderer/index.html",
    });
  });
});

describe("IPC ingress source fence", () => {
  /**
   * The registrar is the security boundary's only door, so the fence reads
   * the real import graph instead of matching text shapes: a regex misses
   * `import electron from 'electron'` (default import + member access) and
   * dynamic `import('electron')`. Two layers:
   *   1. AST — no production main module may import the ingress object from
   *      electron, by any binding form (default / namespace / named,
   *      whatever the local alias), and none may reach electron through a
   *      dynamic import or require;
   *   2. text — no production main module calls the registration API, for a
   *      binding that arrived by some route the first layer did not model.
   * Comments mentioning the name are fine; only bindings and calls count.
   */
  const productionMainSources = (): Array<{ path: string; src: string }> => {
    const out: Array<{ path: string; src: string }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (full.endsWith(join("ipc", "guarded-ipc.ts"))) continue;
        out.push({ path: full, src: readFileSync(full, "utf8") });
      }
    };
    walk(join(__dirname, ".."));
    return out;
  };

  function electronIngressBindingReason(src: string, filePath: string): string | null {
    const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    let reason: string | null = null;
    const visit = (node: ts.Node): void => {
      if (reason) return;
      if (ts.isImportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (ts.isStringLiteral(spec) && spec.text === "electron") {
          const clause = node.importClause;
          if (!clause) return;
          if (clause.name) {
            reason = "default import of electron exposes the ingress object";
            return;
          }
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            reason = "namespace import of electron exposes the ingress object";
            return;
          }
          if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              // `imported` is the name in electron; `name` is the local alias.
              const imported = (el.propertyName ?? el.name).text;
              if (imported === "ipcMain") {
                reason = "named import of the ingress object (alias-insensitive)";
                return;
              }
            }
          }
        }
        return;
      }
      // dynamic `import('electron')`
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && arg.text === "electron") {
          reason = "dynamic import('electron') bypasses the static fence";
          return;
        }
      }
      // `require('electron')`
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && arg.text === "electron") {
          reason = "require('electron') bypasses the static fence";
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return reason;
  }

  it("no production main module binds the electron ingress object (AST: default/namespace/named/dynamic)", () => {
    const offenders = productionMainSources()
      .map(({ path, src }) => ({ path, reason: electronIngressBindingReason(src, path) }))
      .filter((entry) => entry.reason !== null)
      .map((entry) => `${entry.path}: ${entry.reason}`);
    expect(offenders).toEqual([]);
  });

  it("the AST fence actually detects every bypass shape (fence self-test)", () => {
    const bypasses = [
      "import electron from 'electron';\nelectron.ipcMain.handle('x', () => {});",
      "import * as e from 'electron';\ne.ipcMain.on('x', () => {});",
      "import { ipcMain as raw } from 'electron';\nraw.handle('x', () => {});",
      "const { ipcMain } = require('electron');",
      "const m = await import('electron');",
    ];
    for (const src of bypasses) {
      expect(electronIngressBindingReason(src, "probe.ts")).not.toBeNull();
    }
    // a legitimate electron import that does NOT bind the ingress object
    expect(
      electronIngressBindingReason("import { app, BrowserWindow } from 'electron';", "probe.ts"),
    ).toBeNull();
  });

  it("no production main module calls the electron ingress registration API", () => {
    const hasRawRegistration = (src: string): boolean => {
      const sf = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.ESNext, true);
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const call = node.expression;
          const receiver =
            ts.isPropertyAccessExpression(call) || ts.isElementAccessExpression(call)
              ? call.expression
              : undefined;
          const method = ts.isPropertyAccessExpression(call)
            ? call.name.text
            : ts.isElementAccessExpression(call) && ts.isStringLiteralLike(call.argumentExpression)
              ? call.argumentExpression.text
              : undefined;
          if (
            receiver &&
            ts.isIdentifier(receiver) &&
            receiver.text === "ipcMain" &&
            (method === "handle" || method === "on")
          )
            found = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    };
    expect(hasRawRegistration("// ipcMain.handle('not code')")).toBe(false);
    expect(hasRawRegistration("ipcMain /* comment */ . handle ('x', fn)")).toBe(true);
    expect(hasRawRegistration("ipcMain['on']('x', fn)")).toBe(true);
    const offenders = productionMainSources()
      .filter(({ src }) => hasRawRegistration(src))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
