import type { UserDto } from "@silverhand/shared";
import type { SessionValidationResult } from "@silverhand/client";
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
