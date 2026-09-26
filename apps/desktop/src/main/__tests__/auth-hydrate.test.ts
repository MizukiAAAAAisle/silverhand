import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDto } from "@silverhand/shared";
import {
  classifyMeFetchOutcome,
  executeHydrate,
  type HydrateDeps,
  type MeFetchOutcome,
} from "../auth-hydrate";
import {
  clearPersistedDesktopSession,
  loadPersistedDesktopSessionToken,
  persistDesktopSessionToken,
} from "../desktop-session-storage";

const user: UserDto = {
  id: "u-recover",
  name: "alice",
  display_name: "Alice",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
};

describe("classifyMeFetchOutcome", () => {
  it("accepts a valid viewer but does not treat a malformed success as a logout", () => {
    expect(classifyMeFetchOutcome({ kind: "response", status: 200, body: user })).toEqual({
      kind: "valid",
      user,
    });
    expect(
      classifyMeFetchOutcome({ kind: "response", status: 200, body: { not: "a user" } }),
    ).toMatchObject({ kind: "unreachable" });
  });

  it.each([401, 403])("treats HTTP %i as an explicit rejection", (status) => {
    expect(classifyMeFetchOutcome({ kind: "response", status, body: null })).toEqual({
      kind: "rejected",
    });
  });

  it.each([404, 500, 502, 503, 504])("preserves a token on HTTP %i", (status) => {
    expect(classifyMeFetchOutcome({ kind: "response", status, body: null })).toEqual({
      kind: "unreachable",
      message: `HTTP ${status}`,
    });
  });

  it.each([
    new TypeError("fetch failed: ECONNREFUSED"),
    new Error("getaddrinfo ENOTFOUND"),
    "opaque",
  ])("keeps transport failure diagnostic: %s", (error) => {
    expect(classifyMeFetchOutcome({ kind: "throw", error })).toEqual({
      kind: "unreachable",
      message: error instanceof Error ? error.message : error,
    });
  });
});

describe("executeHydrate with isolated persisted session", () => {
  let sessionPath: string;
  let root: string;
  beforeEach(() => {
    const artifacts = process.env.SILVERHAND_DIR;
    if (!artifacts) throw new Error("hydrate test requires isolated SILVERHAND_DIR");
    mkdirSync(artifacts, { recursive: true });
    root = mkdtempSync(join(artifacts, "hydrate-"));
    sessionPath = join(root, "desktop", "session.bin");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function dependencies(outcome: () => MeFetchOutcome) {
    const validate = vi.fn(async () => classifyMeFetchOutcome(outcome()));
    const store = vi.fn(async (token: string, _user: UserDto) => {
      persistDesktopSessionToken({ sessionPath, token });
    });
    const clear = vi.fn(async () => {
      clearPersistedDesktopSession({ sessionPath });
    });
    const claim = vi.fn(async () => {});
    const warn = vi.fn();
    const info = vi.fn();
    return {
      loadToken: () => loadPersistedDesktopSessionToken({ sessionPath }),
      validate,
      store,
      clear,
      claim,
      log: { warn, info },
    } satisfies HydrateDeps;
  }

  it("does nothing when no token is stored", async () => {
    const deps = dependencies(() => ({ kind: "response", status: 200, body: user }));
    expect(await executeHydrate(deps)).toBe("no_token");
    for (const effect of [deps.validate, deps.store, deps.clear, deps.claim]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("clears a rejected token with an audit record, without storing or claiming", async () => {
    persistDesktopSessionToken({ sessionPath, token: "rejected-token" });
    const deps = dependencies(() => ({ kind: "response", status: 401, body: null }));
    expect(await executeHydrate(deps)).toBe("rejected");
    expect(deps.validate).toHaveBeenCalledExactlyOnceWith("rejected-token");
    expect(deps.loadToken()).toBeNull();
    expect(deps.clear).toHaveBeenCalledTimes(1);
    expect(deps.log.info).toHaveBeenCalledTimes(1);
    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("retains the persisted token across outage and waits for successful storage before claiming", async () => {
    persistDesktopSessionToken({ sessionPath, token: "persisted-token-recover" });
    let outcome: MeFetchOutcome = { kind: "throw", error: new TypeError("ECONNREFUSED") };
    const deps = dependencies(() => outcome);

    expect(await executeHydrate(deps)).toBe("unreachable");
    expect(readFileSync(sessionPath, "utf8")).toBe("persisted-token-recover");
    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.clear).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith({ reason: "ECONNREFUSED" }, expect.any(String));

    outcome = { kind: "response", status: 200, body: user };
    let finishStorage!: () => void;
    const pendingStorage = new Promise<void>((resolve) => {
      finishStorage = resolve;
    });
    deps.store.mockImplementationOnce(async (token) => {
      await pendingStorage;
      persistDesktopSessionToken({ sessionPath, token });
    });
    const recovered = executeHydrate(deps);
    // validate resolves before store starts; store remains pending.
    await Promise.resolve();
    expect(deps.store).toHaveBeenCalledExactlyOnceWith("persisted-token-recover", user);
    expect(deps.claim).not.toHaveBeenCalled();
    finishStorage();
    expect(await recovered).toBe("authenticated");
    expect(deps.validate.mock.calls).toEqual([
      ["persisted-token-recover"],
      ["persisted-token-recover"],
    ]);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(deps.clear).not.toHaveBeenCalled();
    expect(deps.loadToken()).toBe("persisted-token-recover");
  });
});
