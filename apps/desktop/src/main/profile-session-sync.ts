import {
  apiPaths,
  UserDtoSchema,
  type UserDto,
} from '@silverhand/shared';

export interface ProfileSessionSyncRequest {
  path: string;
  method?: string;
}

export interface ProfileSessionSyncResponse {
  status: number;
  bodyText?: string;
}

/**
 * The desktop main process keeps a cached UserDto for `auth:getState`.
 * Renderer profile writes go through the generic backend proxy, so the
 * successful response must refresh that cached dto or the next auth-state
 * refetch can replay the pre-edit login snapshot.
 */
export function extractViewerUserFromProfileMutation(
  request: ProfileSessionSyncRequest,
  response: ProfileSessionSyncResponse,
): UserDto | null {
  if (response.status < 200 || response.status >= 300) return null;
  if (response.bodyText === undefined || response.bodyText.length === 0) {
    return null;
  }

  const shape = profileMutationResponseShape(request);
  if (!shape) return null;

  const json = parseJson(response.bodyText);
  const candidate =
    shape === 'avatar-upload'
      ? objectUser(json)
      : json;
  const parsed = UserDtoSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

type ProfileMutationResponseShape = 'user-dto' | 'avatar-upload';

function profileMutationResponseShape(
  request: ProfileSessionSyncRequest,
): ProfileMutationResponseShape | null {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = pathnameOf(request.path);
  if (method === 'PATCH' && path === apiPaths.me) return 'user-dto';
  if (method === 'DELETE' && path === apiPaths.meAvatar) return 'user-dto';
  if (method === 'POST' && path === apiPaths.meAvatar) return 'avatar-upload';
  return null;
}

function pathnameOf(path: string): string {
  return new URL(path, 'http://silverhand.local').pathname;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function objectUser(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('user' in value)) {
    return null;
  }
  return (value as { user: unknown }).user;
}
