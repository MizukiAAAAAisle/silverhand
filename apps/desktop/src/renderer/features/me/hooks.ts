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

export type ViewerState = UserDto | SetupRequired;

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
 * React Query view of the main-process desktop auth state. The main
 * process owns token persistence and validation; the renderer only
 * receives either the resolved user dto or a setup-required marker.
 */
export function useViewerUser() {
  const query = useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<ViewerState> => {
      const state = await window.agentHub.getAuthState();
      if (state.status === 'authenticated') return state.user;
      return {
        registration_required: true,
        suggested_name: '',
        signup_enabled: state.signup_enabled,
      };
    },
    staleTime: 30 * 1000,
  });
  useEffect(() => {
    if (query.data && !isRegistrationRequired(query.data)) {
      setCurrentUserId(query.data.id, query.data.display_name);
    }
  }, [query.data]);
  return query;
}

function authResultToUser(result: Awaited<ReturnType<typeof window.agentHub.signup>>): UserDto {
  if (result.ok) return result.user;
  throw new ApiError(result.status, result.statusText, result.bodyText);
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
    data && !isRegistrationRequired(data) ? data.avatar_url : null;
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
