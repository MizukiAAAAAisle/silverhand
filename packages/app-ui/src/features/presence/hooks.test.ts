import { describe, expect, it } from "vitest";
import type { PresenceResponse, ServerFrame, UserPresenceDto } from "@silverhand/shared";
import {
  decidePresenceFrameAction,
  humanPresenceText,
  presenceDotStatus,
  upsertPresence,
} from "./hooks";

function dto(
  user_id: string,
  presence: UserPresenceDto["presence"],
  last_seen_at: number | null = null,
): UserPresenceDto {
  return { user_id, presence, last_seen_at };
}

describe("upsertPresence", () => {
  it("seeds a fresh snapshot when no prior cache exists", () => {
    const next = upsertPresence(undefined, dto("u1", "online"));
    expect(next.users).toEqual([dto("u1", "online")]);
  });

  it("replaces an existing user in place, preserving order", () => {
    const prev: PresenceResponse = {
      users: [dto("u1", "online"), dto("u2", "online"), dto("u3", "offline", 100)],
    };
    const next = upsertPresence(prev, dto("u2", "offline", 500));
    // u2 flips to offline but keeps its slot; u1/u3 untouched.
    expect(next.users.map((u) => u.user_id)).toEqual(["u1", "u2", "u3"]);
    expect(next.users[1]).toEqual(dto("u2", "offline", 500));
    expect(next.users[0]).toBe(prev.users[0]);
  });

  it("appends an unknown user", () => {
    const prev: PresenceResponse = { users: [dto("u1", "online")] };
    const next = upsertPresence(prev, dto("u2", "online"));
    expect(next.users.map((u) => u.user_id)).toEqual(["u1", "u2"]);
  });

  it("does not mutate the previous snapshot", () => {
    const prev: PresenceResponse = { users: [dto("u1", "online")] };
    upsertPresence(prev, dto("u1", "offline", 9));
    expect(prev.users[0]).toEqual(dto("u1", "online"));
  });
});

describe("presenceDotStatus", () => {
  it("maps online → active (filled dot)", () => {
    expect(presenceDotStatus("online")).toBe("active");
  });

  it("maps offline → idle (muted dot)", () => {
    expect(presenceDotStatus("offline")).toBe("idle");
  });

  it("treats unknown (undefined) presence as idle", () => {
    expect(presenceDotStatus(undefined)).toBe("idle");
  });
});

describe("decidePresenceFrameAction", () => {
  const evt = (scope: string, kind: string, payload: unknown): ServerFrame =>
    ({ type: "event", scope, seq: 1, epoch: "e", kind, payload }) as ServerFrame;

  it("upserts a valid app-scope user_presence event", () => {
    const action = decidePresenceFrameAction(evt("app", "user_presence", dto("u1", "online")));
    expect(action).toEqual({ kind: "upsert", delta: dto("u1", "online") });
  });

  it("ignores user_presence on a non-app scope", () => {
    expect(
      decidePresenceFrameAction(evt("workspace:w1", "user_presence", dto("u1", "online"))),
    ).toBeNull();
  });

  it("ignores a different event kind on app scope", () => {
    expect(decidePresenceFrameAction(evt("app", "unread_updated", { foo: 1 }))).toBeNull();
  });

  it("ignores a malformed user_presence payload", () => {
    expect(decidePresenceFrameAction(evt("app", "user_presence", { user_id: 5 }))).toBeNull();
  });

  it("invalidates on app-scope snapshot_required (backend restart / replay gap)", () => {
    const frame = {
      type: "snapshot_required",
      scope: "app",
      reason: "epoch_mismatch",
    } as ServerFrame;
    expect(decidePresenceFrameAction(frame)).toEqual({ kind: "invalidate" });
  });

  it("ignores snapshot_required on a non-app scope", () => {
    const frame = {
      type: "snapshot_required",
      scope: "conversation:c1",
      reason: "gap_too_large",
    } as ServerFrame;
    expect(decidePresenceFrameAction(frame)).toBeNull();
  });

  it("ignores transport frames (ping)", () => {
    expect(decidePresenceFrameAction({ type: "ping" } as ServerFrame)).toBeNull();
  });
});

describe("humanPresenceText", () => {
  it('reads "Online" when online, ignoring last_seen_at', () => {
    expect(humanPresenceText("online", 123, "2 minutes ago")).toBe("Online");
  });

  it('reads "Last seen X ago" when offline with a recorded last_seen', () => {
    expect(humanPresenceText("offline", 123, "5 minutes ago")).toBe("Last seen 5 minutes ago");
  });

  it('reads "Offline" when offline with no recorded last_seen', () => {
    expect(humanPresenceText("offline", null, "")).toBe("Offline");
  });

  it('treats unknown (undefined) presence with no last_seen as "Offline"', () => {
    expect(humanPresenceText(undefined, null, "")).toBe("Offline");
  });

  it('treats unknown presence with a last_seen as "Last seen X ago"', () => {
    expect(humanPresenceText(undefined, 999, "an hour ago")).toBe("Last seen an hour ago");
  });
});
