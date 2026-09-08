/**
 * D4.a Commit 6 (2) — renderer state-machine tests.
 *
 * Cindy `MqA4uoNcRByKcf9E` boundary lock: "Renderer state-machine
 * tests, mocked silverhand — `useViewerUser` three arms, App.tsx gate
 * order".
 *
 * Two layers tested here:
 *
 *   1. **`mapAuthStateToViewer`** — pure mapping from the
 *      preload `DesktopAuthState` IPC arm to the renderer
 *      `ViewerState` union. Extracted out of `useViewerUser` so we
 *      can pin the IPC → renderer arm correspondence without
 *      spinning up React Query / DOM.
 *
 *   2. **`isBackendUnreachable` / `isRegistrationRequired` type
 *      guards** — these guards are what `App.tsx`'s gate-order
 *      branch checks call (in that order). The order itself is
 *      pinned by `App.gate-order.test.ts` rendering; this file
 *      pins the discrimination correctness (no false positives /
 *      negatives across arms, including the "both flags set"
 *      synthetic case that would smuggle a backend-unreachable
 *      payload past a registration-first gate-order regression).
 *
 *   3. **`authResultToUser`** — `signup`/`login` IPC result
 *      → typed `ApiError`. Pin that `result.status === 0`
 *      surfaces as `kind: 'backend_unreachable'` so the form-
 *      level error handler can branch on it identically to the
 *      boot-time gate.
 *
 * The silverhand IPC is mocked via `vi.stubGlobal('window', ...)` —
 * the same pattern as `apps/desktop/src/renderer/lib/api.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  authResultToUser,
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  mapAuthStateToViewer,
  subscribeRuntimeEpochPromotion,
  type BackendUnreachable,
  type SetupRequired,
  type UpdateRequired,
  type ViewerState,
} from "./hooks";
import { ApiError } from "@/lib/api";
import type { UserDto } from "@silverhand/shared";

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

describe("mapAuthStateToViewer — three IPC arms (D4.a Commit 6 part 2)", () => {
  it("authenticated arm → returns UserDto verbatim (no wrapper, no extra fields)", () => {
    const user = userDto({ id: "u-42", display_name: "Forty Two" });
    const viewer = mapAuthStateToViewer({
      status: "authenticated",
      signup_enabled: true,
      user,
    });
    // Pinning identity, not just equality — the gate decision uses
    // `data.id` and a regression that wrapped the dto would force a
    // refactor on every downstream consumer.
    expect(viewer).toBe(user);
  });

  it("unauthenticated arm → SetupRequired with passed-through signup_enabled (true)", () => {
    const viewer = mapAuthStateToViewer({
      status: "unauthenticated",
      signup_enabled: true,
    });
    expect(viewer).toEqual({
      registration_required: true,
      suggested_name: "",
      signup_enabled: true,
    } satisfies SetupRequired);
  });

  it("unauthenticated arm with signup disabled → SetupRequired carries the disabled bit", () => {
    // Renderer's RegistrationGate uses this to flip into login-only
    // mode (suppressing the signup tab).
    const viewer = mapAuthStateToViewer({
      status: "unauthenticated",
      signup_enabled: false,
    });
    expect(viewer).toEqual({
      registration_required: true,
      suggested_name: "",
      signup_enabled: false,
    } satisfies SetupRequired);
  });

  it("backend_unreachable arm → BackendUnreachable WITHOUT signup_enabled (Cindy P1-2 pin)", () => {
    // Load-bearing pin: when the server is unreachable we don't know
    // its signup policy. Leaking a default `signup_enabled` here
    // would push the renderer's downstream copy toward a wrong CTA
    // (e.g. "sign in" when the real server has signup enabled).
    const viewer = mapAuthStateToViewer({
      status: "backend_unreachable",
      server_url: "https://backend.example.test",
      message: "fetch failed",
    });
    expect(viewer).toEqual({
      backend_unreachable: true,
      server_url: "https://backend.example.test",
      message: "fetch failed",
    } satisfies BackendUnreachable);
    // Explicit negative — pinning a missing field is the load-bearing
    // part; `toEqual` alone would not fail on an extra field.
    expect((viewer as ViewerState & { signup_enabled?: boolean }).signup_enabled).toBeUndefined();
  });

  // #task:1761 — the two epoch hard-gate arms map to the UpdateRequired
  // marker with the direction discriminant; no signup_enabled leaks through
  // an incompatible pair for the same reason as backend_unreachable.
  it("app_update_required arm → UpdateRequired with direction app", () => {
    const viewer = mapAuthStateToViewer({
      status: "app_update_required",
      server_api_epoch: 3,
      minimum_client_epoch: 2,
    });
    expect(viewer).toEqual({
      update_required: true,
      direction: "app",
      server_api_epoch: 3,
    } satisfies UpdateRequired);
    expect(isUpdateRequired(viewer)).toBe(true);
    expect((viewer as ViewerState & { signup_enabled?: boolean }).signup_enabled).toBeUndefined();
  });

  it("server_update_required arm → UpdateRequired with direction server", () => {
    const viewer = mapAuthStateToViewer({
      status: "server_update_required",
      server_api_epoch: 1,
      desktop_api_epoch: 2,
    });
    expect(viewer).toEqual({
      update_required: true,
      direction: "server",
      server_api_epoch: 1,
    } satisfies UpdateRequired);
    expect(isUpdateRequired(viewer)).toBe(true);
  });

  it("isUpdateRequired is false for the other three viewer shapes", () => {
    expect(
      isUpdateRequired({
        backend_unreachable: true,
        server_url: "https://x.test",
        message: "down",
      }),
    ).toBe(false);
    expect(
      isUpdateRequired({
        registration_required: true,
        suggested_name: "",
        signup_enabled: true,
      }),
    ).toBe(false);
  });
});

// #task:1763 — the renderer half of runtime promotion, tested through the
// subscription seam: the captured callback must invalidate EXACTLY the
// auth-state key (so the live useViewerUser observer refetches getAuthState
// and the precheck gates), and teardown must flow through.
describe("subscribeRuntimeEpochPromotion (runtime promotion seam)", () => {
  it("captured callback invalidates exactly the auth-state key", () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    let captured: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const returned = subscribeRuntimeEpochPromotion(qc, (handler) => {
      captured = handler;
      return unsubscribe;
    });
    expect(captured).toBeTypeOf("function");
    expect(invalidateSpy).not.toHaveBeenCalled();
    captured!();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["me"] });
    // repeated pushes stay idempotent in effect: same single key each time
    captured!();
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenLastCalledWith({ queryKey: ["me"] });
    // teardown flows through to the underlying unsubscribe
    expect(returned).toBe(unsubscribe);
  });
});

describe("isBackendUnreachable / isRegistrationRequired type guards", () => {
  it("isBackendUnreachable true for BackendUnreachable shape (exclusivity comes from gate order, not this guard)", () => {
    expect(
      isBackendUnreachable({
        backend_unreachable: true,
        server_url: "https://x",
        message: "oops",
      }),
    ).toBe(true);
    expect(
      isBackendUnreachable({
        registration_required: true,
        suggested_name: "",
        signup_enabled: true,
      }),
    ).toBe(false);
    expect(isBackendUnreachable(userDto())).toBe(false);
  });

  it("isRegistrationRequired true for SetupRequired shape (exclusivity comes from gate order, not this guard)", () => {
    expect(
      isRegistrationRequired({
        registration_required: true,
        suggested_name: "",
        signup_enabled: true,
      }),
    ).toBe(true);
    expect(
      isRegistrationRequired({
        backend_unreachable: true,
        server_url: "https://x",
        message: "oops",
      }),
    ).toBe(false);
    expect(isRegistrationRequired(userDto())).toBe(false);
  });

  it('synthetic "both flags set" payload still discriminates uniquely — backend_unreachable wins because App.tsx checks it FIRST', () => {
    // Cindy P1-2 gate-order constraint: in `App.tsx` the
    // `isBackendUnreachable` check fires BEFORE
    // `isRegistrationRequired`. If a regression flipped the
    // order, this synthetic ViewerState (which shouldn't exist on
    // the wire — IPC only emits one arm at a time) would expose it
    // by being routed to the registration gate instead of the
    // unreachable gate.
    //
    // The guards themselves are intentionally non-exclusive — each
    // only checks its own marker. The exclusivity comes from the
    // GATE ORDER, which is what we are pinning here at the
    // guard-composition level (a full DOM render pin lives in
    // `App.gate-order.test.ts`).
    const synthetic = {
      backend_unreachable: true,
      server_url: "https://x",
      message: "oops",
      registration_required: true,
      suggested_name: "",
      signup_enabled: false,
    } as unknown as ViewerState;
    // Both guards return true on the synthetic payload — the gate
    // order is what disambiguates, not the guards. Pin both true so
    // a future refactor that tries to "fix" them to be mutually
    // exclusive (instead of fixing the gate-order pin) fails loud.
    expect(isBackendUnreachable(synthetic)).toBe(true);
    expect(isRegistrationRequired(synthetic)).toBe(true);
  });

  it("null / non-object inputs do not crash the guards", () => {
    // Defense-in-depth: the guards run on `viewer.data` which is
    // `undefined | ViewerState`. App.tsx checks `!viewer.data` first
    // so the guards only see real shapes, but pin the safety here
    // so a regression that re-ordered the loading-branch check
    // doesn't crash.
    expect(isBackendUnreachable(null as unknown as ViewerState)).toBe(false);
    expect(isRegistrationRequired(null as unknown as ViewerState)).toBe(false);
    expect(isBackendUnreachable({} as ViewerState)).toBe(false);
    expect(isRegistrationRequired({} as ViewerState)).toBe(false);
  });
});

describe("authResultToUser — signup/login result → ApiError kind mapping", () => {
  // `useViewerUser` covers the boot-time arm. This helper covers the
  // FORM-time arm: after the user is on the registration gate, a
  // mid-typing network failure should surface a typed ApiError with
  // `kind === 'backend_unreachable'` so the form-level error handler
  // can branch on the same discriminator the boot gate uses.

  it("ok=true result → returns UserDto verbatim", () => {
    const user = userDto({ id: "u-99" });
    const out = authResultToUser({ ok: true, user });
    expect(out).toBe(user);
  });

  it("ok=false with status: 0 → throws ApiError with kind=backend_unreachable", () => {
    let caught: unknown;
    try {
      authResultToUser({
        ok: false,
        status: 0,
        statusText: "Network Error",
        bodyText: "",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("backend_unreachable");
    expect((caught as ApiError).status).toBe(0);
  });

  it("ok=false with non-zero HTTP status → throws ApiError with kind=http (regression bait)", () => {
    // Pin the negative arm — a regression that always tagged
    // ApiError as `backend_unreachable` would mask real 401 / 400
    // auth-failed responses as "server down", which the form
    // handler renders very differently.
    let caught: unknown;
    try {
      authResultToUser({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        bodyText: JSON.stringify({ error_code: "auth_failed" }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("http");
    expect((caught as ApiError).status).toBe(401);
    // Body is preserved verbatim so the form's `authErrorMessage`
    // helper can parse `error_code: 'auth_failed'`.
    expect((caught as ApiError).body).toContain("auth_failed");
  });
});

describe("useViewerUser ← mapAuthStateToViewer wiring (end-to-end through React Query queryFn)", () => {
  // We don't render the hook in a DOM here — instead we exercise
  // the queryFn body indirectly by invoking the silverhand mock and
  // feeding its result through `mapAuthStateToViewer`. The
  // `useViewerUser` body in `hooks.ts` is now a one-liner around
  // the mapper, so this is a faithful end-to-end pin without the
  // React-DOM weight.

  const silverhand = {
    getAuthState: vi.fn(),
    signup: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };

  beforeEach(() => {
    silverhand.getAuthState.mockReset();
    silverhand.signup.mockReset();
    silverhand.login.mockReset();
    silverhand.logout.mockReset();
    vi.stubGlobal("window", { silverhand });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("IPC authenticated → ViewerState carries the user", async () => {
    const user = userDto({ id: "u-wire", display_name: "Wire" });
    silverhand.getAuthState.mockResolvedValueOnce({
      status: "authenticated",
      signup_enabled: true,
      user,
    });
    const viewer = mapAuthStateToViewer(await window.silverhand.getAuthState());
    expect(viewer).toBe(user);
  });

  it("IPC backend_unreachable → ViewerState carries server_url + message, no signup_enabled", async () => {
    silverhand.getAuthState.mockResolvedValueOnce({
      status: "backend_unreachable",
      server_url: "https://down.example.test",
      message: "connect ECONNREFUSED 127.0.0.1:443",
    });
    const viewer = mapAuthStateToViewer(await window.silverhand.getAuthState());
    expect(isBackendUnreachable(viewer)).toBe(true);
    if (!isBackendUnreachable(viewer)) throw new Error("unreachable");
    expect(viewer.server_url).toBe("https://down.example.test");
    expect(viewer.message).toContain("ECONNREFUSED");
  });

  it("IPC unauthenticated → ViewerState is SetupRequired with signup_enabled", async () => {
    silverhand.getAuthState.mockResolvedValueOnce({
      status: "unauthenticated",
      signup_enabled: false,
    });
    const viewer = mapAuthStateToViewer(await window.silverhand.getAuthState());
    expect(isRegistrationRequired(viewer)).toBe(true);
    if (!isRegistrationRequired(viewer)) throw new Error("unreachable");
    expect(viewer.signup_enabled).toBe(false);
  });
});
