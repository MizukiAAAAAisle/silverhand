import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { createTaskErrorMessage } from "./create-task-error";

/**
 * `createTaskErrorMessage` is a cross-layer error CONTRACT (not UI structure): it
 * maps a create rejection to one of three message classes strictly off the typed
 * `code` discriminant. These assertions are written relationally — same-class /
 * different-class — so they lock the classification without pinning the exact
 * copy, and `GENERIC` is anchored to a non-ApiError input rather than a literal.
 */
const err = (code: string): ApiError =>
  new ApiError(409, "Conflict", JSON.stringify({ success: false, code }));

// A plain (non-ApiError) rejection can only ever be the generic fallback, so it
// anchors "generic" without hard-coding the string.
const GENERIC = createTaskErrorMessage(new Error("boom"));

describe("createTaskErrorMessage", () => {
  it("reads closed and archived as one message (channel refuses new tasks)", () => {
    const closed = createTaskErrorMessage(err("conversation_closed"));
    const archived = createTaskErrorMessage(err("conversation_archived"));
    expect(closed).toBe(archived);
    expect(closed).not.toBe(GENERIC);
  });

  it("reads not-member and not-found as one message (existence never leaks)", () => {
    const notMember = createTaskErrorMessage(err("not_conversation_member"));
    const notFound = createTaskErrorMessage(err("conversation_not_found"));
    expect(notMember).toBe(notFound);
    expect(notMember).not.toBe(GENERIC);
  });

  it("keeps the closed and unavailable classes distinct", () => {
    expect(createTaskErrorMessage(err("conversation_closed"))).not.toBe(
      createTaskErrorMessage(err("not_conversation_member")),
    );
  });

  it("falls back to generic for a validation envelope / unknown code", () => {
    expect(createTaskErrorMessage(err("some_unmodelled_code"))).toBe(GENERIC);
    expect(
      createTaskErrorMessage(
        new ApiError(400, "Bad Request", JSON.stringify({ error: "title required" })),
      ),
    ).toBe(GENERIC);
  });

  it("falls back to generic for an unreachable backend", () => {
    expect(createTaskErrorMessage(new ApiError(0, "", "", "backend_unreachable"))).toBe(GENERIC);
  });

  it("falls back to generic for a malformed body", () => {
    expect(createTaskErrorMessage(new ApiError(500, "Server Error", "<html>502</html>"))).toBe(
      GENERIC,
    );
    expect(createTaskErrorMessage(new ApiError(500, "Server Error", ""))).toBe(GENERIC);
  });

  it("never parses the free-text `reason`: a reason-only body is generic", () => {
    // The body names a real domain state in `reason` but carries NO typed `code`.
    // Classifying it off `reason` would resurrect a fragile free-text contract, so
    // it MUST land in the generic class — never the specific "closed" copy.
    const reasonOnly = new ApiError(
      409,
      "Conflict",
      JSON.stringify({ success: false, reason: "conversation_closed" }),
    );
    expect(createTaskErrorMessage(reasonOnly)).toBe(GENERIC);
  });
});
