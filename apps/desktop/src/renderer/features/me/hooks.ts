import { useEffect } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  apiPaths,
  type MeResponse,
  type RegisterUserInput,
  type RegistrationRequired,
  type UpdateUserProfileInput,
  type UserDto,
} from '@silverhand/shared';
import { api, apiUpload } from '@/lib/api';
import { setCurrentUserId } from '@/lib/current-user';

const meKey = ['me'] as const;

function cacheViewer(qc: QueryClient, dto: UserDto): void {
  setCurrentUserId(dto.id, dto.display_name);
  qc.setQueryData(meKey, dto);
}

/**
 * Type guard: discriminates the `/api/me` union by the presence of the
 * `registration_required` literal flag. Both shapes are JSON objects
 * but only one carries the flag.
 */
export function isRegistrationRequired(
  body: MeResponse,
): body is RegistrationRequired {
  return (
    typeof body === 'object'
    && body !== null
    && 'registration_required' in body
    && (body as { registration_required: unknown }).registration_required === true
  );
}

/**
 * React Query view of `/api/me`. Fires once at app boot, then again
 * whenever the renderer invalidates the cache (after a profile or
 * avatar mutation). When the body is a registered `UserDto`, the id is
 * forwarded to `setCurrentUserId` so the renderer's principal helpers
 * resolve against the real viewer id. When the body is the
 * `registration_required` shape, the registration gate mounts.
 */
export function useViewerUser() {
  const query = useQuery({
    queryKey: meKey,
    queryFn: () => api<MeResponse>(apiPaths.me),
    staleTime: 30 * 1000,
  });
  useEffect(() => {
    if (query.data && !isRegistrationRequired(query.data)) {
      setCurrentUserId(query.data.id, query.data.display_name);
    }
  }, [query.data]);
  return query;
}

/** POST /api/register — sole creator of the viewer's `users` row.
 *  Called from `<RegistrationGate />` on the registration form submit.
 *  Atomic INSERT users + write `app_settings.viewer_user_id`.
 *  Errors:
 *   - `name_taken` (409) — collides with an existing user/agent
 *   - `already_registered` (409) — a viewer is already registered
 *  Both surface as `ApiError` with a JSON body the gate parses. */
export function useRegisterUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterUserInput) =>
      api<UserDto>(apiPaths.register, {
        method: 'POST',
        body: JSON.stringify(input),
    }),
    onSuccess: dto => {
      cacheViewer(qc, dto);
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
