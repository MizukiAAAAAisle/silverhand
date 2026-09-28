import { describe, expect, it } from "vitest";
import { classifyMeFetchOutcome, SessionGeneration } from "../src/index";

describe("client session boundary", () => {
  it("invalidates outstanding work even if the same server/account is selected again", () => {
    const session = new SessionGeneration();
    const first = session.capture();
    expect(first()).toBe(true);
    session.invalidate();
    const next = session.capture();
    expect(first()).toBe(false);
    expect(next()).toBe(true);
    session.invalidate();
    expect(first()).toBe(false);
    expect(next()).toBe(false);
  });

  it("preserves credentials on outages and malformed responses; only auth rejection clears", () => {
    for (const status of [404, 500, 503]) {
      expect(classifyMeFetchOutcome({ kind: "response", status, body: null }).kind).toBe(
        "unreachable",
      );
    }
    expect(classifyMeFetchOutcome({ kind: "response", status: 200, body: {} }).kind).toBe(
      "unreachable",
    );
    for (const status of [401, 403]) {
      expect(classifyMeFetchOutcome({ kind: "response", status, body: null }).kind).toBe(
        "rejected",
      );
    }
  });
});
