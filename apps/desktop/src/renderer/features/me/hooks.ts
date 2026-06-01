import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  apiPaths,
  type AuthLoginInput,
  type AuthSignupInput,
  type MeResponse,
  type RegistrationRequired,
  type UpdateUserProfileInput,
  type UserDto,
} from '@silverhand/shared';
import { ApiError, api, apiUpload, fetchBackendBlob } from '@/lib/api';
import { clearCurrentUser, setCurrentUserId } from '@/lib/current-user';
import { eventWsClient } from '@/lib/ws-client';

const meKey = ['me'] as const;

export type SetupRequired = RegistrationRequired & {
  signup_enabled: boolean;
};

/**
 * D4.a Commit 5d-fixup (Cindy P1-2): typed renderer arm for a
 * remote backend that is unreachable at fetch time. Pinned to the
 * preload `DesktopAuthState.backend_unreachable` arm so a
 * profile-saved-then-server-down boot lands on a typed UI gate
 * instead of the IPC promise rejecting and pinning the renderer
 * on a Loading spinner. **No `signup_enabled`** — when the server
 * is unreachable we don't know its policy.
 */
export interface BackendUnreachable {
  backend_unreachable: true;
  server_url: string;
  message: string;
}

export type ViewerState = UserDto | SetupRequired | BackendUnreachable;

function cacheViewer(qc: QueryClient, dto: UserDto): void {
  setCurrentUserId(dto.id, dto.display_name);
  qc.setQueryData(meKey, dto);
}

/** Type guard for the setup-required auth state. */
export function isRegistrationRequired(body: ViewerState): body is SetupRequired;
export function isRegistrationRequired(body: MeResponse): body is RegistrationRequired;
export function isRegistrationRequired(
  body: MeResponse | ViewerState,
): body is RegistrationRequired | SetupRequired {
  return (
    typeof body === 'object'
    && body !== null
    && 'registration_required' in body
    && (body as { registration_required: unknown }).registration_required === true
  );
}

/**
 * D4.a Commit 5d-fixup (Cindy P1-2): type guard for the
 * backend-unreachable arm. Renderer gates (App.tsx) check this
 * BEFORE `isRegistrationRequired` so the connect-banner takes
 * precedence over the setup wizard.
 */
export function isBackendUnreachable(body: ViewerState): body is BackendUnreachable {
  return (
    typeof body === 'object'
    && body !== null
    && 'backend_unreachable' in body
    && (body as { backend_unreachable: unknown }).backend_unreachable === true
  );
}

/**
 * D4.a Commit 6 (2) — pure mapping from the main-process IPC arm to
 * the renderer's `ViewerState` union. Extracted out of `useViewerUser`
 * so the three-way IPC → renderer mapping is testable without
 * React-DOM + React Query plumbing.
 *
 * The mapping is intentionally narrow:
 *   - `authenticated`        → `UserDto` (the `state.user` object)
 *   - `backend_unreachable`  → `BackendUnreachable` (NO `signup_enabled`)
 *   - `unauthenticated`      → `SetupRequired` (`signup_enabled` from IPC)
 *
 * The `backend_unreachable` arm intentionally drops `signup_enabled`
 * because the main process didn't successfully read it from the
 * unreachable server. Letting it leak through would re-introduce the
 * "default to disabled / push wrong CTA" footgun Cindy 5d-fixup P1-2
 * called out.
 */
export function mapAuthStateToViewer(
  state: Awaited<ReturnType<typeof window.agentHub.getAuthState>>,
): ViewerState {
  if (state.status === 'authenticated') return state.user;
  if (state.status === 'backend_unreachable') {
    return {
      backend_unreachable: true,
      server_url: state.server_url,
      message: state.message,
    };
  }
  return {
    registration_required: true,
    suggested_name: '',
    signup_enabled: state.signup_enabled,
  };
}

/**
 * React Query view of the main-process desktop auth state. The main
 * process owns token persistence and validation; the renderer only
 * receives either the resolved user dto, a setup-required marker,
 * or (D4.a Commit 5d-fixup) a backend-unreachable marker.
 */
