import { describe, expect, it } from "vitest";
import { apiPaths, type UserDto } from "@silverhand/shared";
import { extractViewerUserFromProxyResponse } from "../profile-session-sync";

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: "u-1",
    name: "iu",
    display_name: "@iu lakphy",
    avatar_url: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe("extractViewerUserFromProxyResponse", () => {
  it("refreshes bootstrap identity from setup completion and recovery reads", () => {
    const user = userDto({ name: "Alice", display_name: "Alice" });
    for (const method of ["GET", "PUT"]) {
      expect(
        extractViewerUserFromProxyResponse(
          { method, path: apiPaths.embeddedProfileSetup },
          { status: 200, bodyText: JSON.stringify({ required: false, user }) },
        ),
      ).toEqual(user);
    }
    for (const response of [
      { status: 409, bodyText: JSON.stringify({ required: false, user }) },
      { status: 200, bodyText: JSON.stringify({ user }) },
      { status: 200, bodyText: JSON.stringify({ required: false, user: {} }) },
    ]) {
      expect(
        extractViewerUserFromProxyResponse(
          { method: "PUT", path: apiPaths.embeddedProfileSetup },
          response,
        ),
      ).toBeNull();
    }
  });

  it("extracts PATCH /api/me UserDto responses, preserving display names with spaces", () => {
    const user = userDto();

    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("extracts DELETE /api/me/avatar UserDto responses", () => {
    const user = userDto({ avatar_url: null });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "DELETE", path: apiPaths.meAvatar },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("extracts POST /api/me/avatar upload responses from the nested user field", () => {
    const user = userDto({ avatar_url: "silverhand-blob://users/u-1/avatar" });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "POST", path: apiPaths.meAvatar },
        {
          status: 200,
          bodyText: JSON.stringify({
            avatar_url: user.avatar_url,
            user,
          }),
        },
      ),
    ).toEqual(user);
  });

  it("extracts a fresh GET /api/me read, so a remote profile edit can reseat the cache", () => {
    // #task:1702: a profile edit made on ANOTHER machine never passes
    // through this machine's mutation proxy. The only thing that arrives
    // is an invalidation signal, after which the client re-reads
    // `/api/me` — that read is authoritative and must land in the
    // session snapshot, otherwise `auth:getState` keeps serving the
    // login-time DTO until the app restarts. (The narrower #1701 version
    // of this helper ignored reads; that arm is what made the remote case
    // unfixable from the renderer alone.)
    const user = userDto({ display_name: "renamed elsewhere" });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("ignores the pre-registration GET /api/me shape", () => {
    // `GET /api/me` is a union: a viewer DTO or `{registration_required,
    // suggested_name}`. The latter is not a profile and must not overwrite
    // a cached session user.
    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.me },
        {
          status: 200,
          bodyText: JSON.stringify({
            registration_required: true,
            suggested_name: "user-ab12",
          }),
        },
      ),
    ).toBeNull();
  });

  it("ignores non-profile routes, failures, and malformed bodies", () => {
    const user = userDto();

    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 401, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 200, bodyText: '{"not":"a user"}' },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: "/api/workspaces" },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.users },
        { status: 200, bodyText: JSON.stringify({ users: [user] }) },
      ),
    ).toBeNull();
  });
});

// Execute the actual main-process functions without launching Electron or the
// user's backend. Only the network/session environment is supplied by this harness.
// AST selection avoids depending on indentation or copying the implementation.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function mainSessionHarness() {
  const source = ts.createSourceFile(
    "index.ts",
    readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = ["proxyBackendRequest", "reseatCachedUserSessionFromProxy", "desktopAuthState"];
  const functions = names
    .map((name) => {
      const node = source.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      if (!node) throw new Error(`Main function missing: ${name}`);
      return node.getText(source);
    })
    .join("\n");
  let finish: (response: Response) => void = () => {
    throw new Error("request has not started");
  };
  const context = vm.createContext({
    userSessionToken: "session-a",
    userSessionUser: userDto({ name: "local" }),
    extractViewerUserFromProxyResponse,
    logger: undefined,
    Headers,
    assertApiProxyPath: () => {},
    proxyHeaders: () => new Headers(),
    backendUrl: (path: string) => path,
    backendFetch: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    marshalBackendResponse: async (response: Response) => ({
      status: response.status,
      bodyText: await response.text(),
    }),
    runtimeUpgradeMonitor: { onRestResponse: () => {}, reset: () => {} },
    fetchServerInfo: async () => ({ signup_enabled: false }),
    classifyDesktopServerApiCompatibility: () => "compatible",
    DESKTOP_SERVER_API_EPOCH: 4,
    MINIMUM_SERVER_API_EPOCH: 4,
    loadPersistedUserSessionToken: () => null,
    clearUserSessionAfterUnauthorized: async () => {
      context.userSessionToken = null;
      context.userSessionUser = null;
    },
  });
  vm.runInContext(
    ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText,
    context,
  );
  return {
    start: () =>
      context.proxyBackendRequest({ method: "PUT", path: apiPaths.embeddedProfileSetup }),
    finish: (user: UserDto, status = 200) =>
      finish(new Response(JSON.stringify({ required: false, user }), { status })),
    state: () => context.desktopAuthState(),
    switchSession: (token: string | null, user: UserDto | null) => {
      context.userSessionToken = token;
      context.userSessionUser = user;
    },
    cachedUser: () => context.userSessionUser,
  };
}

describe("setup response through main proxy and auth:getState", () => {
  it("returns the completed viewer on the next actual auth-state read", async () => {
    const main = mainSessionHarness();
    const completed = userDto({ name: "Alice", display_name: "Alice" });
    const pending = main.start();
    main.finish(completed);
    await pending;
    expect(await main.state()).toMatchObject({ status: "authenticated", user: completed });
  });

  it("ignores responses after logout or replacement of the issuing session", async () => {
    for (const replacement of [
      { token: null, user: null },
      { token: "session-b", user: userDto({ id: "u-2", name: "Bob" }) },
      { token: "session-a-new", user: userDto({ name: "NewLogin" }) },
    ]) {
      const main = mainSessionHarness();
      const pending = main.start();
      main.switchSession(replacement.token, replacement.user);
      main.finish(userDto({ name: "LateAlice" }));
      await pending;
      expect(main.cachedUser()).toEqual(replacement.user);
    }
  });

  it("does not clear a newer session when an older request returns unauthorized", async () => {
    const main = mainSessionHarness();
    const pending = main.start();
    const current = userDto({ id: "u-2", name: "Bob" });
    main.switchSession("session-b", current);
    main.finish(userDto(), 401);
    await pending;
    expect(await main.state()).toMatchObject({ status: "authenticated", user: current });
  });
});
