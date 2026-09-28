vi.mock("@/platform", () => ({ getPlatform: () => ({ client: silverhand }) }));
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BackendUnreachable, SetupRequired, ViewerState } from "../session/hooks";

// Copy-free gate discriminators. Each is a structural or data signal
// that does NOT depend on user-facing wording or iconography, so copy
// edits never break this pin (the whole point of the rewrite).
//
//   - Unreachable gate: a branch-owned `data-gate` marker on its root,
//     plus the server_url / message it echoes from its props.
//   - Registration gate: the email + password form fields, with the
//     `autocomplete` mode distinguishing signup (new-password) from
//     login (current-password).
const SIG_UNREACHABLE_GATE = 'data-gate="backend-unreachable"';
const SIG_REG_EMAIL_FIELD = 'type="email"';
const SIG_REG_PASSWORD_FIELD = 'type="password"';
const SIG_REG_SIGNUP_AUTOCOMPLETE = 'autoComplete="new-password"';
const SIG_REG_LOGIN_AUTOCOMPLETE = 'autoComplete="current-password"';

// Minimal silverhand stub. app.tsx pulls in many components that
// reference `window.silverhand.*` at module-evaluation time
// (preload-typed methods exposed by the preload bridge). We stub
// the whole `window` object so any unsolicited access surfaces as
// `silverhand.<method> is not a function` rather than `undefined`.
const silverhand = {
  getConnectionPolicy: vi.fn(() =>
    Promise.resolve({
      remote_only: false,
      allow_insecure_remote: false,
      default_server_url: "",
    }),
  ),
  getAuthState: vi.fn(),
  getBackendInfo: vi.fn(),
  backendRequest: vi.fn(),
  backendUpload: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  onShutdownProgress: vi.fn(() => () => {}),
  onEpochUpdateRequired: vi.fn(() => () => {}),
  onAppearanceUpdated: vi.fn(() => () => {}),
  onNavigateSettings: vi.fn(() => () => {}),
  onBackendInfoUpdated: vi.fn(() => () => {}),
  getAppearance: vi.fn(() => Promise.resolve({ theme: "system" })),
  setAppearance: vi.fn(),
  revokeHost: vi.fn(),
};

async function renderApp(viewer: ViewerState | undefined): Promise<string> {
  // Late-import so the silverhand stub is installed before app.tsx is
  // evaluated. app.tsx pulls in `useAppearance` and a handful of
  // module-scope `useQuery` consumers; they call into
  // `window.silverhand.*` lazily, but a bare top-of-file `import` would
  // still evaluate them before `vi.stubGlobal` ran.
  const { App } = await import("@/app");
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (viewer !== undefined) qc.setQueryData(["me"], viewer);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(App)),
  );
}

beforeEach(() => {
  // Default getAuthState mock: never resolves — important for the
  // loading branch where we deliberately want `viewer.data` to stay
  // undefined. Individual tests primed via `qc.setQueryData(['me'], ...)`
  // bypass queryFn entirely.
  silverhand.getAuthState.mockReturnValue(new Promise(() => {}));

  // localStorage is touched by app.tsx (last-channel maps). Stub a
  // tiny in-memory shim so module-level hydration doesn't throw.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  silverhand.getAuthState.mockReset();
});

