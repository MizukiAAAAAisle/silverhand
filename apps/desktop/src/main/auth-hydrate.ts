import type { UserDto } from "@silverhand/shared";
import { UserDtoSchema } from "@silverhand/shared";

/**
 * Three-arm classification of a `/api/me` validation attempt
 * against the persisted desktop session token.
 *
 *   - `valid`       — server returned 2xx + a parseable UserDto.
 *                     Promote to in-memory session + claim host.
 *   - `rejected`    — server returned 401 or 403. The token is
 *                     definitively bad; clear persisted blob +
 *                     daemon-host config.
 *   - `unreachable` — anything else: fetch threw (DNS / TLS /
 *                     ECONNREFUSED), 5xx, 404, 200 with malformed
 *                     body, etc. KEEP the persisted token; surface
 *                     a `backend_unreachable` gate to the renderer
 *                     and let the next `getAuthState` poll retry.
 *
 * Critically: only `rejected` is allowed to clear local state.
 * No other arm may unlink `session.bin` or remove the
 * daemon-host config.
 */
export type SessionValidationResult =
  | { kind: "valid"; user: UserDto }
  | { kind: "rejected" }
  | { kind: "unreachable"; message: string };

/**
 * Pure classifier — given the outcome of a `fetch('/api/me')`
 * (a normalized `{status, body}` for a delivered response or
 * a `throw` for a network failure), decide the SessionValidationResult
 * arm.
 *
 * Exported so the matrix is exhaustively testable without
 * spinning up `fetch` + `Response`. Called by the real
 * `validateUserSessionToken` wrapper in `index.ts`.
 */
export type MeFetchOutcome =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "throw"; error: unknown };

export function classifyMeFetchOutcome(outcome: MeFetchOutcome): SessionValidationResult {
  if (outcome.kind === "throw") {
    return { kind: "unreachable", message: errorMessage(outcome.error) };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { kind: "rejected" };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    // 5xx, 404, gateway timeouts, … server is reachable in the
    // TCP sense but its `/api/me` did not deliver a valid auth
    // verdict. Pessimistic-keep: do not clear local state on a
    // backend hiccup.
    return { kind: "unreachable", message: `HTTP ${outcome.status}` };
  }
  const parsed = UserDtoSchema.safeParse(outcome.body);
  if (!parsed.success) {
    // 200 with malformed body — server-side bug, not an auth
    // reject. Keep the token; this is closer to "server broken"
    // than "user signed out".
    return {
      kind: "unreachable",
      message: `invalid /api/me body: ${parsed.error.message}`,
    };
  }
  return { kind: "valid", user: parsed.data };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Outcome of `executeHydrate()` — wider than the previous
 * `Promise<boolean>` shell so callers can distinguish "no token
 * at all" from "validation deferred due to unreachable backend".
 *
 * `index.ts`'s wrapper still returns a boolean (was-authenticated)
 * for backward compatibility with the bootstrap call site, but
 * the renderer-facing `desktopAuthState()` keys off the wider
 * shape via direct calls into the executor (in practice it
 * inspects `loadPersistedUserSessionToken()` after the call —
 * see `index.ts`).
 */
export type HydrateOutcome = "no_token" | "authenticated" | "rejected" | "unreachable";

export interface HydrateDeps {
  /** Read the persisted session token from disk. */
  loadToken: () => string | null;
  /** Validate the token against the active backend. */
  validate: (token: string) => Promise<SessionValidationResult>;
  /** Promote a validated token+user into in-memory state and
   *  persist the cookie / blob. */
  store: (token: string, user: UserDto) => Promise<void>;
  /** Tear down in-memory + persisted state. ONLY called on the
   *  `rejected` arm. */
  clear: () => Promise<void>;
  /** Run the local-host claim flow against the newly-stored
   *  session. Only called on the `valid` arm. */
  claim: () => Promise<void>;
  /** Optional logger. Each method gets a structured object + msg. */
  log?: {
    info?: (obj: object, msg: string) => void;
    warn?: (obj: object, msg: string) => void;
  };
}

/**
 * The orchestrator. Pure in the sense that all side effects go
 * through `deps` — no `fetch`, no direct file I/O, no `unlinkSync`
 * appear here. The three-arm switch is the load-bearing invariant
 * (Cindy P1):
 *
 *   - valid       → store + claim. Return `authenticated`.
 *   - rejected    → clear. Return `rejected`.
 *   - unreachable → DO NOTHING. Persisted token + daemon-host
 *                   config stay on disk. Return `unreachable`.
 *
 * The fourth arm (`no_token`) handles the empty-disk case where
 * there's nothing to hydrate.
 *
 * Regression bait (pinned in tests): the `unreachable` arm MUST
 * NOT call `clear`. The whole point of this refactor is that a
 * transient outage at boot doesn't cost the user a re-login.
 */
export async function executeHydrate(deps: HydrateDeps): Promise<HydrateOutcome> {
  const token = deps.loadToken();
  if (!token) return "no_token";
  const result = await deps.validate(token);
  if (result.kind === "valid") {
    await deps.store(token, result.user);
    await deps.claim();
    return "authenticated";
  }
  if (result.kind === "rejected") {
    deps.log?.info?.(
      {},
      "persisted desktop session rejected by server (401/403); clearing local session",
    );
    await deps.clear();
    return "rejected";
  }
  // unreachable
  deps.log?.warn?.(
    { reason: result.message },
    "persisted desktop session validation deferred — backend unreachable; keeping token + daemon-host config",
  );
  return "unreachable";
}
