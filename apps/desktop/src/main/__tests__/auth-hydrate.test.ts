/**
 * What this pins:
 *
 *   - `classifyMeFetchOutcome`: exhaustive matrix of HTTP /
 *     network outcomes → `SessionValidationResult` arm. ONLY
 *     401/403 → `rejected`. Everything else (network throw, 5xx,
 *     404, 200+malformed body) → `unreachable`.
 *   - `executeHydrate` orchestrator: the three-arm switch. The
 *     load-bearing pin is the **unreachable arm**: it MUST NOT
 *     call `clear`, MUST NOT call `claim`, MUST NOT call `store`.
 *     The persisted token sits on disk untouched. The daemon-host
 *     config sits on disk untouched.
 *   - **Cindy regression scenario** (verbatim from her review of
 *     `1aa85ee`): valid persisted token + `/api/me` network throw
 *     during hydrate ⇒ no clear / no unlink / no
 *     removeDaemonConfig; subsequent serverInfo + `/api/me`
 *     success ⇒ executor returns `authenticated`.
 */
import { describe, expect, it, vi } from "vitest";
import type { UserDto } from "@silverhand/shared";
import {
  classifyMeFetchOutcome,
  executeHydrate,
  type HydrateDeps,
  type SessionValidationResult,
} from "../auth-hydrate";

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: "u-1",
    name: "alice",
    display_name: "Alice",
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as UserDto;
}

describe("classifyMeFetchOutcome — pure /api/me classifier", () => {
  it("200 + valid UserDto body → kind=valid carrying the user", () => {
    const user = userDto({ id: "u-42" });
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 200,
      body: user,
    });
    expect(result).toEqual({ kind: "valid", user });
  });

  it("200 + malformed body → kind=unreachable (server-side bug, NOT auth reject)", () => {
    // Pessimistic-keep: a parse failure means the server is
    // broken, not that the token is invalid. Clearing the token
    // here would force a re-login over a transient server bug.
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 200,
      body: { not: "a user dto" },
    });
    expect(result.kind).toBe("unreachable");
  });

  it("401 → kind=rejected (server affirmed token is bad)", () => {
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 401,
      body: null,
    });
    expect(result).toEqual({ kind: "rejected" });
  });

  it("403 → kind=rejected (server affirmed token is bad)", () => {
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 403,
      body: null,
    });
    expect(result).toEqual({ kind: "rejected" });
  });

  it("500 → kind=unreachable (server reachable but errored — keep token)", () => {
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 500,
      body: "Internal Server Error",
    });
    expect(result.kind).toBe("unreachable");
  });

  it("502 / 503 / 504 → kind=unreachable (gateway issues — keep token)", () => {
    for (const status of [502, 503, 504]) {
      expect(classifyMeFetchOutcome({ kind: "response", status, body: null }).kind).toBe(
        "unreachable",
      );
    }
  });

  it("404 → kind=unreachable (route missing? unexpected backend — keep token)", () => {
    // A misconfigured reverse proxy could 404 /api/me even though
    // the backend is otherwise fine. Don't fold that into "auth
    // reject" — operator needs to fix the proxy, not the user.
    const result = classifyMeFetchOutcome({
      kind: "response",
      status: 404,
      body: null,
    });
    expect(result.kind).toBe("unreachable");
  });

  it("fetch throw (network error) → kind=unreachable with error message", () => {
    const result = classifyMeFetchOutcome({
      kind: "throw",
      error: new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:443"),
    });
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("narrow");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("fetch throw (DNS error) → kind=unreachable", () => {
    const result = classifyMeFetchOutcome({
      kind: "throw",
      error: new Error("getaddrinfo ENOTFOUND down.example.test"),
    });
    expect(result.kind).toBe("unreachable");
  });

  it("non-Error throw is stringified into the unreachable message", () => {
    const result = classifyMeFetchOutcome({
      kind: "throw",
      error: "opaque",
    });
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("narrow");
    expect(result.message).toBe("opaque");
  });
});