export function useViewerUser() {
  const query = useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<ViewerState> =>
      mapAuthStateToViewer(await window.agentHub.getAuthState()),
    staleTime: 30 * 1000,
  });
  useEffect(() => {
    if (
      query.data
      && !isRegistrationRequired(query.data)
      && !isBackendUnreachable(query.data)
    ) {
      setCurrentUserId(query.data.id, query.data.display_name);
    }
  }, [query.data]);
  return query;
}

export function authResultToUser(result: Awaited<ReturnType<typeof window.agentHub.signup>>): UserDto {
  if (result.ok) return result.user;
  // D4.a Commit 5d-fixup (Cindy P1-2): preserve the typed
  // backend-unreachable signal end-to-end. `status: 0` is the
  // sentinel main-process proxy uses to report that the
  // signup/login fetch never reached the server; we tag the
  // ApiError so callers branching on `err.kind` get the typed
  // arm instead of a generic "0 Network Error" HTTP error.
  const kind: 'http' | 'backend_unreachable' =
    result.status === 0 ? 'backend_unreachable' : 'http';
  throw new ApiError(result.status, result.statusText, result.bodyText, kind);
}

export function useSignupUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthSignupInput) =>
      authResultToUser(await window.agentHub.signup(input)),
    onSuccess: dto => {
      cacheViewer(qc, dto);
    },
  });
}

export function useLoginUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthLoginInput) =>
      authResultToUser(await window.agentHub.login(input)),
    onSuccess: dto => {
      cacheViewer(qc, dto);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => window.agentHub.logout(),
    onSuccess: () => {
      clearCurrentUser();
      eventWsClient.disconnect();
      qc.clear();
    },
  });
}

/**
 * D3.e — "Sign out and disable this host" two-step affordance.
 *
 * Reuses the existing `hosts:revoke` + `auth:logout` IPCs in a strict
 * sequence; intentionally does NOT introduce a cross-cutting "atomic"
 * IPC because (a) we already pay for two HTTP round-trips and the
 * compound semantics are clear without a new contract, (b) revoke
 * failures need to leave the user signed-in so they can retry from
 * the Hosts page, which is awkward to express in a single result
 * shape.
 *
 * Sequence (strict — no skipping):
 *   1. revoke current local host via `window.agentHub.revokeHost`.
 *      If the result is `ok: false` or the call throws, we STOP HERE
 *      and surface the failure. The user remains signed in.
 *   2. only on revoke success: call `window.agentHub.logout()` + the
 *      same renderer cleanup as the plain Log out path
 *      (`clearCurrentUser` / WS disconnect / `qc.clear()`).
 *
 * Cindy review gates (#task:636):
 *   - The plain `useLogout` above is NEVER called with a revoke
 *     side-effect baked in. The "disable host" path is only reachable
 *     from this hook, not from the default Log out button.
 *   - Revoke-then-logout is strictly sequential. A half-failure
 *     (revoke OK but logout network blip) leaves a revoked host with
 *     a stale local session — recoverable by retrying logout; less
 *     bad than the inverse (logged out with a still-active host
 *     token sitting in daemon-config, which would survive a
 *     re-launch and silently re-attach).
 *
 * Errors are returned as `{ ok: false, kind, message }` so the
 * caller can render a banner without try/catching the mutation
 * promise. Transport / unexpected throws bubble through the
 * mutation's `error` channel and the UI surfaces them via the
 * mutation hook's `error` (mirroring the plain `useLogout`).
 */
export type LogoutAndDisableHostResult =
  | { ok: true }
  | {
      ok: false;
      /** Where in the two-step sequence the failure landed. The
       *  `revoke_*` arms guarantee the user is STILL SIGNED IN. */
      kind: 'no_current_host' | 'revoke_failed' | 'logout_failed';
      message: string;
    };

/**
 * Pure orchestration over injected deps — the hook below wires the
 * production deps (window.agentHub + renderer cleanup) and tests
 * inject fakes to pin every sequence arm without React Query.
 */
export interface LogoutAndDisableHostDeps {
  revokeHost: typeof window.agentHub.revokeHost;
  logout: typeof window.agentHub.logout;
  onLogoutSuccess: () => void;
}

