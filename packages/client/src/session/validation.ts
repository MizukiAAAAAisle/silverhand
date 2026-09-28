import type { UserDto } from "@silverhand/shared";
import { UserDtoSchema } from "@silverhand/shared";

/**
 * Three-arm classification of a `/api/me` validation attempt
 * against the persisted client session token.
 *
 *   - `valid`       — server returned 2xx + a parseable UserDto.
 *                     Promote to the application session.
 *   - `rejected`    — server returned 401 or 403. The token is
 *                     definitively bad; clear persisted credentials.
 *   - `unreachable` — anything else: fetch threw (DNS / TLS /
 *                     ECONNREFUSED), 5xx, 404, 200 with malformed
 *                     body, etc. KEEP the persisted token; surface
 *                     a `backend_unreachable` gate to the renderer
 *                     and let the next `getAuthState` poll retry.
 *
 * Critically: only `rejected` is allowed to clear local credentials.
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
