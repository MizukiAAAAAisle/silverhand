/**
 * D4.a Commit 6 (2) — App.tsx gate-order rendering pin.
 *
 * Cindy `MqA4uoNcRByKcf9E` boundary lock: "Renderer state-machine
 * tests, mocked agentHub — `useViewerUser` three arms, App.tsx gate
 * order".
 *
 * **What this file pins.** App.tsx renders a strict 4-way gate based
 * on the resolved `ViewerState`:
 *
 *   1. `!viewer.data`                    → Loading…
 *   2. `isBackendUnreachable(viewer)`    → <BackendUnreachableGate />
 *   3. `isRegistrationRequired(viewer)`  → <RegistrationGate />
 *   4. otherwise (authenticated UserDto) → <RegisteredAppShell />
 *
 * The load-bearing invariant Cindy P1-2 nailed in the 5d-fixup is
 * the **ordering** between branches 2 and 3 — backend-unreachable
 * MUST take precedence over registration-required so a stale signup
 * gate cannot appear over a profile pointing at a downed server.
 * `state-machine.test.ts` (companion file) pins guard correctness
 * and IPC mapping; THIS file pins gate-order RENDERING by exercising
 * the actual `App` component through `renderToStaticMarkup` with
 * priming of the React Query cache.
 *
 * **Discriminate gates by STRUCTURE, never by copy.** Earlier this
 * pin keyed each gate off its distinctive user-facing copy, which
 * made a pure wording edit (e.g. "Silverhand backend" → "server")
 * trip the assertions even though gate routing was unchanged. We now
 * identify each gate by stable, copy-free signals — a branch-owned
 * `data-gate` marker on the unreachable gate, the email/password form
 * fields and `autocomplete` mode unique to the registration gate, and
 * the server-url / message DATA the unreachable gate echoes from its
 * props. Copy AND iconography are free to change without touching this
 * file.
 *
 * **Authenticated arm is intentionally out of scope.** The
 * authenticated branch renders `RegisteredAppShell`, which is a
 * 1500-line tree of dozens of `useQuery` / `useEffect` hooks, WS
 * clients, and DOM-only APIs. SSR-rendering it would either crash
 * on missing globals or require so much mocking that the test
 * stops being a gate-order pin and becomes a shell smoke test.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserDto } from '@silverhand/shared';
import type {
  BackendUnreachable,
  SetupRequired,
  ViewerState,
} from './hooks';

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
// NB: react-dom/server emits the `autoComplete` prop in camelCase
// (verified against rendered output), not the lowercased HTML form.
const SIG_REG_SIGNUP_AUTOCOMPLETE = 'autoComplete="new-password"';
const SIG_REG_LOGIN_AUTOCOMPLETE = 'autoComplete="current-password"';

// Minimal agentHub stub. App.tsx pulls in many components that
// reference `window.agentHub.*` at module-evaluation time
// (preload-typed methods exposed by the preload bridge). We stub
// the whole `window` object so any unsolicited access surfaces as
// `agentHub.<method> is not a function` rather than `undefined`.
const agentHub = {
  getDesktopBuildConfig: vi.fn(() => Promise.resolve({
    remote_only: false,
    allow_insecure_remote: false,
    default_server_url: '',
  })),
  getAuthState: vi.fn(),
  getBackendInfo: vi.fn(),
  backendRequest: vi.fn(),
  backendUpload: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  onShutdownProgress: vi.fn(() => () => {}),
  onAppearanceUpdated: vi.fn(() => () => {}),
  onNavigateSettings: vi.fn(() => () => {}),
  onBackendInfoUpdated: vi.fn(() => () => {}),
  getAppearance: vi.fn(() => Promise.resolve({ theme: 'system' })),
  setAppearance: vi.fn(),
  revokeHost: vi.fn(),
};

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    name: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as UserDto;
}

async function renderApp(viewer: ViewerState | undefined): Promise<string> {
  // Late-import so the agentHub stub is installed before App.tsx is
  // evaluated. App.tsx pulls in `useAppearance` and a handful of
  // module-scope `useQuery` consumers; they call into
  // `window.agentHub.*` lazily, but a bare top-of-file `import` would
  // still evaluate them before `vi.stubGlobal` ran.
  const { App } = await import('@/App');
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (viewer !== undefined) qc.setQueryData(['me'], viewer);
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(App),
    ),
  );
}

beforeEach(() => {
  // Default getAuthState mock: never resolves — important for the
  // loading branch where we deliberately want `viewer.data` to stay
  // undefined. Individual tests primed via `qc.setQueryData(['me'], ...)`
  // bypass queryFn entirely.
  agentHub.getAuthState.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('window', { agentHub });
  // localStorage is touched by App.tsx (last-channel maps). Stub a
  // tiny in-memory shim so module-level hydration doesn't throw.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
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
  agentHub.getAuthState.mockReset();
});

describe('App.tsx gate ordering (D4.a Commit 6 part 2)', () => {
  it('loading branch: viewer.data is undefined → no gate renders', async () => {
    const html = await renderApp(undefined);
    // Neither gate's structural signal should be present while loading.
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it('backend_unreachable branch: BackendUnreachableGate renders with serverUrl + message', async () => {
    const viewer: BackendUnreachable = {
      backend_unreachable: true,
      server_url: 'https://down.example.test',
      message: 'connect ECONNREFUSED 127.0.0.1:443',
    };
    const html = await renderApp(viewer);
    // Gate identity: the branch-owned data marker unique to this gate.
    expect(html).toContain(SIG_UNREACHABLE_GATE);
    // Data echo: the gate surfaces the server_url + message it is handed.
    expect(html).toContain('https://down.example.test');
    expect(html).toContain('ECONNREFUSED');
    // The registration gate must NOT appear when backend is
    // unreachable — that's the P1-2 load-bearing pin.
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });

  it('registration_required (signup enabled) branch: RegistrationGate renders the signup form', async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: '',
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

  it('registration_required (signup disabled) branch: RegistrationGate renders the login form (current-password, no new-password)', async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: '',
      signup_enabled: false,
    };
    const html = await renderApp(viewer);
    expect(html).toContain(SIG_REG_EMAIL_FIELD);
    expect(html).toContain(SIG_REG_LOGIN_AUTOCOMPLETE);
    // Login mode suppresses the new-password (signup/confirm) wiring.
    expect(html).not.toContain(SIG_REG_SIGNUP_AUTOCOMPLETE);
    expect(html).not.toContain(SIG_UNREACHABLE_GATE);
  });

  it('GATE ORDER (Cindy P1-2): synthetic ViewerState satisfying BOTH backend_unreachable AND registration_required renders the UNREACHABLE gate, not the registration gate', async () => {
    // This payload should never appear on the wire — the IPC only
    // emits one arm at a time. The synthetic case here is the
    // load-bearing regression bait: if a future edit flipped the
    // `isBackendUnreachable` and `isRegistrationRequired` checks in
    // App.tsx, this test would fail by rendering the registration
    // form instead of the unreachable gate.
    const synthetic = {
      backend_unreachable: true,
      server_url: 'https://down.example.test',
      message: 'mixed',
      registration_required: true,
      suggested_name: '',
      signup_enabled: true,
    } as unknown as ViewerState;
    const html = await renderApp(synthetic);
    expect(html).toContain(SIG_UNREACHABLE_GATE);
    expect(html).toContain('https://down.example.test');
    // The registration form must NOT appear — order proven.
    expect(html).not.toContain(SIG_REG_EMAIL_FIELD);
  });
});