export async function runLogoutAndDisableHost(
  input: { hostId: string | null },
  deps: LogoutAndDisableHostDeps,
): Promise<LogoutAndDisableHostResult> {
  // Guard before any IPC: a button-press while `local_host_id` is
  // null (e.g. unclaimed state) MUST NOT silently fall through.
  if (input.hostId === null) {
    return {
      ok: false,
      kind: 'no_current_host',
      message:
        'This computer is not connected. Use Log out instead.',
    };
  }
  // Step 1 — revoke. If the daemon revoke route returns ok:false
  // (e.g. unauthorized / host_not_found / network_error) we abort
  // BEFORE touching session state. The user can re-attempt from
  // either this button or the Hosts page revoke button.
  let revokeResult: Awaited<ReturnType<typeof window.agentHub.revokeHost>>;
  try {
    revokeResult = await deps.revokeHost({ hostId: input.hostId });
  } catch (err) {
    return {
      ok: false,
      kind: 'revoke_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!revokeResult.ok) {
    return {
      ok: false,
      kind: 'revoke_failed',
      message: revokeResult.message ?? revokeResult.code,
    };
  }
  // Step 2 — logout. At this point the server-side host record is
  // already revoked. A logout failure here is recoverable: the
  // daemon won't reconnect because its token is invalidated, so
  // the worst case is a stale local session that gets cleared on
  // app relaunch.
  try {
    await deps.logout();
  } catch (err) {
    return {
      ok: false,
      kind: 'logout_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  deps.onLogoutSuccess();
  return { ok: true };
}

export function useLogoutAndDisableHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      hostId: string | null;
    }): Promise<LogoutAndDisableHostResult> =>
      runLogoutAndDisableHost(input, {
        revokeHost: input2 => window.agentHub.revokeHost(input2),
        logout: () => window.agentHub.logout(),
        onLogoutSuccess: () => {
          clearCurrentUser();
          eventWsClient.disconnect();
          qc.clear();
        },
      }),
  });
}

/** PATCH /api/me. By design only `display_name` is accepted —
 *  `name` is set once at registration. On success the cached viewer
 *  is invalidated so the next render picks up the new display name. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserProfileInput) =>
      api<UserDto>(apiPaths.me, {
        method: 'PATCH',
        body: JSON.stringify(input),
    }),
    onSuccess: dto => {
      cacheViewer(qc, dto);
    },
  });
}

export interface UploadAvatarVars {
  /** Renderer-side limit so users get fast feedback before the
   *  upload starts. Backend mirrors this with the same shared cap. */
  file: File;
}

/** POST /api/me/avatar (multipart). Returns the new avatar_url +
 *  full updated user dto. */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file }: UploadAvatarVars) => {
      const form = new FormData();
      form.set('file', file);
      return apiUpload<{ avatar_url: string; user: UserDto }>(
        apiPaths.meAvatar,
        form,
      );
    },
    onSuccess: result => {
      cacheViewer(qc, result.user);
    },
  });
}

/** DELETE /api/me/avatar — clears the avatar pointer + blob. */
export function useClearAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<UserDto>(apiPaths.meAvatar, { method: 'DELETE' }),
    onSuccess: dto => {
      cacheViewer(qc, dto);
    },
  });
}

/**
 * Resolve the viewer's avatar to a renderable object URL.
 *
 * `UserDto.avatar_url` is a backend path that requires session auth.
 * `<img src>` can't carry headers, so we mirror the attachment
 * pattern: fetch the blob through the main-process auth proxy, wrap in
 * `URL.createObjectURL`, and revoke when the URL changes or the
 * consumer unmounts.
 *
 * Multiple consumers (SettingsPage + the active ChannelView, which
 * passes the URL down to every chat MessageItem) call this hook
 * concurrently. React Query's `useViewerUser` cache already de-dupes
 * the dto fetch; the blob fetch itself is small and the browser's HTTP
 * cache handles repeats. If profile loading is null/registration_required,
 * returns `null` so callers fall back to a placeholder.
 */
export function useViewerAvatarObjectUrl(): string | null {
  const { data } = useViewerUser();
  const avatarUrl =
    data && !isRegistrationRequired(data) && !isBackendUnreachable(data)
      ? data.avatar_url
      : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    if (!avatarUrl) {
      setObjectUrl(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetchBackendBlob(avatarUrl);
        if (cancelled) {
          URL.revokeObjectURL(res.url);
          return;
        }
        createdUrl = res.url;
        setObjectUrl(createdUrl);
      } catch {
        // Best-effort — falls back to the placeholder.
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [avatarUrl]);
  return objectUrl;
}
