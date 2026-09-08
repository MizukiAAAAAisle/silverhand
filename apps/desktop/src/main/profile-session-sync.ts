import { apiPaths, UserDtoSchema, type UserDto } from "@silverhand/shared";

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
 * That cache is a SESSION snapshot (taken when the token was validated),
 * never the profile authority — the backend is. This extracts an
 * authoritative viewer DTO out of any proxied response that carries one,
 * so the snapshot cannot outlive the profile it describes:
 *
 *   - renderer profile writes (`PATCH /api/me`, avatar upload / clear) go
 *     through the generic backend proxy, so the successful response must
 *     refresh the cache or the next auth-state refetch replays the
 *     pre-edit login snapshot;
 *   - a fresh `GET /api/me` read carries the same authority. It is how a
 *     REMOTE edit (another machine changing this viewer's profile, which
 *     never touches this machine's mutation proxy — #task:1702) reaches
 *     the cache: the client re-reads `/api/me` on the `user_changed`
 *     signal, and that read reseats the snapshot on its way through.
 *     `GET /api/me` may instead return the `registration_required` shape;
 *     that fails `UserDtoSchema` and yields null, i.e. no reseat.
 */
export function extractViewerUserFromProxyResponse(
  request: ProfileSessionSyncRequest,
  response: ProfileSessionSyncResponse,
): UserDto | null {
  if (response.status < 200 || response.status >= 300) return null;
  if (response.bodyText === undefined || response.bodyText.length === 0) {
    return null;
  }

  const shape = viewerDtoResponseShape(request);
  if (!shape) return null;

  const json = parseJson(response.bodyText);
  const candidate = shape === "avatar-upload" ? objectUser(json) : json;
  const parsed = UserDtoSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

type ViewerDtoResponseShape = "user-dto" | "avatar-upload";

function viewerDtoResponseShape(request: ProfileSessionSyncRequest): ViewerDtoResponseShape | null {
  const method = (request.method ?? "GET").toUpperCase();
  const path = pathnameOf(request.path);
  if (method === "GET" && path === apiPaths.me) return "user-dto";
  if (method === "PATCH" && path === apiPaths.me) return "user-dto";
  if (method === "DELETE" && path === apiPaths.meAvatar) return "user-dto";
  if (method === "POST" && path === apiPaths.meAvatar) return "avatar-upload";
  return null;
}

function pathnameOf(path: string): string {
  return new URL(path, "http://silverhand.local").pathname;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function objectUser(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("user" in value)) {
    return null;
  }
  return (value as { user: unknown }).user;
}
