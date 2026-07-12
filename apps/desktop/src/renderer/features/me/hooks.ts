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
import { ApiError, api, apiUpload } from '@/lib/api';
import { clearCurrentUser, setCurrentUserId } from '@/lib/current-user';
import { eventWsClient } from '@/lib/ws-client';
import { clearPlaceMemory } from '@/lib/place-memory';
import {
  clearAvatarBlobCache,
  getAvatarBlobUrl,
  loadAvatarBlobUrl,
} from '@/lib/avatar-blob-cache';

/**
 * Multi-human audit 2026-06-03 #task:857 P0.7 (review-fold by Cindy
 * #task:861). Renderer-local state that is **identity-bound** — its
 * value reveals or depends on who the previous viewer was. Wiped by
 * {@link clearViewerLocalState} on every logout so the next signed-in
 * human starts without inheriting the previous viewer's navigation
 * history or pending gates.
 *
 * Kept INSIDE the file (rather than exported from current-user) so the
 * full ownership of "what survives a logout" stays in one place; if a
 * future preference key is added, this list is the diff target.
 *
 * Two layers are cleared:
 *   1. {@link clearPlaceMemory} — last-channel-per-workspace and
 *      last-thread-per-channel. Maps + disk both wiped.
 *   2. The `IDENTITY_BOUND_KEYS` list below — small set of localStorage
 *      keys that surface previous-viewer activity (which settings tab
 *      was open, whether the setup wizard is pending).
 *
 * What intentionally SURVIVES (device-scoped UI ergonomics — Cindy
 * #task:861 review): theme (`silverhand:appearance`), sidebar
 * visibility toggles, sidebar/split widths, message layout mode, tasks
 * drawer width, agent-section collapse state. None of these reveal who
 * the previous viewer was; they describe how the device's owner likes
 * the chrome to look. If the product contract ever tightens to "every
 * logout returns a factory-default shell", expand this list.
 */
const IDENTITY_BOUND_KEYS: ReadonlyArray<string> = [
  // Setup wizard pin — must clear so the next session's gate logic
  // re-derives from the actual auth state, never inherits a stuck open.
  'silverhand:open-setup-wizard',
  // Last-viewed Settings sub-section — identity-bound because it
  // reveals what the previous viewer was looking at when they signed
  // out. Defaulting back to the wizard-recommended landing tab is
  // strictly safer than inheriting.
  'silverhand:settings-section',
];

function clearViewerLocalState(): void {
  // 1. In-memory + disk for the place-memory maps.
  clearPlaceMemory();
  // 2. App-session avatar blob cache — revoke every cached object URL so the
  //    next signed-in viewer never inherits the previous session's avatars and
  //    the blob memory is released (#task:1321).
  clearAvatarBlobCache();
  // 3. Other identity-bound localStorage keys. Wrap each removal so a
  //    quota error on one doesn't strand the others.
  try {
    for (const key of IDENTITY_BOUND_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Quota / disabled storage — nothing to do, in-memory state is
    // already cleared above.
  }
}

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
      clearViewerLocalState();
      eventWsClient.disconnect();
      qc.clear();
    },
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
  // Shares the app-session avatar cache (#task:1321): the viewer's blob is
  // fetched once and reused by SettingsPage + every chat MessageItem (via the
  // threaded viewer URL), and it survives re-renders without re-fetching. The
  // cache — not this hook — owns the object URL, so there is no revoke here;
  // logout clears it via `clearAvatarBlobCache` in `clearViewerLocalState`.
  const [objectUrl, setObjectUrl] = useState<string | null>(() =>
    avatarUrl ? getAvatarBlobUrl(avatarUrl) ?? null : null,
  );
  useEffect(() => {
    if (!avatarUrl) {
      setObjectUrl(null);
      return;
    }
    const cached = getAvatarBlobUrl(avatarUrl);
    if (cached) {
      setObjectUrl(cached);
      return;
    }
    let cancelled = false;
    void loadAvatarBlobUrl(avatarUrl).then(url => {
      if (!cancelled) setObjectUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [avatarUrl]);
  return objectUrl;
}