describe("app.tsx gate ordering (D4.a Commit 6 part 2)", () => {
  it("loading branch: viewer.data is undefined → no gate renders", async () => {
    const html = await renderApp(undefined);
    // Neither gate's structural signal should be present while loading.
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it("backend_unreachable branch: BackendUnreachableGate renders with serverUrl + message", async () => {
    const viewer: BackendUnreachable = {
      backend_unreachable: true,
      server_url: "https://down.example.test",
      message: "connect ECONNREFUSED 127.0.0.1:443",
    };
    const html = await renderApp(viewer);
    // Gate identity: the branch-owned data marker unique to this gate.
    expect(html).toContain(SIG_UNREACHABLE_GATE);
    // Data echo: the gate surfaces the server_url + message it is handed.
    expect(html).toContain("https://down.example.test");
    expect(html).toContain("ECONNREFUSED");
    // The registration gate must NOT appear when backend is
    // unreachable — that's the P1-2 load-bearing pin.
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it("registration_required (signup enabled) branch: RegistrationGate renders the signup form", async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: "",
      signup_enabled: true,
    };
    const html = await renderApp(viewer);
    expect(html).toContain(SIG_REG_EMAIL_FIELD);
    expect(html).toContain(SIG_REG_PASSWORD_FIELD);
    // Signup mode wires the password field(s) to the new-password
    // autocomplete; login mode would use current-password.
    expect(html).toContain(SIG_REG_SIGNUP_AUTOCOMPLETE);
    // The unreachable gate must NOT appear when registration is the
    // intended branch.
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
  });

  it("registration_required (signup disabled) branch: RegistrationGate renders the login form (current-password, no new-password)", async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: "",
      signup_enabled: false,
    };
    const html = await renderApp(viewer);
    expect(html).toContain(SIG_REG_EMAIL_FIELD);
    expect(html).toContain(SIG_REG_LOGIN_AUTOCOMPLETE);
    // Login mode suppresses the new-password (signup/confirm) wiring.
    expect(html).not.toContain(SIG_REG_SIGNUP_AUTOCOMPLETE);
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
  });

  it("GATE ORDER (Cindy P1-2): synthetic ViewerState satisfying BOTH backend_unreachable AND registration_required renders the UNREACHABLE gate, not the registration gate", async () => {
    // This payload should never appear on the wire — the IPC only
    // emits one arm at a time. The synthetic case here is the
    // load-bearing regression bait: if a future edit flipped the
    // `isBackendUnreachable` and `isRegistrationRequired` checks in
    // app.tsx, this test would fail by rendering the registration
    // form instead of the unreachable gate.
    const synthetic = {
      backend_unreachable: true,
      server_url: "https://down.example.test",
      message: "mixed",
      registration_required: true,
      suggested_name: "",
      signup_enabled: true,
    } as unknown as ViewerState;
    const html = await renderApp(synthetic);
    expect(html).toContain(SIG_UNREACHABLE_GATE);
    expect(html).toContain("https://down.example.test");
    // The registration form must NOT appear — order proven.
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it("update_required branch: UpdateRequiredGate renders and the registered shell does not mount", async () => {
    const viewer = {
      update_required: true,
      direction: "app",
      server_api_epoch: 2,
    } as unknown as ViewerState;
    const html = await renderApp(viewer);
    expect(html).toContain('data-gate="update-required"');
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
  });

  it("GATE ORDER: synthetic ViewerState satisfying BOTH update_required AND registration_required renders the update gate, not the registration form", async () => {
    const synthetic = {
      update_required: true,
      direction: "server",
      server_api_epoch: 0,
      registration_required: true,
      suggested_name: "",
      signup_enabled: true,
    } as unknown as ViewerState;
    const html = await renderApp(synthetic);
    expect(html).toContain('data-gate="update-required"');
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it("GATE ORDER: unreachable wins over update_required (connectivity before compatibility)", async () => {
    const synthetic = {
      backend_unreachable: true,
      server_url: "https://down.example.test",
      message: "mixed",
      update_required: true,
      direction: "app",
      server_api_epoch: 2,
    } as unknown as ViewerState;
    const html = await renderApp(synthetic);
    expect(html).toContain(SIG_UNREACHABLE_GATE);
    expect(html).not.toContain('data-gate="update-required"');
  });
});

it("opens Login for a returning user even when signup remains available", async () => {
  const { RegistrationGate } = await import("./registration-gate");
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(RegistrationGate, { signupEnabled: true, preferLogin: true }),
    ),
  );
  expect(html).toContain(SIG_REG_LOGIN_AUTOCOMPLETE);
  expect(html).not.toContain(SIG_REG_SIGNUP_AUTOCOMPLETE);
});

it("uses the shared themed primary action for password change without the redundant subtitle", async () => {
  const { ChangePasswordForm } = await import("../settings-shell/components/change-password-form");
  const client = new QueryClient();
  client.setQueryData(["password-status", "test-user"], { has_password: true });
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ChangePasswordForm, { userId: "test-user" }),
    ),
  );
  expect(html).toContain('data-button-action="primary"');
  expect(html).not.toContain("You will be signed out on all devices");
});
