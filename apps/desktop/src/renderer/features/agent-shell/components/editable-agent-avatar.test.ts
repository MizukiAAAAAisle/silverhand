import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { formatAvatarMutationError } from "./editable-agent-avatar";

/**
 * Cindy PR-3 review #2 — error mapping must cover both PR-2 service
 * codes AND cross-cutting HTTP states (403/404/etc.) so a stale
 * `created_by_user_id` cache or a deleted-underfoot agent never
 * surfaces as a generic toast. Each branch of `formatAvatarMutationError`
 * is asserted independently here.
 */

function apiErrorWith(status: number, body: string): ApiError {
  return new ApiError(status, "", body);
}

describe("formatAvatarMutationError", () => {
  const SERVICE_CODES = [
    { status: 413, code: "avatar_too_large" },
    { status: 415, code: "avatar_unsupported_type" },
    { status: 400, code: "avatar_missing" },
    { status: 400, code: "avatar_storage_failed" },
  ] as const;

  it("maps each service code to its own non-empty message (typed-code branch)", () => {
    const messages = SERVICE_CODES.map(({ status, code }) =>
      formatAvatarMutationError(apiErrorWith(status, JSON.stringify({ error: "...", code }))),
    );
    // Every code resolves to a non-empty tailored message (copy is visual)...
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
    // ...and they are all distinct — no two codes collapse to one line.
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("renders distinct permission (403) and deleted (404) lines from the status branch", () => {
    // Backend's PATCH/avatar 403 path returns `{ error: 'forbidden' }` with no
    // `code`; 404 means agent_not_found. Both fall through to the status-based
    // branch and must produce distinct, non-empty guidance.
    const forbidden = formatAvatarMutationError(
      apiErrorWith(403, JSON.stringify({ error: "forbidden" })),
    );
    const notFound = formatAvatarMutationError(apiErrorWith(404, ""));
    expect(forbidden.length).toBeGreaterThan(0);
    expect(notFound.length).toBeGreaterThan(0);
    expect(forbidden).not.toBe(notFound);
  });

  it("preserves the status in the generic HTTP fallback for unmapped statuses", () => {
    expect(formatAvatarMutationError(apiErrorWith(500, ""))).toContain("500");
  });

  it("falls back to a non-empty generic message for non-ApiError throwables", () => {
    expect(formatAvatarMutationError(new Error("network down")).length).toBeGreaterThan(0);
    expect(formatAvatarMutationError("plain string").length).toBeGreaterThan(0);
  });

  it("prefers the service code over the status line when both are present", () => {
    // Belt-and-suspenders: even when a 4xx also carries a status, the localized
    // service-code message wins. Proven by inequality with the status-only
    // rendering of the same HTTP code — not by pinning the sentence.
    const both = formatAvatarMutationError(
      apiErrorWith(413, JSON.stringify({ error: "...", code: "avatar_too_large" })),
    );
    const statusOnly = formatAvatarMutationError(apiErrorWith(413, ""));
    expect(both).not.toBe(statusOnly);
  });
});
