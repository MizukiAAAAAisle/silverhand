// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: user. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import { ParticipantNameSchema } from './name.js';

// Profile-only "human" identity. Auth/credentials live in a separate
// (V2-only) `user_auth_identities` table; this DTO is what the renderer
// reads via /api/me. `avatar_url` is a server-rendered URL (currently
// `silverhand-blob://<storage_key>`); the renderer never assembles
// storage keys directly.
export const UserDtoSchema = z.object({
  id: z.string(),
  /** Unique mention name. Decided once at registration and never editable
   *  after — surfaces in the renderer as `@<name>`. Globally unique
   *  across users.name ⊕ agents.name. */
  name: z.string(),
  display_name: z.string(),
  /** Resolved avatar URL or null. */
  avatar_url: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

export const UsersResponseSchema = z.object({
  users: z.array(UserDtoSchema),
});
export type UsersResponse = z.infer<typeof UsersResponseSchema>;

/**
 * Pre-authentication shape returned by `GET /api/me` when no user
 * session has been established yet. The renderer
 * branches on the discriminator and shows `<RegistrationGate>` rather
 * than mounting the AppShell.
 *
 * `suggested_name` is a server-rendered placeholder of shape
 * `user-<4hex>` — the renderer uses it as the input default so the form
 * is never empty on first paint. The user is free to overwrite.
 */
export const RegistrationRequiredSchema = z.object({
  registration_required: z.literal(true),
  suggested_name: z.string(),
});
export type RegistrationRequired = z.infer<typeof RegistrationRequiredSchema>;

/** Discriminated union returned by `GET /api/me`. */
export const MeResponseSchema = z.union([
  UserDtoSchema,
  RegistrationRequiredSchema,
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

// `display_name` is rendered into the agent system prompt (PR-B
// "Channel members:" block) and persisted on `users`
// and `agents`. Reject every character that could survive `.trim()`
// but be interpreted as a line break or non-printable control
// downstream:
//   - C0 controls       U+0000 – U+001F  (NUL, TAB, LF, CR, VT, FF, …)
//   - DEL               U+007F
//   - C1 controls       U+0080 – U+009F  (includes U+0085 NEL)
//   - Line separators   U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR
//
// `JSON.stringify` only escapes U+0000-U+001F; everything else above
// would land in the prompt verbatim. The `quotePromptValue` helper in
// platform-prompt.ts escapes the line-separator subset at render time
// as defense-in-depth, but blocking the full set at the write
// boundary keeps the DB clean and prevents future schema drift /
// direct-DB writes from leaking malicious values into the prompt.
// See @Cindy review threads on `d65cc19` and `d7680e5`. Other
// punctuation (`,` `:` `"`) is allowed: humans legitimately use these
// in display names (e.g. `"Alice (lead)"`, `"Bob, the bot"`) and the
// prompt's JSON-quoted form makes them unambiguous to the model.
const DISPLAY_NAME_FORBIDDEN_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/;
const DISPLAY_NAME_FORBIDDEN_MSG =
  'display_name must not contain control characters or Unicode line separators';

/**
 * Shared validator for any user-editable `display_name` field. Used by
 * `AuthSignupInputSchema`, `UpdateUserProfileInputSchema`, and
 * `UpdateAgentInputSchema`. Trim → 1..64 chars → reject control
 * characters (C0 U+0000–U+001F, DEL U+007F, C1 U+0080–U+009F) and
 * Unicode line separators (U+2028 / U+2029).
 */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(s => !DISPLAY_NAME_FORBIDDEN_RE.test(s), {
    message: DISPLAY_NAME_FORBIDDEN_MSG,
  });

const AuthEmailSchema = z.string().trim().email().max(320);

/**
 * `POST /auth/signup` body.
 *
 * `name` is the user's **immutable mention handle** and is REQUIRED (#task:1830).
 * It is not optional-with-a-server-fallback on purpose: the field can never be
 * changed afterwards (no rename path exists, and historical `@mentions` are
 * re-parsed out of stored message text at read time, so a rename would silently
 * re-point them), and a value that permanent must not be chosen by a
 * server-side guess at what an email local-part meant. `AuthSignupInput` has a
 * single production client shipped in lockstep with the backend, and signup sits
 * outside the desktop API-epoch gate, so there is no old-client population to
 * keep a second, weaker model alive for — the email deriver survives only as a
 * renderer PREFILL (`suggestParticipantNameFromEmail`).
 *
 * The wire keeps the domain word `name` (matching `UserDto.name` and
 * `agents.name`); "Handle" is the UI label for the same field, and the leading
 * `@` belongs to command input (`HandleSchema`), never to this value.
 *
 * `display_name` stays optional and independent: it is a mutable label, so a
 * server-side default costs nothing irreversible.
 */
export const AuthSignupInputSchema = z.object({
  email: AuthEmailSchema,
  password: z.string().min(8).max(1024),
  name: ParticipantNameSchema,
  display_name: DisplayNameSchema.optional(),
});
export type AuthSignupInput = z.infer<typeof AuthSignupInputSchema>;

/**
 * `POST /auth/signup` → 409 `{ error_code: 'handle_taken' }`: the requested
 * `name` already exists in the `users.name` ⊕ `agents.name` mention namespace.
 *
 * Deliberately distinguishable from the uniform 401 `auth_failed`, which exists
 * to hide CREDENTIAL facts (email exists / password wrong). A mention handle is
 * public by construction — its whole purpose is that other people type it — and
 * a user who cannot be told which of the two unique fields collided cannot
 * finish signing up at all. See `docs/auth-and-host-model.md` §3.4 for the
 * scoped anti-enumeration rule and the residual cost this accepts.
 */
export const AUTH_HANDLE_TAKEN_CODE = 'handle_taken';

export const AuthLoginInputSchema = z.object({
  email: AuthEmailSchema,
  password: z.string().min(1).max(1024),
});
export type AuthLoginInput = z.infer<typeof AuthLoginInputSchema>;

export const AuthSessionResponseSchema = z.object({
  user_token: z.string().min(1),
  user: UserDtoSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthLogoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

// PATCH /api/me — post-registration profile update. By design `name`
// is NOT in this schema: the registration boundary is the only public
// writer. Avatar is also separate (POST /api/me/avatar) so the renderer
// has a single binary upload path. Empty objects fail validation.
export const UpdateUserProfileInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateUserProfileInput = z.infer<typeof UpdateUserProfileInputSchema>;

// Response from POST /api/me/avatar. The renderer doesn't need the raw
// storage key; the URL is enough.
export const UploadAvatarResponseSchema = z.object({
  avatar_url: z.string(),
});
export type UploadAvatarResponse = z.infer<typeof UploadAvatarResponseSchema>;

/**
 * `user_changed` — WS event on the **`app`** scope, the human counterpart
 * of `agent_changed` (same shape, same scope, same "id only" payload), so
 * the two isomorphic actors propagate an identity change the same way.
 *
 * Coverage is every identity write that changes what the human directory
 * shows — both CREATION and UPDATE, each gated on the write actually
 * landing:
 *   - create: `UserService.register` (embedded first-boot) and
 *     `UserAuthService.signup` (standalone), published after the row's
 *     commit succeeds. A genuine first creation publishes exactly once; an
 *     already-registered / duplicate-email / rejected attempt writes no row
 *     and stays silent.
 *   - update: `PATCH /api/me` (display_name) and avatar upload / clear —
 *     every `UserService` profile write after the row exists. `name` is
 *     immutable after registration, so it never triggers this, and a no-op
 *     profile write publishes nothing.
 * `agent_changed` has the same create+update producer boundary. On the
 * consumer side the renderer's subject-kind carrier registry routes "the
 * directory grew" (create) and "an entry changed" (update) through one
 * invalidation path, so both converge identically (#task:1707).
 *
 * Clients treat it as an INVALIDATION SIGNAL ONLY and re-read the existing
 * authorities — the global human directory (`GET /api/users`), the
 * conversation rosters that denormalize `display_name` / `avatar_url`, and
 * `GET /api/me` when `user_id` is the viewer's own id. The payload is never
 * a second copy of the profile: it carries no profile fields at all, so
 * there is nothing for a client to patch from. A refetched DTO carries the
 * bumped `avatar_url` `?v=<updated_at>` cache-buster, which is what makes
 * an avatar REPLACEMENT (same URL path, new bytes) converge.
 *
 * Scope safety: `app` reaches every authenticated viewer, which is exactly
 * the audience of the reads it invalidates — `GET /api/users` returns the
 * full human directory to any registered viewer and any viewer may fetch
 * any user's avatar (no hidden-profile concept in V1). Publishing a bare
 * user id there discloses nothing the directory does not already list.
 * That equality is the whole justification: if the human directory ever
 * becomes workspace-scoped or profile visibility becomes graded, this
 * publish turns over-broad and must narrow to the workspace / viewer
 * scopes at the same time.
 */
export const UserChangedEventSchema = z.object({
  user_id: z.string(),
});
export type UserChangedEvent = z.infer<typeof UserChangedEventSchema>;
