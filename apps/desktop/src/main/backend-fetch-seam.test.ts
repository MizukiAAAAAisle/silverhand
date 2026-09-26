import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  CLIENT_INFO_HEADER,
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
} from "@silverhand/shared";
import { fetchBackendWithNetworkPolicy } from "./renderer-backend-network";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function rawFetchOwner(text: string): { source: ts.SourceFile; owner: ts.FunctionDeclaration } {
  const parsed = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
  const uses: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    // Include globalThis.fetch as well as bare fetch passed to a transport.
    if (ts.isIdentifier(node) && node.text === "fetch") uses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (uses.length !== 1) throw new Error(`Expected one raw fetch reference, got ${uses.length}`);
  let owner: ts.Node | undefined = uses[0];
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  if (!owner || !ts.isFunctionDeclaration(owner) || !owner.name)
    throw new Error("Raw fetch has no function owner");
  return { source: parsed, owner };
}

describe("main-process backend HTTP boundary", () => {
  it("has one raw fetch owner, including property access; comments and local renames are irrelevant", () => {
    expect(() => rawFetchOwner(source)).not.toThrow();
    expect(() => rawFetchOwner(source + "\n// fetch(ignored)")).not.toThrow();
    expect(() =>
      rawFetchOwner(source + '\nasync function bypass() { return globalThis.fetch("/api/me"); }'),
    ).toThrow(/raw fetch reference/);
  });

  it.each([
    { name: "generated telemetry", telemetry: "release-info", existing: null },
    { name: "absent optional telemetry", telemetry: null, existing: null },
    { name: "caller telemetry", telemetry: "unused", existing: "existing-info" },
  ])(
    "enforces epoch and forwards request without mutation: $name",
    async ({ telemetry, existing }) => {
      const { source: parsed, owner } = rawFetchOwner(source);
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      const clientInfo = vi.fn(() => telemetry);
      const context = vm.createContext({
        fetch,
        Headers,
        DESKTOP_API_EPOCH_HEADER,
        DESKTOP_SERVER_API_EPOCH,
        CLIENT_INFO_HEADER,
        desktopClientInfoHeaderValue: clientInfo,
        desktopAppPaths: () => ({ installationId: "isolated-installation" }),
        logger: null,
        fetchBackendWithNetworkPolicy,
      });
      const compiled = ts.transpileModule(owner.getText(parsed), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const call = vm.runInContext(compiled + "\n" + owner.name!.text, context) as (
        url: string,
        init: RequestInit,
      ) => Promise<Response>;
      const headers = new Headers({
        Authorization: "Bearer test-session",
        [DESKTOP_API_EPOCH_HEADER]: "-1",
      });
      if (existing) headers.set(CLIENT_INFO_HEADER, existing);
      const signal = new AbortController().signal;
      const response = await call("https://example.test/api/messages", {
        method: "POST",
        body: "payload",
        headers,
        signal,
      });
      expect(response.status).toBe(204);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://example.test/api/messages");
      expect(init).toMatchObject({ method: "POST", body: "payload", signal });
      const sent = new Headers(init.headers);
      expect(sent.get("authorization")).toBe("Bearer test-session");
      expect(sent.get(DESKTOP_API_EPOCH_HEADER)).toBe(String(DESKTOP_SERVER_API_EPOCH));
      expect(sent.get(CLIENT_INFO_HEADER)).toBe(existing ?? telemetry);
      expect(headers.get(DESKTOP_API_EPOCH_HEADER)).toBe("-1");
      expect(headers.get(CLIENT_INFO_HEADER)).toBe(existing);
      expect(clientInfo).toHaveBeenCalledTimes(existing ? 0 : 1);
    },
  );
});