describe("executeHydrate — three-arm switch (Cindy P1 regression pins)", () => {
  function makeDeps(overrides: Partial<HydrateDeps> & { token?: string | null }): HydrateDeps & {
    spies: {
      loadToken: ReturnType<typeof vi.fn>;
      validate: ReturnType<typeof vi.fn>;
      store: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      claim: ReturnType<typeof vi.fn>;
    };
  } {
    const tokenValue = "token" in overrides ? overrides.token : "persisted-token-abc";
    const loadToken = vi.fn(() => tokenValue ?? null);
    const validate = vi.fn(
      async () => ({ kind: "unreachable", message: "default" }) as SessionValidationResult,
    );
    const store = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const claim = vi.fn(async () => {});
    const deps: HydrateDeps = {
      loadToken,
      validate,
      store,
      clear,
      claim,
      ...overrides,
    };
    return Object.assign(deps, {
      spies: { loadToken, validate, store, clear, claim },
    });
  }

  it('no_token: empty disk → returns "no_token", no other dep is called', async () => {
    const deps = makeDeps({ token: null });
    const outcome = await executeHydrate(deps);
    expect(outcome).toBe("no_token");
    expect(deps.spies.validate).not.toHaveBeenCalled();
    expect(deps.spies.store).not.toHaveBeenCalled();
    expect(deps.spies.clear).not.toHaveBeenCalled();
    expect(deps.spies.claim).not.toHaveBeenCalled();
  });

  it("valid arm: validate→valid → store + claim called; clear NOT called", async () => {
    const user = userDto({ id: "u-99" });
    const deps = makeDeps({
      validate: vi.fn(async () => ({ kind: "valid", user }) as SessionValidationResult),
    });
    const outcome = await executeHydrate(deps);
    expect(outcome).toBe("authenticated");
    expect(deps.spies.store).toHaveBeenCalledWith("persisted-token-abc", user);
    expect(deps.spies.claim).toHaveBeenCalledTimes(1);
    expect(deps.spies.clear).not.toHaveBeenCalled();
  });

  it("rejected arm: validate→rejected → clear called; store/claim NOT called", async () => {
    const deps = makeDeps({
      validate: vi.fn(async () => ({ kind: "rejected" }) as SessionValidationResult),
    });
    const outcome = await executeHydrate(deps);
    expect(outcome).toBe("rejected");
    expect(deps.spies.clear).toHaveBeenCalledTimes(1);
    expect(deps.spies.store).not.toHaveBeenCalled();
    expect(deps.spies.claim).not.toHaveBeenCalled();
  });

  it("unreachable arm: validate→unreachable → NOTHING is mutated (Cindy P1 load-bearing pin)", async () => {
    // This is the pre-fix bug. Old code's `.catch(() => null)` +
    // `if (!user) await clearUserSession()` would have triggered
    // `clear()` here, which in turn unlinks `session.bin` and
    // removes the daemon-host config. Post-fix: NONE of store /
    // claim / clear may run.
    const deps = makeDeps({
      validate: vi.fn(
        async () =>
          ({
            kind: "unreachable",
            message: "fetch failed: ECONNREFUSED",
          }) as SessionValidationResult,
      ),
    });
    const outcome = await executeHydrate(deps);
    expect(outcome).toBe("unreachable");
    expect(deps.spies.store).not.toHaveBeenCalled();
    expect(deps.spies.claim).not.toHaveBeenCalled();
    expect(deps.spies.clear).not.toHaveBeenCalled();
  });

  it("logger.warn fires on unreachable arm carrying the reason", async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      validate: vi.fn(
        async () =>
          ({
            kind: "unreachable",
            message: "ECONNREFUSED 127.0.0.1:443",
          }) as SessionValidationResult,
      ),
      log: { warn },
    });
    await executeHydrate(deps);
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj).toMatchObject({ reason: "ECONNREFUSED 127.0.0.1:443" });
    expect(String(msg)).toContain("deferred");
  });

  it("logger.info fires on rejected arm (audit trail for explicit token clears)", async () => {
    const info = vi.fn();
    const deps = makeDeps({
      validate: vi.fn(async () => ({ kind: "rejected" }) as SessionValidationResult),
      log: { info },
    });
    await executeHydrate(deps);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("CINDY REGRESSION SCENARIO: valid persisted token + transient unreachable then recovery → no token loss, eventual authenticated", async () => {
    // Two-phase exercise of the executor against the SAME injected
    // deps:
    //
    //   Phase 1 (boot under transient outage): `validate` throws-
    //   shaped result → unreachable. `clear` MUST NOT fire; the
    //   token on disk MUST remain readable.
    //
    //   Phase 2 (renderer Retry → re-fetch /api/me): same token,
    //   same disk, `validate` now returns valid(user). Executor
    //   stores + claims. No login flow required.
    //
    // This pins the entire "transport down at boot doesn't cost
    // user a re-login" invariant end-to-end at the orchestrator
    // level. The renderer-level wiring (desktopAuthState recovery
    // path) is verified separately in the index.ts integration
    // test; this is the orchestrator pin.
    const user = userDto({ id: "u-recover" });
    const loadToken = vi.fn(() => "persisted-token-recover");
    const store = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const claim = vi.fn(async () => {});

    // Phase 1 — backend unreachable.
    const phase1Validate = vi.fn(
      async () =>
        ({
          kind: "unreachable",
          message: "ECONNREFUSED 127.0.0.1:443",
        }) as SessionValidationResult,
    );
    const phase1Outcome = await executeHydrate({
      loadToken,
      validate: phase1Validate,
      store,
      clear,
      claim,
    });
    expect(phase1Outcome).toBe("unreachable");
    expect(clear).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();

    // Phase 2 — backend recovered; same token validates.
    const phase2Validate = vi.fn(async () => ({ kind: "valid", user }) as SessionValidationResult);
    const phase2Outcome = await executeHydrate({
      loadToken,
      validate: phase2Validate,
      store,
      clear,
      claim,
    });
    expect(phase2Outcome).toBe("authenticated");
    expect(store).toHaveBeenCalledWith("persisted-token-recover", user);
    expect(claim).toHaveBeenCalledTimes(1);
    // Critically: clear was NEVER called across both phases. The
    // persisted token survived the outage AND was re-promoted to
    // an in-memory session after recovery without a re-login.
    expect(clear).not.toHaveBeenCalled();
  });
});
