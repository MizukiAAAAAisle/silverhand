// Viewer profile surface: GET /api/users (human roster), GET /api/me (resolved
// viewer or registration_required shape), PATCH /api/me (display_name only),
// POST/DELETE /api/me/avatar (upload / clear), and the public-by-id avatar
// fetch GET /api/users/:id/avatar. All handlers delegate to ctx.userService —
// the avatar write path's blob put / DB-pointer / previous-blob cleanup /
// orphan-on-race coordination is encapsulated inside UserService. The
// userService error→HTTP mapper trio is module-private because only these
// routes use it.
//
// Boundary contract (unchanged):
//   - `/auth/signup` is the public credentialed creator of users.
//   - `/auth/embedded-bootstrap` may create a profile-only local user
//     in embedded mode before issuing a normal session bearer.
//   - PATCH /api/me only accepts `display_name`. Renaming is not
//     exposed at any service / route surface.
//   - Avatar lives on its own routes (POST/DELETE /api/me/avatar).
import { Hono } from 'hono';
import { apiPaths, UpdateUserProfileInputSchema } from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { requireViewerUserId } from '../auth/principal.js';
import { UserServiceError } from '../services/user-service.js';

export interface UsersRouteDeps {
  ctx: BackendContext;
}

const userServiceErrorStatusMap: Partial<
  Record<UserServiceError['code'], 400 | 404 | 409 | 413 | 415>
> = {
  user_not_found: 404,
  name_taken: 409,
  already_registered: 409,
  invalid_input: 400,
  avatar_missing: 400,
  avatar_too_large: 413,
  avatar_unsupported_type: 415,
  avatar_storage_failed: 400,
};

function userServiceErrorStatus(err: unknown): 400 | 404 | 409 | 413 | 415 | null {
  if (err instanceof UserServiceError) {
    return userServiceErrorStatusMap[err.code] ?? 400;
  }
  return null;
}

function userServiceErrorBody(err: unknown): { error: string; code: string } {
  if (err instanceof UserServiceError) {
    return { error: err.message, code: err.code };
  }
  return { error: String(err), code: 'unknown_error' };
}

export function createUsersApp(deps: UsersRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx } = deps;

  // ── Current viewer (user profile) ────────────────────────────────
  app.get(apiPaths.users, c => {
    return c.json({ users: ctx.userService.listDtos() });
  });

  app.get(apiPaths.relatedUsers, c => {
    return c.json({ users: ctx.userService.listRelatedDtos(requireViewerUserId(c)) });
  });

  app.get(apiPaths.me, c => {
    // Kept defensive for tests or future setup allowlists. Normal C.6+
    // public API traffic reaches this route with a session principal.
    const principal = c.get('principal');
    if (!principal || principal.kind !== 'user') {
      return c.json({
        registration_required: true,
        suggested_name: ctx.userService.suggestRegistrationName(),
      });
    }
    const dto = ctx.userService.getDto(principal.userId);
    if (!dto) {
      // Principal middleware just validated this; corruption only.
      return c.json({ error: 'viewer user is missing post-validation' }, 500);
    }
    return c.json(dto);
  });

  app.patch(apiPaths.me, async c => {
    const viewerUserId = requireViewerUserId(c);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateUserProfileInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.errors[0]?.message ?? 'invalid input' },
        400,
      );
    }
    try {
      const dto = ctx.userService.updateProfile(viewerUserId, parsed.data);
      return c.json(dto);
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  app.post(apiPaths.meAvatar, async c => {
    const viewerUserId = requireViewerUserId(c);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const dto = await ctx.userService.uploadAvatar(viewerUserId, {
        buffer,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'avatar',
      });
      return c.json({ avatar_url: dto.avatar_url, user: dto });
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  app.delete(apiPaths.meAvatar, async c => {
    const viewerUserId = requireViewerUserId(c);
    try {
      const dto = await ctx.userService.clearAvatar(viewerUserId);
      return c.json(dto);
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  // Public-by-id avatar fetch. The renderer never assembles storage
  // keys; it just GETs this URL with the standard auth headers and
  // turns the bytes into an object URL (mirrors the attachment
  // download pattern). Any logged-in viewer can fetch any user's
  // avatar — there is no hidden-profile concept in V1.
  app.get(apiPaths.userAvatar(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'user id required' }, 400);
    const ref = ctx.userService.getAvatarStorageRef(id);
    if (!ref) return c.json({ error: 'avatar not found' }, 404);
    return ctx.blobStorage.serve(
      { storage: ctx.blobStorage.kind, storageKey: ref.storageKey },
      { contentType: ref.contentType, filename: ref.filename },
    );
  });

  return app;
}
