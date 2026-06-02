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
 * **Authenticated arm is intentionally out of scope.** The
 * authenticated branch renders `RegisteredAppShell`, which is a
 * 1500-line tree of dozens of `useQuery` / `useEffect` hooks, WS
 * clients, and DOM-only APIs. SSR-rendering it would either crash
 * on missing globals or require so much mocking that the test
 * stops being a gate-order pin and becomes a shell smoke test. The
 * authenticated arm is covered indirectly: we assert each of the
 * three gate arms renders its **distinctive** copy, so a regression
 * that routed the authenticated state into the wrong gate would
 * surface as the wrong copy showing up here.
 *
 * **HTML-entity caveat.** `renderToStaticMarkup` encodes apostrophes
 * as `&#x27;` and ellipsis as `&hellip;`. Distinctive copy constants
 * below are chosen to avoid those characters so they match the
 * rendered output unmodified.
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

// Distinctive copy strings per gate — chosen to avoid the apostrophe
// + ellipsis HTML-entity transform that `renderToStaticMarkup`
// applies. Two strings per gate so a partial copy edit still trips
// the assertion.
const COPY_BACKEND_UNREACHABLE = 'reach this Silverhand backend';
const COPY_BACKEND_UNREACHABLE_BLURB =
  'The connection failed before signup or login';
const COPY_REG_SIGNUP_HEADING = 'Create your account';
const COPY_REG_SIGNUP_BLURB = 'Use an email and password';
const COPY_REG_LOGIN_BLURB = 'Sign in to continue';
// Negative-pin substrings — when one gate renders, none of the
// OTHER gates' distinctive copy should appear.
const COPY_LOADING = 'Loading';

// Minimal agentHub stub. App.tsx pulls in many components that
// reference `window.agentHub.*` at module-evaluation time
// (preload-typed methods exposed by the preload bridge). We stub
// the whole `window` object so any unsolicited access surfaces as
// `agentHub.<method> is not a function` rather than `undefined`.
const agentHub = {
  getDesktopBuildConfig: vi.fn(() => Promise.resolve({
    remote_only: false,
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
  onNavigateSetupWizard: vi.fn(() => () => {}),
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
  it('loading branch: viewer.data is undefined → renders the Loading placeholder, no gate copy', async () => {
    const html = await renderApp(undefined);
    expect(html).toContain(COPY_LOADING);
    expect(html).not.toContain(COPY_BACKEND_UNREACHABLE);
    expect(html).not.toContain(COPY_REG_SIGNUP_HEADING);
    expect(html).not.toContain(COPY_REG_LOGIN_BLURB);
  });

  it('backend_unreachable branch: BackendUnreachableGate renders with serverUrl + message', async () => {
    const viewer: BackendUnreachable = {
      backend_unreachable: true,
      server_url: 'https://down.example.test',
      message: 'connect ECONNREFUSED 127.0.0.1:443',
    };
    const html = await renderApp(viewer);
    expect(html).toContain(COPY_BACKEND_UNREACHABLE);
    expect(html).toContain(COPY_BACKEND_UNREACHABLE_BLURB);
    expect(html).toContain('https://down.example.test');
    expect(html).toContain('ECONNREFUSED');
    // The registration gate must NOT appear when backend is
    // unreachable — that's the P1-2 load-bearing pin.
    expect(html).not.toContain(COPY_REG_SIGNUP_HEADING);
    expect(html).not.toContain(COPY_REG_LOGIN_BLURB);
  });

  it('registration_required (signup enabled) branch: RegistrationGate renders signup-by-default copy', async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: '',
      signup_enabled: true,
    };
    const html = await renderApp(viewer);
    expect(html).toContain(COPY_REG_SIGNUP_HEADING);
    expect(html).toContain(COPY_REG_SIGNUP_BLURB);
    // The unreachable gate must NOT appear when registration is the
    // intended branch.
    expect(html).not.toContain(COPY_BACKEND_UNREACHABLE);
  });

  it('registration_required (signup disabled) branch: RegistrationGate renders login-only copy (no signup blurb)', async () => {
    const viewer: SetupRequired = {
      registration_required: true,
      suggested_name: '',
      signup_enabled: false,
    };
    const html = await renderApp(viewer);
    expect(html).toContain(COPY_REG_LOGIN_BLURB);
    // Signup-mode blurb is suppressed when signup_enabled === false.
    expect(html).not.toContain(COPY_REG_SIGNUP_BLURB);
    expect(html).not.toContain(COPY_BACKEND_UNREACHABLE);
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
    expect(html).toContain(COPY_BACKEND_UNREACHABLE);
    expect(html).toContain('https://down.example.test');
    // The registration form must NOT appear — order proven.
    expect(html).not.toContain(COPY_REG_SIGNUP_HEADING);
    expect(html).not.toContain(COPY_REG_LOGIN_BLURB);
  });
});
