import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { friendlyDeleteAgentError } from "./delete-agent-error";

describe("friendlyDeleteAgentError", () => {
  const attachPending = new ApiError(
    503,
    "Service Unavailable",
    JSON.stringify({
      error: "host runtime is not currently attached",
      code: "host_attach_pending",
    }),
  );
  const unknownCode = new ApiError(
    409,
    "Conflict",
    JSON.stringify({
      error: "delete conflict",
      code: "agent_delete_conflict",
    }),
  );

  it("maps a typed code (host_attach_pending) to a tailored message, not the raw detail", () => {
    const msg = friendlyDeleteAgentError(attachPending);
    // Typed code wins: a non-empty tailored message that does NOT leak the
    // raw backend detail/code. (Exact wording is copy, verified visually.)
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("host_attach_pending");
    expect(msg).not.toContain("host runtime is not currently attached");
  });

  it("keeps unknown backend codes visible (detail + code preserved)", () => {
    const msg = friendlyDeleteAgentError(unknownCode);
    expect(msg).toContain("delete conflict");
    expect(msg).toContain("agent_delete_conflict");
  });

  it("a typed code and an unknown code resolve to distinct messages", () => {
    expect(friendlyDeleteAgentError(attachPending)).not.toBe(friendlyDeleteAgentError(unknownCode));
  });
});
